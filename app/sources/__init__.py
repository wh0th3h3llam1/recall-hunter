"""Bright Data marketplace sources (Agent C).

Working path (probed 2026-11-13): Web Scraper API datasets (token only). Web Unlocker / SERP need zones,
and this token cannot create zones (403), so those paths are used only for check_live when a zone exists.

search_all(recall, queries, emit) -> list[Listing]
check_live(listing) -> (is_live, http_status)
"""
import asyncio
import hashlib
import json
import os
import re
import time
from urllib.parse import quote_plus

import httpx

from .. import obs
from ..config import BD_TOKEN, BD_UNLOCKER_ZONE, BD_SERP_ZONE, CACHE_DIR

API = "https://api.brightdata.com"
CACHE_TTL_S = 30 * 60
WAIT_S = int(os.getenv("RH_BD_WAIT_S", "120"))  # total wait cap for async dataset jobs
PER_QUERY = 25
FB_CITIES = ["San Francisco", "Los Angeles", "Chicago", "Houston", "New York"]
COST_PER_RECORD = 0.0015  # Web Scraper API list price ~ $1.5 / 1k records
COST_PER_REQ = 0.0015     # Unlocker ~ $1.5 / 1k requests

DATASETS = {
    "ebay": {"id": "gd_ltr9mjt81n0zzdk1fb", "product": "web_scraper_api:ebay", "discover_by": "keywords"},
    "amazon": {"id": "gd_lwdb4vjm1ehb499uxs", "product": "web_scraper_api:amazon_search", "discover_by": None},
    "google_shopping": {"id": "gd_m31f2k0d2m1bah4f3b", "product": "web_scraper_api:google_shopping", "discover_by": None},
    "fb_marketplace": {"id": "gd_lvt9iwuh6fbcwmx1a", "product": "web_scraper_api:fb_marketplace", "discover_by": "keyword"},
}
PLATFORM_ORDER = ["ebay", "google_shopping", "fb_marketplace", "amazon"]


def _cache_only() -> bool:
    return os.getenv("RH_CACHE_ONLY") == "1"


def _headers() -> dict:
    return {"Authorization": f"Bearer {BD_TOKEN}", "Content-Type": "application/json"}


# ---------------- cache ----------------
def _key(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True).encode()).hexdigest()


def _cpath(k: str):
    return CACHE_DIR / f"{k}.json"


def _cache_get(k: str, ttl: bool = True):
    p = _cpath(k)
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    if ttl and not _cache_only() and time.time() - d.get("ts", 0) > CACHE_TTL_S:
        return None
    return d


def _cache_put(k: str, d: dict):
    d = {**d, "ts": time.time()}
    _cpath(k).write_text(json.dumps(d, default=str), encoding="utf-8")


# ---------------- inputs / grouping ----------------
def _inputs(platform: str, q: str, alt: bool = False) -> list[dict]:
    if platform == "ebay":
        return [{"keywords": q}]
    if platform == "amazon":
        return [{"keyword": q, "url": "https://www.amazon.com", "pages_to_search": 1}]
    if platform == "google_shopping":
        shop = "udm=28" if alt else "tbm=shop"
        return [{"url": f"https://www.google.com/search?q={quote_plus(q)}&{shop}&gl=us&hl=en"}]
    if platform == "fb_marketplace":
        return [{"keyword": q, "city": c, "radius": 40} for c in FB_CITIES]
    return []


def _record_query(platform: str, rec: dict, queries: list[str]) -> str | None:
    """Map a snapshot record back to the query that produced it."""
    cand = []
    for k in ("discovery_input", "input"):
        v = rec.get(k)
        if isinstance(v, dict):
            cand += [v.get("keywords"), v.get("keyword"), v.get("url")]
    cand.append(rec.get("keyword"))
    for c in cand:
        if not c:
            continue
        for q in queries:
            if c == q or (isinstance(c, str) and quote_plus(q) in c):
                return q
    return queries[0] if len(queries) == 1 else None


# ---------------- normalizers ----------------
def _f(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"[\d,]+(?:\.\d+)?", str(v))
    try:
        return float(m.group(0).replace(",", "")) if m else None
    except ValueError:
        return None


