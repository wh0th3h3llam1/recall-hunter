"""TEST SCRIPT ONLY (not used by the app). Real Gemini calls against hand-built controls; writes nothing to rh.listings.
Run: .venv/Scripts/python -m app.gemini._smoke [recall_id]"""
import asyncio
import json
import sys
import time

from app import db
from app.gemini import funnel

NEG_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/640px-Fronalpstock_big.jpg"


async def main(recall_id: int | None):
    db.open_pool()
    if recall_id:
        recall = db.q1("SELECT * FROM rh.recalls WHERE recall_id=%s", (recall_id,))
    else:
        recall = db.q1("SELECT * FROM rh.recalls WHERE title ILIKE '%%bodum%%' LIMIT 1") or \
            db.q1("SELECT * FROM rh.recalls ORDER BY priority DESC LIMIT 1")
    print("RECALL", recall["recall_id"], recall["title"][:90], "| images:", len(recall.get("image_urls") or []))

    t = time.perf_counter()
    qs = await funnel.make_queries(recall)
    print("QUERIES", qs, f"{int((time.perf_counter()-t)*1000)}ms")

    pos = {"listing_id": "TEST:pos", "platform": "ebay", "url": "https://example.test/pos",
           "title": recall.get("product_name") or recall["title"], "description": "Used, works fine. Pickup only.",
           "price": 25.0, "currency": "USD", "seller": "test_seller", "location": "Austin, TX",
           "image_url": (recall.get("image_urls") or [None])[0]}
    neg = {"listing_id": "TEST:neg", "platform": "ebay", "url": "https://example.test/neg",
           "title": "Framed landscape photo print of Swiss Alps mountain lake 16x20", "description": "Wall art, new.",
           "price": 40.0, "currency": "USD", "seller": "art_shop", "location": "Denver, CO", "image_url": NEG_IMG}

    events = []
    vs = await funnel.triage(recall, [pos, neg], lambda ty, d=None: events.append((ty, d)))
    for v in vs:
        print("VERDICT", json.dumps(v, default=str))
    print("EVENTS", [e[0] for e in events])

    t = time.perf_counter()
    emb = await funnel.embed_image(pos["image_url"], fallback_text=pos["title"])
    print("EMBED dims", len(emb) if emb else None, f"{int((time.perf_counter()-t)*1000)}ms")
    geo = await funnel.geocode(["Austin, TX", "Denver, CO"])
    print("GEO", geo)
    rows = db.q("SELECT product, status, latency_ms, cost_usd, sample FROM rh.api_calls WHERE sponsor='gemini' "
                "ORDER BY called_at DESC LIMIT 10")
    for r in rows:
        print("LOG", r["product"], r["status"], r["latency_ms"], r["cost_usd"], json.dumps(r["sample"])[:160])
    db.pool.close()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else None))
