"""Smoke test for /b2b on a throwaway FastAPI app (real DB, real DO + Bright Data calls).

    PYTHONPATH=. .venv/Scripts/python -m app.b2b._smoke

Leaves the DB realistic: one CONFIRMED eBay case notified with a drafted notice, every other case open.
"""
import io
import json
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from .. import db
from .router import router


def show(label, obj, n=600):
    s = obj if isinstance(obj, str) else json.dumps(obj, default=str)
    print(f"\n== {label}\n{s[:n]}")


def main():
    db.open_pool()
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)

    r = c.post("/b2b/sync"); r.raise_for_status(); show("sync #1", r.json())
    r = c.post("/b2b/sync"); r.raise_for_status(); show("sync #2 (idempotent: cases_opened should be 0)", r.json())

    r = c.get("/b2b/platforms"); r.raise_for_status(); show("platforms", r.json(), 1200)

    r = c.get("/b2b/sellers", params={"platform": "ebay"}); r.raise_for_status()
    ebay = r.json()
    show(f"sellers?platform=ebay ({len(ebay)})", [{k: s[k] for k in ("seller_id", "name", "profile_url", "listings_count",
                                                                     "confirmed_count", "likely_count", "open_cases")}
                                                  for s in ebay[:5]], 1500)
    if ebay:
        r = c.get(f"/b2b/sellers/{ebay[0]['seller_id']}"); r.raise_for_status()
        d = r.json()
        show("seller detail", {"seller_id": d["seller_id"], "n_listings": len(d["listings"]),
                               "first": {k: d["listings"][0].get(k) for k in ("listing_id", "title", "case_id", "case_status")}
                               | {"final": d["listings"][0]["verdict"]["final"]}})

    r = c.get("/b2b/cases", params={"status": "open"}); r.raise_for_status()
    open_cases = r.json()
    show(f"cases?status=open ({len(open_cases)})", open_cases[0] if open_cases else None, 1500)

    # deterministic targets: first two CONFIRMED eBay cases
    allc = c.get("/b2b/cases", params={"platform": "ebay"}).json()
    conf = sorted([x for x in allc if x["severity"] == "CONFIRMED"], key=lambda x: x["case_id"])
    target, vcase = conf[0], conf[1]

    r = c.patch(f"/b2b/cases/{target['case_id']}", json={"status": "notified"}); r.raise_for_status()
    show("PATCH notified", {k: r.json()[k] for k in ("case_id", "status", "opened_at", "notified_at")})

    t0 = time.perf_counter()
    r = c.post(f"/b2b/cases/{target['case_id']}/notice"); r.raise_for_status()
    n = r.json()
    show(f"notice model={n['model']} provider={n['provider']} api_ms={n['latency_ms']} "
         f"wall_ms={int((time.perf_counter() - t0) * 1000)} chars={len(n['notice_text'])}", n["notice_text"], 300)

    r = c.post(f"/b2b/cases/{vcase['case_id']}/verify"); r.raise_for_status()
    v = r.json()
    show(f"verify {vcase['case_id']} {vcase['listing_url']}", v)
    if v["status"] != vcase["status"]:  # revert the test transition
        db.execute("UPDATE rh.cases SET status=%s, removed_at=NULL WHERE case_id=%s", (vcase["status"], vcase["case_id"]))
        db.execute("DELETE FROM rh.case_events WHERE case_id=%s AND type IN ('removed','verify_gone') "
                   "AND at > now() - interval '10 minutes'", (vcase["case_id"],))
        print(f"   reverted {vcase['case_id']} to {vcase['status']}")

    r = c.get("/b2b/sla"); r.raise_for_status(); show("sla", r.json(), 1500)
    r = c.get("/b2b/sla", params={"platform": "ebay"}); r.raise_for_status(); show("sla?platform=ebay", r.json(), 1500)

    r = c.get("/b2b/report.csv"); r.raise_for_status()
    lines = r.text.splitlines()
    show(f"report.csv ({len(lines) - 1} rows)", "\n".join(lines[:3]), 1500)

    csv_body = ("id,title,brand,model,image_url,url,seller\n"
                "T1,Bodum Chambord French Press Coffee Maker 8 cup 34 oz,Bodum,1928,,,test-seller\n"
                "T2,Stainless steel mixing bowl set of 3,Generic,,,,test-seller\n")
    r = c.post("/b2b/catalog/upload", files={"file": ("cat.csv", io.BytesIO(csv_body.encode()), "text/csv")})
    show(f"catalog/upload HTTP {r.status_code}", r.json() if r.headers.get("content-type", "").startswith("application/json")
         else r.text, 1200)

    st = db.q("SELECT status, count(*) FROM rh.cases GROUP BY 1 ORDER BY 1")
    show("final case status counts", st)
    db.pool.close()


if __name__ == "__main__":
    main()
