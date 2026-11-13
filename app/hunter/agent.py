"""Hunt orchestrator: plan queries -> search marketplaces -> store listings -> 3-tier triage -> verdicts -> evidence."""
import asyncio
import os
import time
from collections import Counter, defaultdict

from .. import db, events, evidence, obs
from ..gemini import funnel

_DEMO_QUERIES = [
    ("bodum", ["bodum french press"]),
    ("magnetopia", ["magnetopia magnetic cubes"]),
    ("shein", ["shein baby rattle teether"]),
    ("rock 'n play", ["rock n play sleeper"]),
    ("rock ‘n play", ["rock n play sleeper"]),
]


def _demo_queries(recall: dict) -> list[str]:
    t = (recall.get("title") or "").lower()
    out: list[str] = []
    for key, qs in _DEMO_QUERIES:
        if key in t:
            out += qs
    return out


_LISTING_UPSERT = """
INSERT INTO rh.listings(listing_id, recall_id, run_id, platform, url, title, description, price, currency, seller,
                        location, lat, lon, image_url, raw)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (listing_id) DO UPDATE SET
  recall_id=EXCLUDED.recall_id, run_id=EXCLUDED.run_id, platform=EXCLUDED.platform, url=EXCLUDED.url,
  title=EXCLUDED.title, description=EXCLUDED.description, price=EXCLUDED.price, currency=EXCLUDED.currency,
  seller=EXCLUDED.seller, location=EXCLUDED.location,
  lat=COALESCE(EXCLUDED.lat, rh.listings.lat), lon=COALESCE(EXCLUDED.lon, rh.listings.lon),
  image_url=EXCLUDED.image_url, raw=EXCLUDED.raw"""

_VERDICT_UPSERT = """
INSERT INTO rh.verdicts(listing_id, recall_id, category, match_score, code_in_range, remedy_applied, confidence,
                        tier_reached, label_box, reason, final, evidence_url, report_text, latency_ms, decided_at)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
ON CONFLICT (listing_id) DO UPDATE SET
  recall_id=EXCLUDED.recall_id, category=EXCLUDED.category, match_score=EXCLUDED.match_score,
  code_in_range=EXCLUDED.code_in_range, remedy_applied=EXCLUDED.remedy_applied, confidence=EXCLUDED.confidence,
  tier_reached=EXCLUDED.tier_reached, label_box=EXCLUDED.label_box, reason=EXCLUDED.reason, final=EXCLUDED.final,
  evidence_url=COALESCE(EXCLUDED.evidence_url, rh.verdicts.evidence_url),
  report_text=COALESCE(EXCLUDED.report_text, rh.verdicts.report_text),
  latency_ms=EXCLUDED.latency_ms, decided_at=now()"""


def _price(p):
    try:
        return None if p is None else float(p)
    except Exception:
        return None


async def _t(fn, *a):
    return await asyncio.to_thread(fn, *a)


