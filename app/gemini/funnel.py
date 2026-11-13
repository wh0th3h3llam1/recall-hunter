"""3-tier Gemini funnel: Tier 1 text screen (flash-lite, batched) -> Tier 2 vision (flash, per listing)
-> Tier 3 judge (pro, only when tier-2 confidence < 0.75). Plus query planning, embeddings and geocoding.
Every Gemini call is logged via obs.log_call("gemini", ...)."""
import asyncio
import json
import time
from typing import Literal, Optional

import httpx
from pydantic import BaseModel, Field

from .. import config, obs
from ..config import M_EMBED, M_JUDGE, M_SCREEN, M_VISION

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Rough public list prices, USD per 1M tokens (input, output). ESTIMATES only.
_RATES = {
    M_SCREEN: (0.10, 0.40),
    M_VISION: (0.30, 2.50),
    M_JUDGE: (2.00, 12.00),
    M_EMBED: (0.15, 0.0),
}

CATEGORIES = ("exact_recalled_model", "likely_variant", "different_product", "accessory_or_part", "insufficient_info")
Category = Literal["exact_recalled_model", "likely_variant", "different_product", "accessory_or_part", "insufficient_info"]

_client = None
# Judge chain: preferred model first; on 404/429/503 it is skipped for 5 min and the next is used.
JUDGE_CHAIN = list(dict.fromkeys([M_JUDGE, "gemini-4-hydrogen", "gemini-3.6-flash", M_VISION, M_SCREEN]))
VISION_CHAIN = list(dict.fromkeys([M_VISION, "gemini-4-hydrogen", "gemini-3.6-flash", M_SCREEN]))  # flash-lite is multimodal: last resort
_dead: dict[str, float] = {}
TIER2_THINKING = "low"   # speed: vision tier thinks lightly; the judge (tier 3) uses the model default (high)


_beta = None


def client(model: str = ""):
    """Preview models are only served on v1beta; everything else uses the SDK default."""
    global _client, _beta
    from google import genai
    from google.genai import types
    if "preview" in model:
        if _beta is None:
            _beta = genai.Client(api_key=config.GEMINI_KEY, http_options=types.HttpOptions(api_version="v1beta"))
        return _beta
    if _client is None:
        _client = genai.Client(api_key=config.GEMINI_KEY)
    return _client


# ---------------------------------------------------------------- schemas
class Queries(BaseModel):
    queries: list[str]


class T1Item(BaseModel):
    idx: int
    category: Category
    match_score: float = Field(description="0-10 how well the listing matches the recalled product")
    code_in_range: Optional[bool] = Field(None, description="true if a model/lot/date code in the listing falls in the recalled range, false if it is outside, null if unknown")
    remedy_applied: Optional[bool] = Field(None, description="true if the listing says the recall fix/repair kit was applied, null if unknown")
    confidence: float = Field(description="0-1 confidence in the category")
    reason: str


class T1Out(BaseModel):
    results: list[T1Item]


class LabelBox(BaseModel):
    box_2d: list[int] = Field(description="[ymin, xmin, ymax, xmax] normalized 0-1000 in the LISTING image")
    label: str


class VisionOut(BaseModel):
    category: Category
    match_score: float = Field(description="0-10 scale (10 = identical product), NOT 0-1")
    code_in_range: Optional[bool] = None
    remedy_applied: Optional[bool] = None
    confidence: float
    label_box: Optional[LabelBox] = None
    reason: str


class GeoItem(BaseModel):
    location: str
    lat: float
    lon: float


class GeoOut(BaseModel):
    results: list[GeoItem]


# ---------------------------------------------------------------- helpers
def _cost(model: str, usage) -> tuple[float, dict]:
    pin, pout = _RATES.get(model, (0.30, 2.50))
    it = getattr(usage, "prompt_token_count", 0) or 0
    ot = (getattr(usage, "candidates_token_count", 0) or 0) + (getattr(usage, "thoughts_token_count", 0) or 0)
    return round((it * pin + ot * pout) / 1e6, 6), {"in_tok": it, "out_tok": ot, "cost_note": "estimate from list prices"}