def _cur(v):
    if not v:
        return "USD"
    return {"$": "USD", "US $": "USD", "£": "GBP", "€": "EUR"}.get(str(v).strip(), str(v).strip())


def _first(v):
    if isinstance(v, list):
        v = v[0] if v else None
        if isinstance(v, dict):
            v = v.get("url") or v.get("image_url")
    return v


def _norm(platform: str, r: dict) -> dict | None:
    if r.get("error") or r.get("error_code"):
        return None
    if platform == "amazon":
        nid, title = r.get("asin"), r.get("name")
        price, seller, loc = _f(r.get("final_price")), r.get("brand"), None
        img = r.get("image")
        desc = " | ".join(x for x in [r.get("brand"), r.get("badge")] if x)
        url = f"https://www.amazon.com/dp/{nid}" if nid else r.get("url")
    elif platform == "google_shopping":
        nid, title = r.get("product_id") or r.get("id"), r.get("title")
        price, seller, loc = _f(r.get("final_price")), r.get("seller") or r.get("shop"), None
        img, desc, url = _first(r.get("image")), " ".join(r.get("tags") or []) if isinstance(r.get("tags"), list) else "", r.get("url")
    elif platform == "fb_marketplace":
        nid, title = r.get("product_id"), r.get("title")
        price, seller, loc = _f(r.get("final_price")), r.get("profile_id"), r.get("location")
        img, desc, url = _first(r.get("images")), r.get("description") or "", r.get("url")
    else:  # ebay
        nid = r.get("product_id") or r.get("item_id") or r.get("id") or r.get("epid")
        url = r.get("url")
        if not nid and url:
            m = re.search(r"/itm/(?:[^/]+/)?(\d+)", url)
            nid = m.group(1) if m else None
        title = r.get("title") or r.get("name")
        if title and title.strip().lower().startswith("shop on ebay"):
            return None
        price = _f(r.get("price") or r.get("final_price") or r.get("initial_price"))
        seller = r.get("seller_name") or r.get("seller") or r.get("seller_username")
        if isinstance(seller, dict):
            seller = seller.get("name") or seller.get("username")
        loc = r.get("item_location") or r.get("location") or r.get("ships_from")
        img = _first(r.get("images") or r.get("image") or r.get("main_image") or r.get("image_url"))
        desc = r.get("description") or r.get("condition") or ""
        if isinstance(desc, (list, dict)):
            desc = json.dumps(desc)[:2000]
    if not nid or not title:
        return None
    return {
        "listing_id": f"{platform}:{nid}", "platform": platform, "url": url, "title": title,
        "description": (desc or "")[:4000], "price": price, "currency": _cur(r.get("currency")),
        "seller": str(seller) if seller is not None else None, "location": loc, "image_url": img, "raw": r,
    }


async def _serp_shopping(client, q: str) -> list[dict]:
    """Bright Data SERP API: Google Shopping parsed JSON (brd_json=1). Up to 3 attempts (transient empties)."""
    from urllib.parse import quote_plus
    url = f"https://www.google.com/search?q={quote_plus(q)}&tbm=shop&gl=us&hl=en&brd_json=1"
    for attempt in range(3):
        t0 = time.perf_counter()
        st, n = "error", 0
        try:
            r = await client.post(API + "/request", headers=_headers(),
                                  json={"zone": BD_SERP_ZONE, "url": url, "format": "raw"}, timeout=60)
            st = str(r.status_code)
            if r.status_code == 200 and r.text.startswith("{"):
                items = r.json().get("shopping") or []
                recs = [{"product_id": it.get("cid") or it.get("rank"), "title": it.get("title"),
                         "final_price": it.get("price"), "shop": it.get("shop"), "url": it.get("link"),
                         "image": it.get("image") or it.get("image_base64")} for it in items]
                n = len(recs)
                if recs:
                    return recs
        except Exception as e:
            st = type(e).__name__
        finally:
            obs.log_call("brightdata", "serp_api", "request google_shopping", st,
                         int((time.perf_counter() - t0) * 1000), n, COST_PER_REQ, {"query": q, "attempt": attempt + 1})
    return []


