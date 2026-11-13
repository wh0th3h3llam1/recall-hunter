"""CPSC recalls API -> rh.recalls. Public API, no auth."""
import re
import time
import httpx
from . import db
from .obs import log_call

CPSC = "https://www.saferproducts.gov/RestWebServices/Recall"

HAZARD_RULES = [
    ("flammability", r"flammab"),
    ("tip_over", r"tip.?over|unstable if.*not anchored"),
    ("ingestion", r"magnet|swallow|ingest|button batter|coin batter|water bead|poison"),
    ("choking", r"chok|small part"),
    ("suffocation", r"suffocat|asphyx|inclined sleep|nursing pillow|lounger|bedside sleeper|bassinet"),
    ("entrapment", r"entrap|strangul|head and neck|torso"),
    ("fire_burn", r"fire|burn|overheat|ignite|explode|lithium"),
    ("shock", r"shock|electrocut"),
    ("fall", r"fall hazard|fall|crash|collapse|detach|separate"),
    ("laceration", r"lacerat|cut hazard|break"),
]
CHILD_RE = r"child|infant|baby|toddler|kid|toy|crib|nursery|youth|stroller|sleeper|rattle|teether|pacifier|playset|pajama|nursing"


def classify(text: str) -> str:
    t = text.lower()
    for name, rx in HAZARD_RULES:
        if re.search(rx, t):
            return name
    return "other"


def _units(s: str) -> int:
    m = re.search(r"([\d.,]+)\s*(million)?", s or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", "") or 0)
    return int(n * 1_000_000) if m.group(2) else int(n)


def sync(since: str = "2026-09-01", extra_numbers: list[str] | None = None) -> int:
    t0 = time.perf_counter()
    r = httpx.get(CPSC, params={"format": "json", "RecallDateStart": since}, timeout=180)
    rows = r.json()
    log_call("cpsc", "recalls_api", f"Recall?RecallDateStart={since}", str(r.status_code),
             int((time.perf_counter() - t0) * 1000), len(rows))
    for num in extra_numbers or []:
        try:
            rows.extend(fetch_number(num))
        except Exception as e:
            print("recall number fetch failed", num, type(e).__name__)
    return upsert([x for x in rows if x.get("RecallID")])


def fetch_number(num: str) -> list[dict]:
    t0 = time.perf_counter()
    r = httpx.get(CPSC, params={"format": "json", "RecallNumber": num}, timeout=180)
    log_call("cpsc", "recalls_api", f"Recall?RecallNumber={num}", str(r.status_code), int((time.perf_counter() - t0) * 1000))
    return r.json() if r.status_code == 200 else []


def upsert(rows: list[dict]) -> int:
    n = 0
    for x in rows:
        prods = x.get("Products") or [{}]
        p = prods[0]
        hazard = " ".join(h.get("Name", "") for h in x.get("Hazards") or [])
        title = x.get("Title", "")
        text = f"{title} {hazard} {x.get('Description', '')}"
        hc = classify(f"{title} {hazard}")
        if hc == "other":
            hc = classify(text)
        is_child = bool(re.search(CHILD_RE, text.lower()))
        units = p.get("NumberOfUnits", "")
        sev = 3 if re.search(r"death", title.lower()) else 1
        priority = sev * 10 + (15 if is_child else 0) + min(10, _units(units) // 100_000)
        models = "; ".join(filter(None, [q.get("Model", "") for q in prods]))
        db.execute(
            """INSERT INTO rh.recalls(recall_id,recall_number,recall_date,title,description,url,product_name,models,units,
                 hazard,hazard_class,injuries,remedy,retailers,image_urls,is_child,priority)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (recall_id) DO UPDATE SET hazard_class=EXCLUDED.hazard_class, priority=EXCLUDED.priority,
                 is_child=EXCLUDED.is_child, image_urls=EXCLUDED.image_urls""",
            (x["RecallID"], x.get("RecallNumber"), (x.get("RecallDate") or "")[:10] or None, title,
             x.get("Description"), x.get("URL"), p.get("Name"), models, units, hazard, hc,
             " ".join(i.get("Name", "") for i in x.get("Injuries") or []),
             " ".join(i.get("Name", "") for i in x.get("Remedies") or []),
             " ".join(i.get("Name", "") for i in x.get("Retailers") or [])[:2000],
             [i["URL"] for i in x.get("Images") or [] if i.get("URL")], is_child, priority),
        )
        n += 1
    return n


if __name__ == "__main__":
    db.open_pool()
    # 23088 = Rock 'n Play re-announcement (Jan 2023)
    print("upserted", sync("2026-09-15", extra_numbers=["23088", "19094"]))
