"""Real smoke test: .venv/Scripts/python -m app.sources._smoke [query ...]
Env: RH_BD_WAIT_S (dataset wait cap, default 120), RH_CACHE_ONLY=1 to replay cache only."""
import asyncio
import sys
import time
from collections import defaultdict

from app import db
from app import sources

QUERIES = ["rock n play sleeper", "bodum french press", "magnetopia magnetic cubes", "shein baby rattle teether"]


def emit(t, d):
    if t == "source_done":
        print(f"  [{t}] {d}", flush=True)


async def main(queries):
    db.open_pool()
    t0 = time.time()
    # one search_all per query (matches how the hunter calls it per recall), all concurrently
    res = await asyncio.gather(*[sources.search_all({"title": q}, [q], emit) for q in queries])
    print(f"\n=== done in {time.time() - t0:.0f}s ===")
    for q, listings in zip(queries, res):
        by = defaultdict(list)
        for l in listings:
            by[l["platform"]].append(l)
        print(f"\n## {q}: total {len(listings)}")
        for p in sources.PLATFORM_ORDER:
            ls = by.get(p, [])
            print(f"  {p:16s} {len(ls):3d}  " + " || ".join(f"{l['title'][:60]} (${l['price']})" for l in ls[:2]))


if __name__ == "__main__":
    try:
        asyncio.run(main(sys.argv[1:] or QUERIES))
    finally:
        db.pool.close()
