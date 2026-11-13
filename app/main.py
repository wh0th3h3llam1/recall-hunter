"""Recall Hunter API. Run: .venv/Scripts/python -m uvicorn app.main:app --port 8000"""
import asyncio
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, events, obs
from .config import ROOT, EVIDENCE_DIR, DO_TOKEN, DO_INFERENCE_KEY, SPACES_KEY, SENTRY_DSN, env

obs.init_sentry()
app = FastAPI(title="Recall Hunter")
_tasks: dict[str, asyncio.Task] = {}

from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

# Browser extension (chrome-extension://, moz-extension://) and storefront content scripts call /v2.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

for _mod in ("app.v2.router", "app.b2b.router"):
    try:
        import importlib
        app.include_router(importlib.import_module(_mod).router)
    except Exception as _e:  # router not built yet / import error: keep v1 running
        print(f"[main] router {_mod} not loaded: {_e}")


@app.on_event("startup")
def _startup():
    db.open_pool()


LISTING_SQL = """
SELECT l.listing_id, l.recall_id, l.platform, l.url, l.title, l.price, l.currency, l.seller, l.location,
       l.lat, l.lon, l.image_url, l.first_seen, v.category, v.match_score, v.confidence, v.tier_reached,
       v.label_box, v.reason, v.final, v.evidence_url, v.code_in_range, v.remedy_applied,
       (current_date - r.recall_date) AS days_since_recall, r.hazard_class
FROM rh.listings l JOIN rh.recalls r USING (recall_id) LEFT JOIN rh.verdicts v USING (listing_id)
"""


@app.get("/api/health")
def health():
    return {"ok": True, "db": bool(db.q1("select 1 as x"))}


@app.get("/api/recalls")
def recalls(child: int = 0, limit: int = 60):
    return db.q(
        """SELECT r.recall_id, r.recall_number, r.recall_date, r.title, r.product_name, r.hazard, r.hazard_class,
                  r.units, r.image_urls, r.is_child, r.priority, r.url,
                  count(v.listing_id) FILTER (WHERE v.final='CONFIRMED') AS confirmed_count,
                  count(v.listing_id) FILTER (WHERE v.final IN ('CONFIRMED','LIKELY')) AS live_count
           FROM rh.recalls r LEFT JOIN rh.verdicts v ON v.recall_id = r.recall_id
           WHERE (%s = 0 OR r.is_child)
           GROUP BY r.recall_id ORDER BY count(v.listing_id) FILTER (WHERE v.final IN ('CONFIRMED','LIKELY')) > 0 DESC,
                    r.priority DESC, r.recall_date DESC LIMIT %s""",
        (child, limit),
    )


@app.get("/api/recalls/{recall_id}")
def recall(recall_id: int):
    r = db.q1("SELECT * FROM rh.recalls WHERE recall_id=%s", (recall_id,))
    if not r:
        raise HTTPException(404, "recall not found")
    r["listings"] = db.q(LISTING_SQL + " WHERE l.recall_id=%s ORDER BY v.final NULLS LAST", (recall_id,))
    return r


@app.get("/api/listings")
def listings(recall_id: int | None = None, final: str | None = None):
    where, params = ["(v.final IS NULL OR v.final <> 'REJECTED' OR %s = 'ALL')"], [final or ""]
    if recall_id:
        where.append("l.recall_id = %s")
        params.append(recall_id)
    if final and final != "ALL":
        where.append("v.final = %s")
        params.append(final)
    return db.q(LISTING_SQL + " WHERE " + " AND ".join(where) + " ORDER BY l.first_seen DESC LIMIT 500", params)


@app.post("/api/hunt/{recall_id}")
async def hunt(recall_id: int):
    if not db.q1("SELECT 1 AS x FROM rh.recalls WHERE recall_id=%s", (recall_id,)):
        raise HTTPException(404, "recall not found")
    run_id = uuid.uuid4().hex[:12]
    from .hunter.agent import run_hunt

    events.emit(run_id, "start", {"recall_id": recall_id, "run_id": run_id})

    async def _go():
        try:
            await run_hunt(run_id, recall_id)
        except Exception as e:  # surface to UI
            obs.capture(e)
            events.emit(run_id, "error", {"message": str(e)[:300]})

    _tasks[run_id] = asyncio.create_task(_go())
    return {"run_id": run_id}


