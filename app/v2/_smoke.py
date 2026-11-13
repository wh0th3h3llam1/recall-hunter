"""Real smoke test for the v2 engine (no server): .venv/Scripts/python -m app.v2._smoke [--alt]
Calls match_products against Tiger + Gemini for real. Uses site 'smoke.test' with fresh product ids per run."""
import asyncio
import random
import statistics
import sys
import time

from .. import db
from . import match

GENERIC = [
    "Apple AirPods Pro (2nd Generation) Wireless Earbuds with MagSafe Case",
    "Instant Pot Duo 7-in-1 Electric Pressure Cooker, 6 Quart",
    "Hydro Flask 32 oz Wide Mouth Water Bottle with Flex Cap",
    "Anker PowerCore 10000 Portable Charger",
    "Ninja AF101 Air Fryer, 4 Quart, Grey",
    "Crayola 64 Ct Crayons with Built-in Sharpener",
    "Dyson V8 Cordless Vacuum Cleaner",
    "Logitech MX Master 3S Wireless Mouse",
    "Carter's Baby Boys' 5-Pack Bodysuits",
    "Graco Pack 'n Play Portable Playard",
    "Fisher-Price Laugh & Learn Smart Stages Chair",
    "KitchenAid Artisan Series 5 Quart Tilt-Head Stand Mixer",
    "Schwinn Kids Bike, 16-Inch Wheels, Training Wheels Included",
]
MAGNETOPIA = "Magnetopia Magnetic Building Cubes 100pcs"
LEGO = "LEGO Classic bricks"


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