async def _gen(model: str, tag: str, contents, schema, records: int = 1, sample_extra: dict | None = None,
               thinking: str | None = None):
    """generate_content with structured JSON; logs every call. Returns (parsed_dict, latency_ms)."""
    from google.genai import types
    kw = {"thinking_config": types.ThinkingConfig(thinking_level=thinking)} if thinking else {}
    cfg = types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema, **kw)
    for attempt in range(3):  # retry transient 503/429 (model overload) with backoff
        t0 = time.perf_counter()
        try:
            resp = await client(model).aio.models.generate_content(model=model, contents=contents, config=cfg)
            break
        except Exception as e:
            ms = int((time.perf_counter() - t0) * 1000)
            obs.log_call("gemini", f"{model}:{tag}", "generateContent", "error", ms, 0, 0.0,
                         {"error": str(e)[:300], "attempt": attempt + 1, **(sample_extra or {})})
            code = getattr(e, "code", None)
            if attempt == 2 or code not in (500, 503, 504) and not (code == 429 and attempt == 0):
                raise
            await asyncio.sleep(2 + attempt * 4)
    ms = int((time.perf_counter() - t0) * 1000)
    cost, tok = _cost(model, resp.usage_metadata)
    parsed = resp.parsed
    if isinstance(parsed, BaseModel):
        data = parsed.model_dump()
    elif parsed is not None:
        data = parsed
    else:
        data = json.loads(resp.text)
    obs.log_call("gemini", f"{model}:{tag}", "generateContent", "200", ms, records, cost,
                 {**tok, **(sample_extra or {})})
    return data, ms


_img_cache: dict[str, tuple[bytes, str] | None] = {}


def _sniff(b: bytes) -> str | None:
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    return None


async def fetch_image(url: str | None) -> tuple[bytes, str] | None:
    if not url:
        return None
    if url in _img_cache:
        return _img_cache[url]
    out = None
    if url.startswith("data:image/"):  # Bright Data SERP returns inline base64 thumbnails
        import base64
        try:
            head, b64 = url.split(",", 1)
            out = (base64.b64decode(b64), head[5:].split(";")[0])
        except Exception:
            out = None
        _img_cache[url] = out
        return out
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers={"User-Agent": UA}) as c:
            r = await c.get(url)
        if r.status_code == 200 and 0 < len(r.content) < 15_000_000:
            mime = _sniff(r.content) or r.headers.get("content-type", "").split(";")[0].strip()
            if mime in ("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"):
                out = (r.content, mime)
    except Exception:
        out = None
    if len(_img_cache) > 500:
        _img_cache.clear()
    _img_cache[url] = out
    return out


def _part(img: tuple[bytes, str]):
    from google.genai import types
    return types.Part.from_bytes(data=img[0], mime_type=img[1])


def _recall_text(r: dict) -> str:
    return (f"CPSC RECALL #{r.get('recall_number')} ({r.get('recall_date')})\n"
            f"Title: {r.get('title')}\nProduct: {r.get('product_name')}\nModels/codes: {r.get('models')}\n"
            f"Description: {(r.get('description') or '')[:1500]}\nHazard: {(r.get('hazard') or '')[:600]}\n"
            f"Remedy: {(r.get('remedy') or '')[:300]}")


def _listing_text(l: dict) -> str:
    return (f"Platform: {l.get('platform')}\nTitle: {l.get('title')}\nPrice: {l.get('price')} {l.get('currency') or ''}\n"
            f"Seller: {l.get('seller')}\nLocation: {l.get('location')}\nDescription: {(l.get('description') or '')[:1200]}")


_RUBRIC = (
    "Categories: exact_recalled_model = same brand and same model/product as the recall; "
    "likely_variant = same brand/product line, plausibly the recalled item but model/size/code not verifiable; "
    "different_product = not the recalled product (other brand or other product type); "
    "accessory_or_part = a replacement part/accessory for the product, not the product itself; "
    "insufficient_info = cannot tell. A different brand is different_product unless the recall names that brand; "
    "a size/model the recall explicitly excludes is different_product. match_score 0-10. confidence 0-1. "
    "code_in_range: true/false only if a model number, lot or date code is visible/stated and can be compared to the recalled range, else null. "
    "remedy_applied: true only if the listing says the recall repair/refund was done, else null. Keep reason under 30 words."
)


def _final(category: str, conf: float, tier: int) -> str:
    if category == "exact_recalled_model" and (conf >= 0.75 or tier == 3):
        return "CONFIRMED"
    if category in ("exact_recalled_model", "likely_variant"):
        return "LIKELY"
    return "REJECTED"


