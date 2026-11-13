"""Build rh.sellers from rh.listings and open a case for every CONFIRMED/LIKELY verdict. Idempotent."""
import hashlib
import re
from urllib.parse import quote

from .. import db

ACTIVE = ("CONFIRMED", "LIKELY")
_EBAY_USER = re.compile(r"^[A-Za-z0-9._\-]{2,64}$")


def case_id_for(listing_id: str) -> str:
    return "C-" + hashlib.sha1(listing_id.encode()).hexdigest()[:8].upper()


def seller_identity(platform: str, seller: str | None, raw: dict | None) -> dict | None:
    """-> {seller_id, name, profile_url, kind} or None when the platform did not expose a seller.

    kind says what the name really is: seller (eBay account), profile (FB profile id), shop (Google Shopping merchant),
    brand (Amazon search results expose the brand, not the third-party seller).
    """
    raw = raw or {}
    if platform == "ebay":
        name = raw.get("seller_name") or seller or raw.get("store_name")
        if not name:
            return None
        name = str(name).strip()
        if _EBAY_USER.match(name):
            url = f"https://www.ebay.com/usr/{quote(name)}"
        else:
            url = raw.get("seller_url") or None
            if url:
                url = url.split("?")[0]
        return {"seller_id": f"ebay:{name}", "name": name, "profile_url": url, "kind": "seller"}
    if platform == "fb_marketplace":
        pid = raw.get("profile_id") or seller
        if not pid:
            return None
        pid = str(pid).strip()
        return {"seller_id": f"fb_marketplace:{pid}", "name": f"FB profile {pid}",
                "profile_url": f"https://www.facebook.com/marketplace/profile/{pid}", "kind": "profile"}
    if platform == "amazon":
        name = raw.get("seller_name") or raw.get("buybox_seller")
        if isinstance(name, dict):
            name = name.get("name")
        if name:
            sid = raw.get("seller_id")
            url = f"https://www.amazon.com/sp?seller={quote(str(sid))}" if sid else None
            return {"seller_id": f"amazon:{name}", "name": str(name), "profile_url": url, "kind": "seller"}
        brand = raw.get("brand") or seller
        if not brand:
            return None
        brand = str(brand).strip()
        # Amazon search results give the brand only; the actual third-party seller is not exposed.
        return {"seller_id": f"amazon:{brand}", "name": f"{brand} (brand)", "profile_url": None, "kind": "brand"}
    if platform == "google_shopping":
        shop = raw.get("shop") or raw.get("seller") or seller
        if not shop:
            return None
        shop = str(shop).strip()
        return {"seller_id": f"google_shopping:{shop}", "name": shop, "profile_url": None, "kind": "shop"}
    name = raw.get("seller_name") or seller
    if not name:
        return None
    return {"seller_id": f"{platform}:{name}", "name": str(name), "profile_url": raw.get("seller_url"), "kind": "seller"}


def seller_kind(seller_id: str | None, name: str | None) -> str | None:
    if not seller_id:
        return None
    p = seller_id.split(":", 1)[0]
    if p == "fb_marketplace":
        return "profile"
    if p == "google_shopping":
        return "shop"
    if p == "amazon" and (name or "").endswith("(brand)"):
        return "brand"
    return "seller"


_LISTINGS_SQL = """
SELECT l.listing_id, l.platform, l.seller, l.first_seen, coalesce(l.recall_id, v.recall_id) AS recall_id,
       jsonb_build_object('seller_name', l.raw->'seller_name', 'seller_url', l.raw->'seller_url',
                          'store_name', l.raw->'store_name', 'seller_id', l.raw->'seller_id',
                          'profile_id', l.raw->'profile_id', 'shop', l.raw->'shop', 'brand', l.raw->'brand',
                          'buybox_seller', l.raw->'buybox_seller', 'seller', l.raw->'seller') AS raw,
       v.final
FROM rh.listings l LEFT JOIN rh.verdicts v USING (listing_id)
"""


