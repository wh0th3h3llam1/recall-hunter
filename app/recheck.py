"""Re-check CONFIRMED/LIKELY listings for liveness -> rh.listing_observations."""
import asyncio

from . import db, obs


async def recheck_all() -> dict:
    from . import sources  # agent C
    rows = await asyncio.to_thread(db.q, """
        SELECT l.listing_id, l.recall_id, l.platform, l.url, l.price, l.title
        FROM rh.listings l JOIN rh.verdicts v USING (listing_id)
        WHERE v.final IN ('CONFIRMED','LIKELY')""")
    sem = asyncio.Semaphore(8)
    stats = {"checked": 0, "live": 0, "gone": 0}

    async def one(r):
        async with sem:
            try:
                is_live, status = await sources.check_live(r)
            except Exception as e:
                obs.capture(e)
                return
            stats["checked"] += 1
            stats["live" if is_live else "gone"] += 1
            await asyncio.to_thread(db.execute, """
                INSERT INTO rh.listing_observations(observed_at, listing_id, recall_id, platform, is_live, price, http_status)
                VALUES (now(), %s, %s, %s, %s, %s, %s)""",
                (r["listing_id"], r["recall_id"], r["platform"], bool(is_live), r["price"], status))

    with obs.span("recheck", "recheck_all"):
        await asyncio.gather(*[one(r) for r in rows])
    return stats