async def run():
    run_id = str(int(time.time()))
    bodum = db.q("""SELECT l.title FROM rh.listings l JOIN rh.verdicts v USING (listing_id)
                    WHERE v.recall_id = 11041 AND v.final IN ('CONFIRMED','LIKELY') AND l.platform = 'ebay'
                      AND l.title ~* '(8 ?cup|12 ?cup|34 ?oz|1\\.0 ?l|1l\\M)' ORDER BY v.final, l.title LIMIT 3""")
    # (8/12-cup sizes only: the recall covers 8- and 12-cup carafes; Gemini correctly rejects 12 oz / 17 oz units)
    rej = db.q("""SELECT DISTINCT l.title FROM rh.listings l JOIN rh.verdicts v USING (listing_id)
                  WHERE v.final = 'REJECTED' AND l.title IS NOT NULL""")
    random.seed(7)
    rej_titles = random.sample([r["title"] for r in rej], 37 - len(GENERIC))
    cases = [(r["title"], True, "bodum") for r in bodum] + [(t, False, "rejected") for t in rej_titles] + \
            [(t, False, "generic") for t in GENERIC]
    prods = [{"product_id": f"s{run_id}-{i}", "title": t} for i, (t, _, _) in enumerate(cases)]

    print(f"== precision request: {len(prods)} cards (3 Bodum CONFIRMED eBay, {len(rej_titles)} REJECTED, {len(GENERIC)} generic)")
    r1 = await match.match_products("smoke.test", prods)
    print(f"cold: latency_ms={r1['latency_ms']} cache_hits={r1['cache_hits']}")
    extra = [{"product_id": f"s{run_id}-mag", "title": MAGNETOPIA}, {"product_id": f"s{run_id}-lego", "title": LEGO}]
    r2 = await match.match_products("smoke.test", extra)
    print(f"magnetopia/lego: latency_ms={r2['latency_ms']}")
    for x in r2["results"]:
        print("  ", x["status"], x["stage"], x["confidence"], (x["recall"] or {}).get("recall_id"), x["reason"][:110])

    print("-- draining background stage 2 ...")
    t = time.perf_counter()
    await match.drain(90)
    print(f"   drained in {int((time.perf_counter() - t) * 1000)} ms")
    r1b = await match.match_products("smoke.test", prods)
    r2b = await match.match_products("smoke.test", extra)
    print(f"cached re-request: latency_ms={r1b['latency_ms']} cache_hits={r1b['cache_hits']}/{len(prods)}")

    def score(label, results, expect):
        tp = fp = tn = fn = 0
        stages = {}
        for res, (title, flag, grp) in zip(results, expect):
            stages[res["stage"]] = stages.get(res["stage"], 0) + 1
            got = res["status"] != "clean"
            tp += got and flag
            fp += got and not flag
            fn += (not got) and flag
            tn += (not got) and not flag
            if got != flag or got:
                print(f"   [{grp:8}] {'FLAG' if flag else 'clean':5} -> {res['status']:8} s{res['stage']} "
                      f"conf={res['confidence']} rid={(res['recall'] or {}).get('recall_id')} | {title[:60]} | {res['reason'][:90]}")
        prec = tp / (tp + fp) if tp + fp else 1.0
        rec = tp / (tp + fn) if tp + fn else 1.0
        print(f"{label}: TP={tp} FP={fp} TN={tn} FN={fn} precision={prec:.2f} recall={rec:.2f} stages={stages}")

    print("== first response (cold)")
    score("cold", r1["results"] + r2["results"], cases + [(MAGNETOPIA, True, "magnetopia"), (LEGO, False, "lego")])
    print("== after background stage 2 (cached)")
    score("final", r1b["results"] + r2b["results"], cases + [(MAGNETOPIA, True, "magnetopia"), (LEGO, False, "lego")])

    # ---- latency: 40 clean cards, cold (fresh ids) vs cached
    clean_pool = [t for t in [r["title"] for r in rej] if t not in rej_titles]
    s1 = await match.stage1([{"title": t} for t in clean_pool])
    clean_pool = [t for t, c in zip(clean_pool, s1) if c is None] + GENERIC  # cards that stay clean at stage 1
    cold, warm = [], []
    for k in range(10):
        ps = [{"product_id": f"l{run_id}-{k}-{i}", "title": t} for i, t in enumerate(random.sample(clean_pool, 40))]
        t = time.perf_counter()
        a = await match.match_products("smoke.test", ps)
        cold.append((time.perf_counter() - t) * 1000)
        await match.drain(30)
        t = time.perf_counter()
        b = await match.match_products("smoke.test", ps)
        warm.append((time.perf_counter() - t) * 1000)
        assert b["cache_hits"] == 40, b["cache_hits"]
        assert all(x["status"] == "clean" for x in a["results"])
    print(f"== latency 40 clean cards x10: cold p50={statistics.median(cold):.0f} p95={pct(cold, 95):.0f} max={max(cold):.0f} ms | "
          f"cached p50={statistics.median(warm):.0f} p95={pct(warm, 95):.0f} max={max(warm):.0f} ms")

    # mixed 40 random REJECTED-listing cards (hard negatives, same categories as recalls)
    mixed = []
    for k in range(5):
        ps = [{"product_id": f"m{run_id}-{k}-{i}", "title": t} for i, t in enumerate(random.sample([r["title"] for r in rej], 40))]
        t = time.perf_counter()
        a = await match.match_products("smoke.test", ps)
        mixed.append((time.perf_counter() - t) * 1000)
    await match.drain(90)
    print(f"== latency 40 random REJECTED-listing cards x5 (some trigger stage 2): p50={statistics.median(mixed):.0f} "
          f"max={max(mixed):.0f} ms")
    print(db.q("SELECT count(*) n, avg(latency_ms)::int avg_ms FROM rh.match_requests WHERE site='smoke.test' AND at > now() - interval '15 minutes'"))


async def alt():
    from . import alternatives
    t = time.perf_counter()
    a = await alternatives.get_alternatives(11041, "Bodum Chambord French Press 34 oz")
    print(f"== alternatives 11041 ({int((time.perf_counter() - t) * 1000)} ms): category={a['category']}")
    for it in a["items"]:
        print("  ", it["title"][:70], "|", it["price"], "|", it["shop"], "|", (it["image"] or "")[:30], "|", it["safety_note"])
    t = time.perf_counter()
    b = await alternatives.get_alternatives(11041)
    print(f"   cached: {int((time.perf_counter() - t) * 1000)} ms, items={len(b['items'])}")


def main():
    db.open_pool()
    try:
        if "--alt" in sys.argv:
            asyncio.run(alt())
        else:
            asyncio.run(run())
    finally:
        db.pool.close()


if __name__ == "__main__":
    main()
