"""Fast product -> recall matching for the extension (/v2/match) and the B2B catalog upload.

Stage 1 (Tiger only, no LLM): the recall index (rh.recall_index + rh.recalls, ~80 rows) is held in memory and
refreshed every 5 min; one batched pg_textsearch BM25 query scores every uncached title. Signals:
  strong  = a digit-bearing model number / UPC from the recall appears in the title or model/upc field
  brand   = the recall's brand appears in the title (word boundary) or equals the card's brand, AND the title shares a
            product word with the recall's name/category (or names a recalled model line like "Chambord")
  category= no brand/model, but the whole category phrase is in the title and BM25 is high (weak: background only)
Stage 2 (Gemini Flash-Lite, structured, <=5 candidates in one call): strong/brand candidates are confirmed inline
within a ~1.5 s budget; if slower they are returned `possible` and finished in a background task that updates the
cache. Category-only candidates are always confirmed in the background and can at most become `possible`.
Embeddings are not used in the hot path (one Gemini call per batch costs ~300+ ms; BM25 is ~40 ms)."""
import asyncio
import hashlib
import re
import time
import unicodedata
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .. import db, obs
from ..config import M_SCREEN, M_VISION
from ..gemini import funnel

CACHE_DAYS = 7
STAGE2_BUDGET_S = 1.5
MAX_SYNC_CANDIDATES = 5
MAX_BG_CANDIDATES = 10
INDEX_TTL_S = 300
BM25_CATEGORY_MIN = 14.0   # |bm25 score| needed for a category-only candidate

_STOP = set("""a an and or the of for with in on to by from at as is are new used set sets kit pack pcs pc piece pieces
toy toys kids kid children childrens child baby babies adult adults women men mens womens product products item items
brand branded model models series edition style type size inch inches oz cup cups l ml black white blue red green pink
gray grey large small mini big one two three 1 2 3 4 5 6 7 8 9 10 x""".split())

# ---------------------------------------------------------------- recall index (in memory)
_idx: dict = {"at": 0.0, "rows": [], "by_id": {}}


def invalidate_index():
    _idx["at"] = 0.0


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9&]+", " ", s.lower()).strip()


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w


def _words(s: str) -> set[str]:
    return {_stem(w) for w in _fold(s).split() if len(w) > 2 and w not in _STOP}


