"""TEST SCRIPT ONLY: one real run_hunt; prints stats and event counts. Run: python -m app.hunter._smoke_hunt [recall_id]"""
import asyncio, json, sys, time
from collections import Counter
from app import db, events
from app.hunter.agent import run_hunt


async def main(rid):
    db.open_pool()
    run_id = f"smoke-{rid}-{int(time.time())}"
    t = time.time()
    stats = await run_hunt(run_id, rid)
    print("RUN", run_id, f"{time.time()-t:.1f}s")
    print("STATS", json.dumps(stats, default=str))
    print("EVENTS", dict(Counter(e["type"] for e in events._buffers[run_id])))
    for v in db.q("""SELECT l.platform, l.title, v.category, v.confidence, v.tier_reached, v.final, v.label_box, v.evidence_url, v.latency_ms
                     FROM rh.verdicts v JOIN rh.listings l USING(listing_id) WHERE l.run_id=%s ORDER BY v.final, v.confidence DESC LIMIT 15""", (run_id,)):
        print("V", v["final"], v["category"], v["confidence"], "t", v["tier_reached"], v["platform"], (v["title"] or "")[:60], "box" if v["label_box"] else "-", v["evidence_url"], v["latency_ms"])
    print(db.q("SELECT tier, percentile_cont(0.5) within group (order by latency_ms) p50, count(*) n FROM (SELECT split_part(product,':',2) tier, latency_ms FROM rh.api_calls WHERE sponsor='gemini' AND status='200' AND called_at > now() - interval '15 minutes') x GROUP BY tier"))
    db.pool.close()

asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 11041))