@app.get("/api/hunt/{run_id}/events")
async def hunt_events(run_id: str):
    return StreamingResponse(events.stream(run_id), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/stats")
def stats(recall_id: int | None = None):
    f = "WHERE v.recall_id = %(rid)s" if recall_id else ""
    p = {"rid": recall_id}
    tot = db.q1(f"""SELECT count(*) AS scanned,
              count(*) FILTER (WHERE v.final='CONFIRMED') AS confirmed,
              count(*) FILTER (WHERE v.final='LIKELY') AS likely,
              count(*) FILTER (WHERE v.final='REJECTED') AS rejected,
              count(*) FILTER (WHERE v.tier_reached >= 2) AS vision,
              count(*) FILTER (WHERE v.tier_reached = 3) AS escalated
            FROM rh.verdicts v {f}""", p) or {}
    med = db.q1(f"""SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY current_date - r.recall_date) AS med
            FROM rh.verdicts v JOIN rh.recalls r USING (recall_id)
            WHERE v.final IN ('CONFIRMED','LIKELY') {'AND v.recall_id = %(rid)s' if recall_id else ''}""", p) or {}
    by_platform = db.q(f"""SELECT l.platform, count(*) FILTER (WHERE v.final='CONFIRMED') AS confirmed,
              count(*) FILTER (WHERE v.final IN ('CONFIRMED','LIKELY')) AS live, count(*) AS scanned
            FROM rh.listings l LEFT JOIN rh.verdicts v USING (listing_id)
            {'WHERE l.recall_id = %(rid)s' if recall_id else ''} GROUP BY 1 ORDER BY 2 DESC""", p)
    by_hazard = db.q("""SELECT r.hazard_class, count(*) AS confirmed FROM rh.verdicts v JOIN rh.recalls r USING (recall_id)
            WHERE v.final IN ('CONFIRMED','LIKELY') GROUP BY 1 ORDER BY 2 DESC""")
    gem = db.q1("""SELECT count(*) AS calls, coalesce(sum(cost_usd),0) AS cost_usd FROM rh.api_calls WHERE sponsor='gemini'""") or {}
    tiers = db.q("""SELECT split_part(product, ':', 2) AS tier, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
            FROM rh.api_calls WHERE sponsor='gemini' GROUP BY 1""")
    return {
        "recalls": (db.q1("SELECT count(*) AS n FROM rh.recalls") or {}).get("n", 0),
        "listings_scanned": tot.get("scanned", 0), "confirmed": tot.get("confirmed", 0),
        "likely": tot.get("likely", 0), "rejected": tot.get("rejected", 0),
        "median_days_live": med.get("med"),
        "funnel": {"screened": tot.get("scanned", 0), "vision": tot.get("vision", 0),
                   "escalated": tot.get("escalated", 0), "confirmed": tot.get("confirmed", 0)},
        "by_platform": by_platform, "by_hazard": by_hazard,
        "gemini": {"calls": gem.get("calls", 0), "cost_usd": float(gem.get("cost_usd") or 0),
                   "p50_ms_by_tier": {t["tier"]: t["p50"] for t in tiers}},
    }


@app.get("/api/proof")
def proof():
    rows = db.q("""SELECT DISTINCT ON (sponsor, product) sponsor, product, endpoint, status, latency_ms, records,
                          called_at, sample FROM rh.api_calls ORDER BY sponsor, product, called_at DESC""")
    counts = db.q("SELECT sponsor, count(*) AS calls FROM rh.api_calls GROUP BY 1")
    tiger = db.q1("""SELECT (SELECT count(*) FROM rh.listing_observations) AS observations,
                            (SELECT count(*) FROM rh.listings WHERE embedding IS NOT NULL) AS vectors,
                            (SELECT extversion FROM pg_extension WHERE extname='timescaledb') AS timescaledb,
                            (SELECT extversion FROM pg_extension WHERE extname='vectorscale') AS vectorscale,
                            (SELECT extversion FROM pg_extension WHERE extname='pg_textsearch') AS pg_textsearch""")
    return {"calls": rows, "counts": counts, "tiger": tiger,
            "configured": {"brightdata": True, "gemini": True, "tiger": True,
                           "digitalocean": bool(DO_INFERENCE_KEY or SPACES_KEY),
                           "sentry": bool(SENTRY_DSN), "snowflake": bool(env("SNOWFLAKE_ACCOUNT"))}}


@app.get("/api/similar/{listing_id}")
def similar(listing_id: str):
    """Tiger vector search (vectorscale diskann): other listings whose photo embeds close to this one."""
    return db.q("""SELECT l2.listing_id, l2.platform, l2.title, l2.seller, l2.url, l2.image_url,
                          1 - (l2.embedding <=> l1.embedding) AS similarity
                   FROM rh.listings l1 JOIN rh.listings l2 ON l2.listing_id <> l1.listing_id
                   WHERE l1.listing_id = %s AND l1.embedding IS NOT NULL AND l2.embedding IS NOT NULL
                   ORDER BY l2.embedding <=> l1.embedding LIMIT 6""", (listing_id,))


@app.get("/api/search")
def search(q: str):
    """Tiger pg_textsearch BM25 over listing titles (exact model numbers)."""
    try:
        return db.q("""SELECT listing_id, platform, title, url, title <@> to_bm25query(%s, 'rh.listings_bm25_idx') AS score
                       FROM rh.listings ORDER BY title <@> to_bm25query(%s, 'rh.listings_bm25_idx') LIMIT 20""", (q, q))
    except Exception:
        return db.q("""SELECT listing_id, platform, title, url FROM rh.listings
                       WHERE to_tsvector('english', title) @@ plainto_tsquery('english', %s) LIMIT 20""", (q,))


@app.post("/api/recheck")
async def recheck():
    from .recheck import recheck_all
    return await recheck_all()


@app.post("/api/recalls/sync")
def sync_recalls(since: str = "2026-10-01"):
    from .ingest import sync
    return {"upserted": sync(since)}


@app.get("/evidence/{name}")
def evidence(name: str):
    p = (EVIDENCE_DIR / name).resolve()
    if EVIDENCE_DIR.resolve() not in p.parents or not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