def _compact(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _load_index_sync() -> list[dict]:
    rows = db.q("""SELECT i.recall_id, i.brand, i.norm_name, i.category, i.models, i.upcs,
                          r.recall_number, r.title, r.product_name, r.hazard, r.hazard_class, r.remedy, r.url,
                          r.recall_date, r.units, r.image_urls, r.models AS models_raw, r.description, r.is_child
                   FROM rh.recall_index i JOIN rh.recalls r USING (recall_id)""")
    for r in rows:
        b = _fold(r["brand"] or "")
        r["_brand"] = b if len(b.replace(" ", "")) >= 3 else ""
        r["_brand_re"] = re.compile(r"(?<![a-z0-9])" + re.escape(b) + r"(?:s|'s)?(?![a-z0-9])") if r["_brand"] else None
        cb = _compact(b)
        r["_brand_c"] = cb if len(cb) >= 6 else ""  # catches run-together titles ("MagnetopiaMagnetic ...")
        brand_words = set(b.split())
        r["_words"] = (_words(r["norm_name"] or "") | _words(r["category"] or "")) - brand_words
        r["_cat_words"] = _words(r["category"] or "")
        strong, alpha = [], []
        for m in r["models"] or []:
            c = _compact(m)
            if not c:
                continue
            has_digit = bool(re.search(r"\d", c))
            if has_digit and (len(c) >= 5 if not c.isdigit() else len(c) >= 6):
                strong.append((m.upper(), c))
            elif not has_digit and len(c) >= 4:
                alpha.append(_fold(m))
            elif has_digit and len(c) >= 4:
                alpha.append(_fold(m))  # short codes (HT-10, 6502) only count together with the brand
        r["_strong"] = strong
        r["_alpha"] = [(a, re.compile(r"(?<![a-z0-9])" + re.escape(a) + r"(?![a-z0-9])")) for a in alpha if a]
        r["_upcs"] = [u for u in (r["upcs"] or []) if u]
    return rows


async def _index() -> list[dict]:
    if time.time() - _idx["at"] > INDEX_TTL_S or not _idx["rows"]:
        rows = await asyncio.to_thread(_load_index_sync)
        _idx.update(at=time.time(), rows=rows, by_id={r["recall_id"]: r for r in rows})
    return _idx["rows"]


def recall_card(r: dict | None) -> dict | None:
    if not r:
        return None
    imgs = r.get("image_urls") or []
    return {"recall_id": r["recall_id"], "recall_number": r.get("recall_number"), "title": r.get("title"),
            "product_name": r.get("product_name"), "hazard": r.get("hazard"), "hazard_class": r.get("hazard_class"),
            "remedy": r.get("remedy"), "url": r.get("url"),
            "recall_date": r["recall_date"].isoformat() if r.get("recall_date") else None,
            "units": r.get("units"), "image": imgs[0] if imgs else None, "is_child": bool(r.get("is_child"))}


# ---------------------------------------------------------------- stage 1
def _signals(p: dict, r: dict, bm25: float) -> Optional[dict]:
    title = p.get("title") or ""
    ftitle = _fold(title + " " + (p.get("brand") or ""))
    utitle = title.upper() + " " + (p.get("model") or "").upper()
    ctitle = _compact(utitle)
    pmodel = _compact(p.get("model") or "")
    pupc = re.sub(r"\D", "", p.get("upc") or "")

    # (a) exact model / UPC
    for m, c in r["_strong"]:
        if (pmodel and pmodel == c) or re.search(r"(?<![A-Z0-9])" + re.escape(m) + r"(?![A-Z0-9])", utitle) \
                or (len(c) >= 6 and c in ctitle):
            return {"kind": "strong", "score": 100 + bm25, "why": f"model {m} matches"}
    for u in r["_upcs"]:
        if (pupc and pupc.lstrip("0") == u.lstrip("0")) or u in re.sub(r"\D", " ", title).split():
            return {"kind": "strong", "score": 100 + bm25, "why": f"UPC {u} matches"}

    # (b) brand + overlap
    brand_hit = False
    if r["_brand_re"] is not None:
        brand_hit = bool(r["_brand_re"].search(ftitle)) or (_fold(p.get("brand") or "") == r["_brand"]) \
            or bool(r["_brand_c"] and r["_brand_c"] in ctitle)
    if brand_hit:
        alpha = next((a for a, rx in r["_alpha"] if rx.search(ftitle)), None)
        overlap = _words(title) & r["_words"]
        if alpha or overlap:
            what = f"model line '{alpha}'" if alpha else "'" + " ".join(sorted(overlap)[:3]) + "'"
            return {"kind": "brand", "score": 50 + (10 if alpha else 0) + bm25,
                    "why": f"brand '{r['brand']}' + {what} match"}
        return None

    # (c) weak: a named model line without the brand ("Chambord coffee maker") or the full category phrase + high BM25
    alpha = next((a for a, rx in r["_alpha"] if len(a) >= 6 and rx.search(ftitle)), None)
    if alpha and _words(title) & r["_words"]:
        return {"kind": "category", "score": 20 + bm25, "why": f"model line '{alpha}' without brand"}
    if r["_cat_words"] and r["_cat_words"] <= _words(title) and bm25 >= BM25_CATEGORY_MIN:
        return {"kind": "category", "score": bm25, "why": f"category '{r['category']}' similar (no brand/model match)"}
    return None


def _bm25_sync(titles: list[str]) -> dict[int, dict[int, float]]:
    rows = db.q("""SELECT t.i, x.recall_id, x.s FROM unnest(%s::text[]) WITH ORDINALITY AS t(title, i)
                   CROSS JOIN LATERAL (SELECT recall_id, keywords <@> to_bm25query(t.title, 'rh.recall_index_kw_bm25') AS s
                                       FROM rh.recall_index ORDER BY 2 LIMIT 5) x""", (titles,))
    out: dict[int, dict[int, float]] = {}
    for r in rows:
        out.setdefault(int(r["i"]) - 1, {})[r["recall_id"]] = -float(r["s"] or 0.0)  # positive = better
    return out


async def stage1(products: list[dict]) -> list[Optional[dict]]:
    """Returns per product the best candidate {recall, kind, score, why} or None (clean)."""
    rows = await _index()
    titles = [((p.get("title") or "") + " " + (p.get("brand") or "") + " " + (p.get("model") or "")).strip()[:500]
              for p in products]
    bm = await asyncio.to_thread(_bm25_sync, titles) if titles else {}
    out = []
    for i, p in enumerate(products):
        best = None
        scores = bm.get(i, {})
        for r in rows:
            s = _signals(p, r, scores.get(r["recall_id"], 0.0))
            if s and (best is None or s["score"] > best["score"]):
                best = {**s, "recall": r}
        out.append(best)
    return out


# ---------------------------------------------------------------- stage 2
Category = Literal["exact_recalled_model", "likely_variant", "different_product", "accessory_or_part", "insufficient_info"]


class S2Item(BaseModel):
    idx: int
    category: Category
    confidence: float = Field(description="0-1 confidence in the category")
    reason: str = Field(description="under 25 words, cite the decisive brand/model evidence")


class S2Out(BaseModel):
    results: list[S2Item]


def _recall_brief(r: dict) -> str:
    return (f"CPSC recall #{r.get('recall_number')} ({r.get('recall_date')}): {r.get('title')}\n"
            f"  Brand: {r.get('brand') or 'n/a'} | Product: {r.get('product_name')}\n"
            f"  Models/codes: {(r.get('models_raw') or ', '.join(r.get('models') or []) or 'n/a')[:500]}\n"
            f"  Description: {(r.get('description') or '')[:600]}")


_S2_RULES = (
    "You decide whether a product card on an online store is a product recalled by the US CPSC. For EACH pair return "
    "one result with its idx. Categories: exact_recalled_model = same brand and same model/product as the recall; "
    "likely_variant = same brand and product line, plausibly the recalled item but model/size not verifiable from the "
    "title; different_product = another brand, another product type, or a model/size the recall excludes; "
    "accessory_or_part = a part/accessory for the product, not the product itself; insufficient_info = cannot tell. "
    "Be strict: a generic or unbranded item of the same category (e.g. any 'magnetic blocks' vs a branded magnetic "
    "cube recall) is different_product unless the title shows the recalled brand, a recalled model number, or a "
    "unique product name. Never infer a brand that is not written on the card.")


async def _stage2_call(pairs: list[tuple[dict, dict]]) -> dict[int, dict]:
    lines = []
    for i, (p, c) in enumerate(pairs):
        lines.append(f"[{i}] STORE CARD: title={p.get('title')!r} brand={p.get('brand') or ''!r} "
                     f"model={p.get('model') or ''!r} price={p.get('price') or ''!r}\n{_recall_brief(c['recall'])}")
    prompt = _S2_RULES + "\n\nPAIRS:\n" + "\n\n".join(lines)
    last = None
    for model in (M_SCREEN, "gemini-4-hydrogen", M_VISION):
        try:
            data, _ = await funnel._gen(model, "v2_match_stage2", prompt, S2Out, records=len(pairs),
                                        sample_extra={"n": len(pairs), "first": (pairs[0][0].get("title") or "")[:60]},
                                        thinking="minimal" if model == M_SCREEN else "low")
            return {int(x["idx"]): x for x in data.get("results") or []}
        except Exception as e:
            last = e
            obs.capture(e)
    raise last or RuntimeError("stage2 unavailable")


def _status_from(cand: dict, v: dict) -> tuple[str, float, str]:
    cat = v.get("category")
    conf = max(0.0, min(1.0, float(v.get("confidence") or 0.0)))
    reason = (v.get("reason") or "")[:300]
    if cand["kind"] == "category":  # no brand/model evidence: never `recalled`
        if cat == "exact_recalled_model" and conf >= 0.8:
            return "possible", round(min(conf, 0.7), 3), reason
        return "clean", 0.0, reason
    if cat in ("exact_recalled_model", "likely_variant"):
        return ("recalled" if conf >= 0.8 else "possible"), round(conf, 3), reason
    if cat == "insufficient_info":
        return "possible", round(min(conf, 0.6), 3), reason
    return "clean", 0.0, reason  # different_product / accessory_or_part


_bg: set[asyncio.Task] = set()
_inflight: set[tuple[str, str]] = set()


def _spawn(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return t


async def drain(timeout: float = 60.0):
    """Wait for background stage-2 / cache writes (used by tests and on shutdown)."""
    end = time.time() + timeout
    while _bg and time.time() < end:
        await asyncio.wait(list(_bg), timeout=max(0.1, end - time.time()))


async def _confirm_chunk(site: str, chunk: list[tuple[str, dict, dict]]) -> dict[str, dict]:
    """chunk: [(pid, product, candidate)] judged in ONE Gemini call; writes the cache. Returns pid -> result."""
    out: dict[str, dict] = {}
    try:
        try:
            res = await _stage2_call([(p, c) for _, p, c in chunk])
        except Exception as e:
            print(f"[v2.match] stage2 error: {str(e)[:200]}")
            return out  # leave uncached; the next request retries
        rows = []
        for i, (pid, p, c) in enumerate(chunk):
            v = res.get(i)
            if not v:
                continue
            status, conf, reason = _status_from(c, v)
            rid = c["recall"]["recall_id"] if status != "clean" else None
            reason = f"{v.get('category')}: {reason}" + ("" if status != "clean" else f" (stage-1: {c['why']})")
            out[pid] = {"product_id": pid, "status": status, "recall": recall_card(c["recall"]) if rid else None,
                        "confidence": conf, "reason": reason[:400], "stage": 2}
            rows.append((site, pid, status, rid, conf, reason[:400], 2, (p.get("title") or "")[:500]))
        if rows:
            await asyncio.to_thread(_write_verdicts, rows)
    finally:
        for pid, _, _ in chunk:
            _inflight.discard((site, pid))
    return out


def _confirm(site: str, items: list[tuple[str, dict, dict]], chunk: int) -> list[asyncio.Task]:
    for pid, _, _ in items:
        _inflight.add((site, pid))
    return [_spawn(_confirm_chunk(site, items[k:k + chunk])) for k in range(0, len(items), chunk)]


# ---------------------------------------------------------------- cache / logging
def _write_verdicts(rows: list[tuple]):
    with db.cursor() as cur:
        cur.executemany(
            """INSERT INTO rh.product_verdicts(site, product_id, status, recall_id, confidence, reason, stage, title, checked_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (site, product_id) DO UPDATE SET status=EXCLUDED.status, recall_id=EXCLUDED.recall_id,
                 confidence=EXCLUDED.confidence, reason=EXCLUDED.reason, stage=EXCLUDED.stage, title=EXCLUDED.title,
                 checked_at=now()""", rows)


def _cache_sync(site: str, pids: list[str]) -> dict[str, dict]:
    rows = db.q(f"""SELECT product_id, status, recall_id, confidence, reason, stage FROM rh.product_verdicts
                    WHERE site=%s AND product_id = ANY(%s) AND checked_at > now() - interval '{CACHE_DAYS} days'""",
                (site, pids))
    return {r["product_id"]: r for r in rows}


def _log_request(site, n, flagged, ms, hits):
    try:
        db.execute("INSERT INTO rh.match_requests(site, n_products, n_flagged, latency_ms, cache_hits) VALUES (%s,%s,%s,%s,%s)",
                   (site, n, flagged, ms, hits))
    except Exception as e:
        print("[v2.match] match_requests insert failed:", e)


def _pid(p: dict) -> str:
    pid = str(p.get("product_id") or "").strip()
    if pid:
        return pid[:200]
    key = (p.get("url") or "") + "|" + (p.get("title") or "")
    return "h:" + hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()[:20]


# ---------------------------------------------------------------- entry point
async def match_products(site: str, products: list[dict], page_url: str = "", force: bool = False) -> dict:
    t0 = time.perf_counter()
    site = (site or "unknown").lower().strip()[:100]
    products = [p for p in (products or []) if isinstance(p, dict) and (p.get("title") or p.get("model") or p.get("upc"))][:40]
    pids = [_pid(p) for p in products]
    idx_task = asyncio.create_task(_index())
    cache = await asyncio.to_thread(_cache_sync, site, list(set(pids))) if pids and not force else {}
    await idx_task
    by_id = _idx["by_id"]

    results: dict[str, dict] = {}
    todo: list[tuple[str, dict]] = []
    seen = set()
    for pid, p in zip(pids, products):
        if pid in seen:
            continue
        seen.add(pid)
        c = cache.get(pid)
        if c:
            rid = c.get("recall_id")
            results[pid] = {"product_id": pid, "status": c["status"],
                            "recall": recall_card(by_id.get(rid)) if rid else None,
                            "confidence": float(c["confidence"] or 0.0), "reason": c.get("reason") or "",
                            "stage": c.get("stage") or 1, "cached": True}
        else:
            todo.append((pid, p))
    hits = len(results)

    cands = await stage1([p for _, p in todo]) if todo else []
    sync_items, bg_items, clean_rows = [], [], []
    for (pid, p), c in zip(todo, cands):
        if c is None:
            results[pid] = {"product_id": pid, "status": "clean", "recall": None, "confidence": 0.0,
                            "reason": "no brand/model/category match in the recall index", "stage": 1}
            clean_rows.append((site, pid, "clean", None, 0.0, "stage-1: no match", 1, (p.get("title") or "")[:500]))
        elif (site, pid) in _inflight and c["kind"] != "category":
            results[pid] = _pending(pid, c)
        elif c["kind"] == "category":
            if (site, pid) in _inflight:
                results[pid] = {"product_id": pid, "status": "clean", "recall": None, "confidence": 0.0,
                                "reason": f"stage-1: {c['why']}; confirming in background", "stage": 1}
                continue
            results[pid] = {"product_id": pid, "status": "clean", "recall": None, "confidence": 0.0,
                            "reason": f"stage-1: {c['why']}; confirming in background", "stage": 1}
            bg_items.append((pid, p, c))
        else:
            sync_items.append((pid, p, c))

    sync_items.sort(key=lambda x: -x[2]["score"])
    later = sync_items[MAX_SYNC_CANDIDATES:]
    sync_items = sync_items[:MAX_SYNC_CANDIDATES]
    for pid, _, c in later:
        results[pid] = _pending(pid, c)
    bg_items = (later + sorted(bg_items, key=lambda x: -x[2]["score"]))[:MAX_BG_CANDIDATES]

    if sync_items:  # one Gemini call per candidate, in parallel; take whatever finishes inside the budget
        tasks = _confirm(site, sync_items, 1)
        remaining = STAGE2_BUDGET_S - (time.perf_counter() - t0)
        done_tasks, _ = await asyncio.wait(tasks, timeout=max(0.05, remaining))
        done: dict[str, dict] = {}
        for t in done_tasks:
            if not t.cancelled() and t.exception() is None:
                done.update(t.result())
        for pid, _, c in sync_items:
            results[pid] = done.get(pid) or _pending(pid, c)
    if bg_items:
        _confirm(site, bg_items, MAX_SYNC_CANDIDATES)

    out = []
    for pid in pids:
        r = dict(results[pid])
        r.pop("cached", None)
        out.append(r)
    ms = int((time.perf_counter() - t0) * 1000)
    flagged = sum(1 for r in out if r["status"] != "clean")
    _spawn(asyncio.to_thread(_finish_writes, clean_rows, site, len(out), flagged, ms, hits))
    return {"results": out, "latency_ms": ms, "cache_hits": hits}


def _finish_writes(clean_rows, site, n, flagged, ms, hits):
    if clean_rows:
        try:
            _write_verdicts(clean_rows)
        except Exception as e:
            print("[v2.match] cache write failed:", e)
    _log_request(site, n, flagged, ms, hits)


def _pending(pid: str, c: dict) -> dict:
    return {"product_id": pid, "status": "possible", "recall": recall_card(c["recall"]),
            "confidence": 0.5 if c["kind"] == "strong" else 0.4,
            "reason": f"stage-1: {c['why']}; Gemini confirmation pending", "stage": 1}