def run_sync() -> dict:
    rows = db.q(_LISTINGS_SQL)
    sellers: dict[str, dict] = {}
    listing_seller: dict[str, str | None] = {}
    for r in rows:
        raw = {k: v for k, v in (r["raw"] or {}).items() if v is not None}
        ident = seller_identity(r["platform"], r["seller"], raw)
        listing_seller[r["listing_id"]] = ident["seller_id"] if ident else None
        if not ident:
            continue
        s = sellers.setdefault(ident["seller_id"], {**ident, "platform": r["platform"], "first_seen": r["first_seen"],
                                                    "listings": 0, "confirmed": 0, "likely": 0})
        s["listings"] += 1
        s["confirmed"] += r["final"] == "CONFIRMED"
        s["likely"] += r["final"] == "LIKELY"
        if r["first_seen"] and (s["first_seen"] is None or r["first_seen"] < s["first_seen"]):
            s["first_seen"] = r["first_seen"]

    with db.cursor() as cur:
        cur.executemany(
            "INSERT INTO rh.sellers(seller_id, platform, name, profile_url, first_seen, listings_count, confirmed_count, likely_count) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (seller_id) DO UPDATE SET platform=EXCLUDED.platform, "
            "name=EXCLUDED.name, profile_url=EXCLUDED.profile_url, first_seen=LEAST(rh.sellers.first_seen, EXCLUDED.first_seen), "
            "listings_count=EXCLUDED.listings_count, confirmed_count=EXCLUDED.confirmed_count, likely_count=EXCLUDED.likely_count",
            [(s["seller_id"], s["platform"], s["name"], s["profile_url"], s["first_seen"], s["listings"], s["confirmed"],
              s["likely"]) for s in sellers.values()])
        # sellers whose listings disappeared and have no cases
        cur.execute("DELETE FROM rh.sellers s WHERE NOT (s.seller_id = ANY(%s)) "
                    "AND NOT EXISTS (SELECT 1 FROM rh.cases c WHERE c.seller_id = s.seller_id)", (list(sellers),))

        active = [r for r in rows if r["final"] in ACTIVE]
        opened = []
        for r in active:
            cid = case_id_for(r["listing_id"])
            cur.execute(
                "INSERT INTO rh.cases(case_id, listing_id, seller_id, recall_id, platform, status, severity) "
                "VALUES (%s,%s,%s,%s,%s,'open',%s) ON CONFLICT DO NOTHING RETURNING case_id",
                (cid, r["listing_id"], listing_seller[r["listing_id"]], r["recall_id"], r["platform"], r["final"]))
            if cur.fetchone():
                opened.append((cid, r))
        if opened:
            cur.executemany(
                "INSERT INTO rh.case_events(case_id, type, actor, payload) VALUES (%s,'opened','sync',%s)",
                [(cid, db.js({"listing_id": r["listing_id"], "severity": r["final"], "recall_id": r["recall_id"],
                              "seller_id": listing_seller[r["listing_id"]]})) for cid, r in opened])
        # keep severity / seller attribution in step with the latest verdicts (status is never touched here)
        cur.executemany("UPDATE rh.cases SET severity=%s, seller_id=%s WHERE listing_id=%s "
                        "AND (severity IS DISTINCT FROM %s OR seller_id IS DISTINCT FROM %s)",
                        [(r["final"], listing_seller[r["listing_id"]], r["listing_id"], r["final"],
                          listing_seller[r["listing_id"]]) for r in active])

    tot = db.q1("SELECT count(*) AS cases, count(*) FILTER (WHERE seller_id IS NULL) AS unattributed FROM rh.cases")
    return {"listings": len(rows), "sellers": len(sellers), "cases_opened": len(opened), "cases_total": tot["cases"],
            "cases_unattributed": tot["unattributed"],
            "listings_without_seller": sum(1 for v in listing_seller.values() if v is None)}