def _clean_box(b):
    if not b or not isinstance(b, dict):
        return None
    box = b.get("box_2d")
    if not isinstance(box, list) or len(box) != 4:
        return None
    try:
        box = [max(0, min(1000, int(round(float(x))))) for x in box]
    except Exception:
        return None
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return {"box_2d": box, "label": str(b.get("label") or "")[:80]}


# ---------------------------------------------------------------- planner
async def _do_queries(recall: dict) -> list[str]:
    prompt = (_query_prompt(recall) + '\nReply ONLY with JSON: {"queries": ["...", "..."]}')
    t0 = time.perf_counter()
    model = "openai-gpt-oss-120b"
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{config.DO_INFERENCE_BASE_URL.rstrip('/')}/chat/completions",
                             headers={"Authorization": f"Bearer {config.DO_INFERENCE_KEY}"},
                             json={"model": model, "messages": [{"role": "user", "content": prompt}],
                                   "temperature": 0.2, "max_tokens": 1500})
        ms = int((time.perf_counter() - t0) * 1000)
        r.raise_for_status()
        txt = r.json()["choices"][0]["message"]["content"]
        txt = txt[txt.find("{"): txt.rfind("}") + 1]
        qs = [q.strip() for q in json.loads(txt)["queries"] if q and q.strip()][:4]
        if not qs:
            raise ValueError("no queries")
        obs.log_call("digitalocean", f"serverless-inference:{model}", "chat/completions", "200", ms, len(qs), 0.0,
                     {"queries": qs})
        return qs
    except Exception as e:
        obs.log_call("digitalocean", f"serverless-inference:{model}", "chat/completions", "error",
                     int((time.perf_counter() - t0) * 1000), 0, 0.0, {"error": str(e)[:200]})
        raise


def _query_prompt(recall: dict) -> str:
    return ("Write 2 to 4 short search strings (2-6 words each) a person would type into eBay / Facebook Marketplace / "
            "Craigslist to find used units of this recalled product for sale. Use brand + product name; include the model "
            "number in one query if one is given. No quotes, no boolean operators.\n\n" + _recall_text(recall))


async def make_queries(recall: dict) -> list[str]:
    if config.DO_INFERENCE_KEY:
        try:
            return await _do_queries(recall)
        except Exception:
            pass  # fall back to Gemini
    data, _ = await _gen(M_SCREEN, "queries", _query_prompt(recall), Queries, sample_extra={"recall_id": recall.get("recall_id")})
    qs = []
    for q in data.get("queries") or []:
        q = (q or "").strip().strip('"')
        if q and q.lower() not in [x.lower() for x in qs]:
            qs.append(q)
    if not qs:
        qs = [f"{recall.get('product_name') or recall.get('title')}"[:60]]
    return qs[:4]


# ---------------------------------------------------------------- triage
async def _tier1(recall: dict, batch: list[dict]) -> tuple[dict[int, dict], int]:
    lines = [f"[{i}] " + _listing_text(l).replace("\n", " | ") for i, l in enumerate(batch)]
    prompt = ("You screen online marketplace listings against a US CPSC product recall. For EACH listing return one result "
              "with its idx.\n" + _RUBRIC + "\n\n" + _recall_text(recall) + "\n\nLISTINGS:\n" + "\n".join(lines))
    data, ms = await _gen(M_SCREEN, "tier1", prompt, T1Out, records=len(batch),
                          sample_extra={"batch": len(batch), "first": (batch[0].get("title") or "")[:60]})
    out = {}
    for it in data.get("results") or []:
        try:
            out[int(it["idx"])] = it
        except Exception:
            pass
    return out, ms


async def _vision_contents(recall: dict, listing: dict, header: str):
    rimgs = []
    for u in (recall.get("image_urls") or [])[:4]:
        img = await fetch_image(u)
        if img:
            rimgs.append(img)
        if len(rimgs) == 2:
            break
    limg = await fetch_image(listing.get("image_url"))
    contents = [header + "\n\n" + _recall_text(recall) + "\n\nLISTING:\n" + _listing_text(listing)]
    for i, img in enumerate(rimgs):
        contents += [f"RECALL OFFICIAL IMAGE {i + 1}:", _part(img)]
    if limg:
        contents += ["LISTING IMAGE (label_box coordinates refer to THIS image):", _part(limg)]
    else:
        contents += ["(listing image unavailable: label_box must be null)"]
    return contents, len(rimgs), bool(limg)