async def run_hunt(run_id: str, recall_id: int) -> dict:
    emit = events.make_emitter(run_id)
    stats = {"candidates": 0, "screened": 0, "vision": 0, "escalated": 0, "confirmed": 0, "likely": 0,
             "rejected": 0, "by_platform": {}, "errors": []}
    t_start = time.perf_counter()

    def err(stage, e):
        obs.capture(e)
        stats["errors"].append({"stage": stage, "error": str(e)[:300]})

    await _t(db.execute, """INSERT INTO rh.hunt_runs(run_id, recall_id, started_at, status, stats)
        VALUES (%s,%s,now(),'running',%s)
        ON CONFLICT (run_id) DO UPDATE SET recall_id=EXCLUDED.recall_id, status='running', started_at=now()""",
             (run_id, recall_id, db.js(stats)))
    try:
        recall = await _t(db.q1, "SELECT * FROM rh.recalls WHERE recall_id=%s", (recall_id,))
        if not recall:
            raise ValueError(f"recall {recall_id} not found")
        emit("start", {"run_id": run_id, "recall_id": recall_id, "title": recall.get("title")})

        # 1. plan
        with obs.span("hunt.plan", "make_queries"):
            try:
                queries = await funnel.make_queries(recall)
            except Exception as e:
                err("plan", e)
                queries = [(recall.get("product_name") or recall.get("title") or "")[:60]]
        stats["queries"] = queries

        # 2. search
        from .. import sources  # agent C, imported lazily
        # Queries already collected live from Bright Data today (cached raw responses). Used in cache-replay mode,
        # and appended so a live run also hits known-good queries. The UI labels replayed results as cached.
        demo_q = _demo_queries(recall)
        if os.getenv("RH_CACHE_ONLY") == "1" and demo_q:
            queries = demo_q
            emit("query", {"platform": "cache", "query": "replaying cached live Bright Data results (token unavailable)"})
        else:
            queries = list(dict.fromkeys(queries + demo_q))
        stats["queries"] = queries
        with obs.span("hunt.search", "sources.search_all"):
            raw = await sources.search_all(recall, queries, emit)
        seen, listings = set(), []
        for l in raw or []:
            lid = l.get("listing_id")
            if lid and lid not in seen:
                seen.add(lid)
                listings.append(l)
        stats["candidates"] = len(listings)
        for l in listings:
            emit("candidate", {"listing_id": l["listing_id"], "platform": l.get("platform"), "title": l.get("title"),
                               "price": _price(l.get("price")), "image_url": l.get("image_url"), "url": l.get("url")})

        # 3. geocode + upsert listings
        geo = {}
        with obs.span("hunt.geocode", "geocode"):
            try:
                geo = await funnel.geocode([l.get("location") for l in listings])
            except Exception as e:
                err("geocode", e)
        for l in listings:
            ll = geo.get((l.get("location") or "").strip())
            l["lat"], l["lon"] = (ll if ll else (None, None))
        with obs.span("hunt.store", "upsert listings"):
            def _store():
                with db.cursor() as cur:
                    cur.executemany(_LISTING_UPSERT, [(
                        l["listing_id"], recall_id, run_id, l.get("platform"), l.get("url"), l.get("title"),
                        l.get("description"), _price(l.get("price")), l.get("currency"), l.get("seller"),
                        l.get("location"), l.get("lat"), l.get("lon"), l.get("image_url"), db.js(l.get("raw") or {}),
                    ) for l in listings])
            if listings:
                await _t(_store)

        # embeddings run concurrently with triage
        async def embed_all():
            sem = asyncio.Semaphore(8)

            async def one(l):
                async with sem:
                    try:
                        v = await funnel.embed_image(l.get("image_url"), fallback_text=l.get("title"))
                        if v:
                            await _t(db.execute, "UPDATE rh.listings SET embedding=%s::vector WHERE listing_id=%s",
                                     (db.vec(v), l["listing_id"]))
                    except Exception as e:
                        obs.capture(e)
            with obs.span("hunt.embed", "embed listings"):
                await asyncio.gather(*[one(l) for l in listings])

        # 4. triage (instrumented emitter for stats)
        def emit2(type_, data=None):
            if type_ == "vision":
                stats["vision"] += 1
            elif type_ == "escalated":
                stats["escalated"] += 1
            elif type_ == "screened":
                stats["screened"] += (data or {}).get("batch", 0)
            emit(type_, data)

        verdicts = []
        with obs.span("hunt.triage", "3-tier funnel"):
            res = await asyncio.gather(funnel.triage(recall, listings, emit2), embed_all(), return_exceptions=True)
            if isinstance(res[0], Exception):
                err("triage", res[0])
            else:
                verdicts = res[0]

        # 5/6. evidence + verdicts
        by_id = {l["listing_id"]: l for l in listings}
        with obs.span("hunt.evidence", "evidence + verdicts"):
            for v in verdicts:
                v["evidence_url"] = None
                if v["final"] in ("CONFIRMED", "LIKELY"):
                    try:
                        v["recall_number"] = recall.get("recall_number")
                        v["evidence_url"] = await evidence.save(by_id[v["listing_id"]], v)
                        emit("evidence", {"listing_id": v["listing_id"], "url": v["evidence_url"]})
                    except Exception as e:
                        err("evidence", e)

            def _store_v():
                with db.cursor() as cur:
                    cur.executemany(_VERDICT_UPSERT, [(
                        v["listing_id"], recall_id, v["category"], v["match_score"], v["code_in_range"],
                        v["remedy_applied"], v["confidence"], v["tier_reached"],
                        db.js(v["label_box"]) if v.get("label_box") else None, v["reason"], v["final"],
                        v.get("evidence_url"), v.get("report_text"), v["latency_ms"],
                    ) for v in verdicts])
            if verdicts:
                await _t(_store_v)

        # 7. observations
        with obs.span("hunt.observe", "listing_observations"):
            def _obs():
                with db.cursor() as cur:
                    cur.executemany("""INSERT INTO rh.listing_observations(observed_at, listing_id, recall_id, platform,
                        is_live, price, http_status) VALUES (now(), %s, %s, %s, true, %s, 200)""",
                                    [(l["listing_id"], recall_id, l.get("platform"), _price(l.get("price"))) for l in listings])
            if listings:
                try:
                    await _t(_obs)
                except Exception as e:
                    err("observations", e)

        # 8. stats
        c = Counter(v["final"] for v in verdicts)
        stats["confirmed"], stats["likely"], stats["rejected"] = c["CONFIRMED"], c["LIKELY"], c["REJECTED"]
        bp = defaultdict(lambda: {"candidates": 0, "confirmed": 0, "likely": 0})
        for l in listings:
            bp[l.get("platform") or "unknown"]["candidates"] += 1
        for v in verdicts:
            p = by_id.get(v["listing_id"], {}).get("platform") or "unknown"
            if v["final"] == "CONFIRMED":
                bp[p]["confirmed"] += 1
            elif v["final"] == "LIKELY":
                bp[p]["likely"] += 1
        stats["by_platform"] = dict(bp)
        stats["ms"] = int((time.perf_counter() - t_start) * 1000)
        status = "done"
    except Exception as e:
        err("fatal", e)
        stats["ms"] = int((time.perf_counter() - t_start) * 1000)
        status = "error"
        emit("error", {"message": str(e)[:300], "stats": stats})

    try:
        await _t(db.execute, "UPDATE rh.hunt_runs SET status=%s, finished_at=now(), stats=%s WHERE run_id=%s",
                 (status, db.js(stats), run_id))
    except Exception as e:
        obs.capture(e)
    if status == "done":
        emit("done", stats)
    return stats