# ---------------- Bright Data dataset calls ----------------
async def _bd(client: httpx.AsyncClient, method: str, path: str, product: str, endpoint: str, **kw):
    t0 = time.perf_counter()
    status, records, sample, resp = "error", 0, None, None
    try:
        resp = await client.request(method, API + path, headers=_headers(), **kw)
        status = str(resp.status_code)
        try:
            body = resp.json()
        except Exception:
            body = None
        if isinstance(body, list):
            records = len(body)
            sample = {"first_title": (body[0].get("title") or body[0].get("name")) if body and isinstance(body[0], dict) else None}
        elif isinstance(body, dict):
            sample = {k: body.get(k) for k in ("snapshot_id", "status", "records", "errors", "error") if k in body}
        else:
            sample = {"text": resp.text[:120]}
        return resp, body
    except Exception as e:
        sample = {"exc": str(e)[:160]}
        return None, None
    finally:
        obs.log_call("brightdata", product, endpoint, status, int((time.perf_counter() - t0) * 1000),
                     records, round(records * COST_PER_RECORD, 5), sample)


def _good(recs: list[dict]) -> bool:
    return any(not (r.get("error") or r.get("error_code")) for r in recs)


async def _run_dataset(client, platform: str, queries: list[str], deadline: float, alt: bool = False) -> dict[str, list[dict]]:
    """Trigger one snapshot for all queries, poll until ready or deadline. Returns raw records by query."""
    ds = DATASETS[platform]
    pend_key = _key("pending", platform, sorted(queries), alt)
    pend = _cache_get(pend_key)
    snap = pend.get("snapshot_id") if pend else None
    if not snap:
        params = {"dataset_id": ds["id"], "include_errors": "true",
                  "limit_per_input": str(10 if platform == "fb_marketplace" else PER_QUERY)}
        if ds["discover_by"]:
            params.update(type="discover_new", discover_by=ds["discover_by"])
        body = [i for q in queries for i in _inputs(platform, q, alt)]
        resp, j = await _bd(client, "POST", "/datasets/v3/trigger", ds["product"], "datasets/v3/trigger",
                            params=params, json=body)
        if not resp or resp.status_code != 200 or not isinstance(j, dict) or "snapshot_id" not in j:
            raise RuntimeError(f"trigger {resp.status_code if resp else 'exc'}: {(resp.text if resp else '')[:200]}")
        snap = j["snapshot_id"]
        _cache_put(pend_key, {"snapshot_id": snap, "queries": queries})
    status = None
    while time.time() < deadline:
        resp, j = await _bd(client, "GET", f"/datasets/v3/progress/{snap}", ds["product"], "datasets/v3/progress")
        if resp is not None and resp.status_code in (401, 403):
            raise PermissionError(f"progress {resp.status_code}: {resp.text[:120]}")
        status = (j or {}).get("status") if isinstance(j, dict) else None
        if status in ("ready", "failed"):
            break
        await asyncio.sleep(8)
    if status != "ready":
        raise TimeoutError(f"snapshot {snap} status={status} (kept pending; next run will collect it)")
    resp, j = await _bd(client, "GET", f"/datasets/v3/snapshot/{snap}", ds["product"], "datasets/v3/snapshot",
                        params={"format": "json"}, timeout=120)
    if not isinstance(j, list):
        raise RuntimeError(f"snapshot {snap} body not list: {(resp.text if resp else '')[:200]}")
    out: dict[str, list[dict]] = {q: [] for q in queries}
    for rec in j:
        q = _record_query(platform, rec, queries)
        if q:
            out[q].append(rec)
    for q in queries:
        if not _good(out[q]):  # crawler error only: do not cache, so the next run retries
            continue
        _cache_put(_key(platform, q), {"platform": platform, "query": q, "snapshot_id": snap, "records": out[q]})
    _cpath(pend_key).unlink(missing_ok=True)
    return out