async def _gen_chain(chain: list[str], tag: str, contents, thinking, sample: dict):
    """Try models in order; a model that returns 404/403 (unavailable) or 429/503 (quota/overload) is skipped
    for a while so concurrent calls don't keep hammering it. Records which model answered."""
    last = None
    for m in chain:
        if _dead.get(m, 0) > time.time():
            continue
        try:
            data, ms = await _gen(m, tag, contents, VisionOut, thinking=thinking if m != M_SCREEN else None,
                                  sample_extra={**sample, "model_used": m})
        except Exception as e:
            last = e
            code = getattr(e, "code", None)
            if code in (403, 404):
                _dead[m] = time.time() + 3600
                continue
            if code in (429, 503):
                _dead[m] = time.time() + 60
                continue
            raise
        data["model_used"] = m
        return data, ms
    raise last or RuntimeError(f"no {tag} model available (all in cooldown)")


_T2_HEADER = ("You verify whether a marketplace listing is selling a product recalled by the US CPSC. Compare the listing "
              "text and photo against the official recall images and details (shape, colour, branding, model/lot label). "
              + _RUBRIC + " label_box: if the LISTING image shows the model/lot/date label, the brand marking, or the "
              "distinctive recalled feature, return box_2d [ymin,xmin,ymax,xmax] normalized 0-1000 around it in the "
              "LISTING image with a short label; null if nothing relevant is visible.")


async def _tier2(recall: dict, listing: dict) -> tuple[dict, int, bool]:
    contents, nr, has_l = await _vision_contents(recall, listing, _T2_HEADER)
    data, ms = await _gen_chain(VISION_CHAIN, "tier2", contents, TIER2_THINKING,
                                {"listing_id": listing.get("listing_id"), "recall_imgs": nr, "listing_img": has_l})
    if not has_l:
        data["label_box"] = None
    return data, ms, has_l


async def _tier3(recall: dict, listing: dict, t2: dict | None) -> tuple[dict, int]:
    prior = f"\n\nA faster model's preliminary opinion (may be wrong): {json.dumps(t2, default=str)}" if t2 else ""
    header = ("You are the final judge. Think carefully and decide whether this listing is offering the exact product "
              "recalled by the CPSC. Your ruling is final." + _T2_HEADER[_T2_HEADER.find("Categories"):] + prior)
    contents, nr, has_l = await _vision_contents(recall, listing, header)
    data, ms = await _gen_chain(JUDGE_CHAIN, "tier3", contents, None,
                                {"listing_id": listing.get("listing_id"), "recall_imgs": nr, "listing_img": has_l})
    if not has_l:
        data["label_box"] = None
    return data, ms


def _verdict(recall, listing, d, tier, latency, final=None):
    cat = d.get("category") if d.get("category") in CATEGORIES else "insufficient_info"
    conf = float(d.get("confidence") or 0.0)
    return {
        "listing_id": listing["listing_id"], "recall_id": recall.get("recall_id"), "category": cat,
        "match_score": float(d.get("match_score") or 0.0), "code_in_range": d.get("code_in_range"),
        "remedy_applied": d.get("remedy_applied"), "confidence": round(max(0.0, min(1.0, conf)), 3),
        "tier_reached": tier, "label_box": _clean_box(d.get("label_box")), "reason": (d.get("reason") or "")[:400],
        "final": final or _final(cat, conf, tier), "latency_ms": int(latency),
    }


async def triage(recall: dict, listings: list[dict], emit) -> list[dict]:
    emit = emit or (lambda *a, **k: None)
    listings = [l for l in listings if l.get("listing_id")]
    verdicts: list[dict] = []
    survivors: list[tuple[dict, dict, int]] = []  # (listing, t1 result, t1 ms)

    # ---- Tier 1: batches of <=10, run concurrently
    batches = [listings[i:i + 10] for i in range(0, len(listings), 10)]
    sem1 = asyncio.Semaphore(4)

    async def run_batch(b):
        async with sem1:
            try:
                return b, *(await _tier1(recall, b)), None
            except Exception as e:
                obs.capture(e)
                return b, {}, 0, e

    for b, res, ms, err in await asyncio.gather(*[run_batch(b) for b in batches]):
        rej = 0
        for i, l in enumerate(b):
            r = res.get(i)
            if r is None:  # screen failed / missing -> let vision decide
                r = {"category": "insufficient_info", "match_score": 0, "confidence": 0.0,
                     "reason": f"tier1 unavailable{': ' + str(err)[:80] if err else ''}"}
            if r.get("category") == "different_product" and float(r.get("confidence") or 0) >= 0.7:
                v = _verdict(recall, l, r, 1, ms, final="REJECTED")
                verdicts.append(v)
                emit("verdict", v)
                rej += 1
            else:
                survivors.append((l, r, ms))
        emit("screened", {"batch": len(b), "rejected": rej, "survivors": len(b) - rej, "ms": ms,
                          "error": str(err)[:200] if err else None})

    # ---- Tier 2 (+3): concurrent, Semaphore(6)
    sem = asyncio.Semaphore(6)

    async def deep(l, t1, t1ms):
        async with sem:
            t2, t2ms, err2 = None, 0, None
            try:
                t2, t2ms, _ = await _tier2(recall, l)
                emit("vision", {"listing_id": l["listing_id"], "category": t2.get("category"),
                                "confidence": t2.get("confidence"), "label_box": _clean_box(t2.get("label_box")),
                                "ms": t2ms})
            except Exception as e:
                obs.capture(e)
                err2 = e
            conf2 = float((t2 or {}).get("confidence") or 0.0)
            if t2 is not None and conf2 >= 0.75:
                return _verdict(recall, l, t2, 2, t1ms + t2ms)
            emit("escalated", {"listing_id": l["listing_id"], "t2_confidence": conf2 if t2 else None})
            try:
                t3, t3ms = await _tier3(recall, l, t2)
                return _verdict(recall, l, t3, 3, t1ms + t2ms + t3ms)
            except Exception as e:
                obs.capture(e)
                base, tier = (t2, 2) if t2 is not None else (t1, 1)
                v = _verdict(recall, l, base, tier, t1ms + t2ms)
                if tier == 1:  # text-only screen never confirms on its own
                    v["final"] = "LIKELY" if v["category"] in ("exact_recalled_model", "likely_variant") else "REJECTED"
                v["reason"] = (v["reason"] + f" [judge error: {str(e)[:80]}]")[:400]
                if t2 is None and err2 is not None:
                    v["reason"] += f" [vision error: {str(err2)[:80]}]"
                return v

    async def deep_emit(*a):
        v = await deep(*a)
        emit("verdict", v)
        return v

    verdicts += await asyncio.gather(*[deep_emit(*s) for s in survivors])
    return verdicts


# ---------------------------------------------------------------- embeddings / geocode
async def _embed(contents, tag_sample: dict) -> list[float] | None:
    from google.genai import types
    t0 = time.perf_counter()
    try:
        r = await client().aio.models.embed_content(
            model=M_EMBED, contents=contents, config=types.EmbedContentConfig(output_dimensionality=768))
        ms = int((time.perf_counter() - t0) * 1000)
        v = list(r.embeddings[0].values)
        obs.log_call("gemini", f"{M_EMBED}:embed", "embedContent", "200", ms, 1, 0.0,
                     {**tag_sample, "dims": len(v), "cost_note": "embedding cost not metered (estimate 0)"})
        return v if len(v) == 768 else None
    except Exception as e:
        obs.log_call("gemini", f"{M_EMBED}:embed", "embedContent", "error", int((time.perf_counter() - t0) * 1000),
                     0, 0.0, {**tag_sample, "error": str(e)[:200]})
        return None


async def embed_image(url: str, fallback_text: str | None = None) -> list[float] | None:
    img = await fetch_image(url)
    v = None
    if img:
        v = await _embed([_part(img)], {"kind": "image"})
    if v is None and fallback_text:
        v = await embed_text(fallback_text)
    return v


async def embed_text(text: str) -> list[float] | None:
    return await _embed([text[:2000]], {"kind": "text"})


async def geocode(locations: list[str]) -> dict[str, tuple[float, float]]:
    locs = sorted({(l or "").strip() for l in locations if l and l.strip()})[:80]
    if not locs:
        return {}
    prompt = ("Give the approximate latitude/longitude (city centroid) for each of these US marketplace locations. "
              "Return one result per input, with location copied exactly as given. Skip ones you cannot place.\n"
              + "\n".join(locs))
    data, _ = await _gen(M_SCREEN, "geocode", prompt, GeoOut, records=len(locs), sample_extra={"n": len(locs)})
    out = {}
    for it in data.get("results") or []:
        try:
            lat, lon = float(it["lat"]), float(it["lon"])
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                out[it["location"]] = (lat, lon)
        except Exception:
            pass
    return out