async def _platform(client, platform: str, queries: list[str], emit, deadline: float) -> list[dict]:
    t0 = time.perf_counter()
    for q in queries:
        emit("query", {"platform": platform, "query": q})
    raw: dict[str, list[dict]] = {}
    missing = []
    for q in queries:
        c = _cache_get(_key(platform, q))
        if c is not None:
            raw[q] = c["records"]
        else:
            missing.append(q)
    status = "ok" if not missing else "cache_miss"
    if missing and not _cache_only() and platform == "google_shopping":
        # Fast path: SERP API zone (seconds) instead of the async dataset job (minutes).
        for q in list(missing):
            recs = await _serp_shopping(client, q)
            if recs:
                raw[q] = recs
                _cache_put(_key(platform, q), {"records": recs, "via": "serp_api"})
                missing.remove(q)
        status = "ok" if not missing else status
    if missing and not _cache_only():
        try:
            raw.update(await _run_dataset(client, platform, missing, deadline))
            retry = [q for q in missing if not _good(raw.get(q, []))]
            if retry and platform == "google_shopping":  # transient Google crawler errors: one retry, alt URL
                raw.update(await _run_dataset(client, platform, retry, deadline, alt=True))
            status = "ok"
        except TimeoutError as e:
            status = "timeout"
            print(f"[sources] {platform}: {e}")
        except Exception as e:
            status = "error"
            print(f"[sources] {platform}: {e}")
            obs.capture(e)
    if status != "ok":  # network failed/slow: fall back to stale cache (older than TTL) if we have it
        for q in queries:
            if not _good(raw.get(q, [])):
                c = _cache_get(_key(platform, q), ttl=False)
                if c is not None:
                    raw[q] = c["records"]
                    status = f"{status}+stale_cache"
    out, seen = [], set()
    for q, recs in raw.items():
        n = 0
        for r in recs:
            lst = _norm(platform, r)
            if not lst or lst["listing_id"] in seen:
                continue
            seen.add(lst["listing_id"])
            lst["raw"] = {**r, "_query": q}
            out.append(lst)
            n += 1
            if n >= PER_QUERY:
                break
    emit("source_done", {"platform": platform, "count": len(out), "status": status,
                         "ms": int((time.perf_counter() - t0) * 1000)})
    return out


async def search_all(recall: dict, queries: list[str], emit, platforms: list[str] | None = None) -> list[dict]:
    queries = [q.strip() for q in queries if q and q.strip()][:4]
    if not queries:
        return []
    platforms = platforms or PLATFORM_ORDER
    deadline = time.time() + WAIT_S
    async with httpx.AsyncClient(timeout=60) as client:
        res = await asyncio.gather(*[_platform(client, p, queries, emit, deadline) for p in platforms],
                                   return_exceptions=True)
    out, seen = [], set()
    for r in res:
        if isinstance(r, Exception):
            print("[sources] platform failed:", r)
            continue
        for lst in r:
            if lst["listing_id"] not in seen:
                seen.add(lst["listing_id"])
                out.append(lst)
    return out


# ---------------- liveness ----------------
_GONE = re.compile(r"(this listing (has ended|was ended)|listing is no longer available|"
                   r"this item is no longer available|no longer available|currently unavailable|"
                   r"this listing has been removed|page not found)", re.I)
_zone_ok: bool | None = None


async def _unlocker_available(client) -> bool:
    global _zone_ok
    if _zone_ok is None:
        try:
            r = await client.get(API + "/zone/get_active_zones", headers=_headers())
            _zone_ok = r.status_code == 200 and any(z.get("name") == BD_UNLOCKER_ZONE for z in (r.json() or []))
        except Exception:
            _zone_ok = False
    return _zone_ok


async def check_live(listing: dict) -> tuple[bool, int]:
    url = listing.get("url")
    if not url:
        return False, 0
    raw = listing.get("raw") or {}
    if _cache_only():
        return (not bool(raw.get("is_sold")), 200)
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        if await _unlocker_available(client):
            t0 = time.perf_counter()
            st, live = 0, False
            try:
                r = await client.post(API + "/request", headers=_headers(),
                                      json={"zone": BD_UNLOCKER_ZONE, "url": url, "format": "raw"})
                st = int(r.headers.get("x-brd-status-code") or r.status_code)
                live = st < 400 and not _GONE.search(r.text[:200000])
                return live, st
            finally:
                obs.log_call("brightdata", "web_unlocker", "request", str(st), int((time.perf_counter() - t0) * 1000),
                             1, COST_PER_REQ, {"url": url[:120], "live": live})
        # No Unlocker zone on this account: plain GET of the public listing page (not a Bright Data call).
        try:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"})
            return (r.status_code < 400 and not _GONE.search(r.text[:200000])), r.status_code
        except Exception:
            return False, 0
