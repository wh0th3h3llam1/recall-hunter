"""/b2b: marketplace trust & safety console API (sellers, cases, notices, takedown verification, SLA, export)."""
import csv
import io
import time
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import db
from . import notice as notice_mod
from .sync import ACTIVE, run_sync, seller_kind

router = APIRouter(prefix="/b2b", tags=["b2b"])

STATUSES = ("open", "notified", "removed", "verified", "dismissed")
_ORDER = {"open": 0, "notified": 1, "removed": 2, "verified": 3}
_TS = {"notified": "notified_at", "removed": "removed_at", "verified": "verified_at"}
OPEN_STATES = ("open", "notified")

_CASE_SQL = """
SELECT c.case_id, c.listing_id, c.seller_id, coalesce(s.name, 'Unattributed') AS seller_name, s.profile_url AS seller_profile_url,
       c.recall_id, r.recall_number, r.title AS recall_title, r.product_name, r.hazard, r.hazard_class, r.remedy,
       r.url AS recall_url, c.platform, c.status, c.severity, c.opened_at, c.notified_at, c.removed_at, c.verified_at,
       c.assignee, c.notes, c.notice_text IS NOT NULL AS has_notice,
       l.url AS listing_url, l.title AS listing_title, l.image_url, l.price, l.currency, v.evidence_url, v.confidence,
       v.reason AS verdict_reason,
       round((extract(epoch FROM coalesce(c.removed_at, c.verified_at, now()) - c.opened_at) / 86400)::numeric, 2) AS days_open
FROM rh.cases c
JOIN rh.listings l USING (listing_id)
LEFT JOIN rh.verdicts v USING (listing_id)
LEFT JOIN rh.recalls r ON r.recall_id = c.recall_id
LEFT JOIN rh.sellers s ON s.seller_id = c.seller_id
"""


def _jsonable(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if isinstance(v, Decimal):
            v = float(v)
        out[k] = v
    return out


def _case(case_id: str) -> dict:
    row = db.q1(_CASE_SQL + " WHERE c.case_id = %s", (case_id,))
    if not row:
        raise HTTPException(404, f"case {case_id} not found")
    return _jsonable(row)


def _event(case_id: str, typ: str, actor: str, payload: dict | None = None):
    db.execute("INSERT INTO rh.case_events(case_id, type, actor, payload) VALUES (%s,%s,%s,%s)",
               (case_id, typ, actor, db.js(payload or {})))


# ------------------------------------------------------------------ sync / platforms
@router.post("/sync")
def sync():
    t0 = time.perf_counter()
    out = run_sync()
    out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    return out


@router.get("/platforms")
def platforms():
    rows = db.q("""
        WITH l AS (
          SELECT l.platform, count(*) AS listings,
                 count(*) FILTER (WHERE v.final = 'CONFIRMED') AS confirmed,
                 count(*) FILTER (WHERE v.final = 'LIKELY') AS likely
          FROM rh.listings l LEFT JOIN rh.verdicts v USING (listing_id) GROUP BY 1),
        s AS (SELECT platform, count(*) AS sellers FROM rh.sellers GROUP BY 1),
        c AS (SELECT platform, count(*) FILTER (WHERE status = ANY(%s)) AS open_cases, count(*) AS cases
              FROM rh.cases GROUP BY 1)
        SELECT l.platform, l.listings, l.confirmed, l.likely, coalesce(s.sellers, 0) AS sellers,
               coalesce(c.open_cases, 0) AS open_cases, coalesce(c.cases, 0) AS cases
        FROM l LEFT JOIN s USING (platform) LEFT JOIN c USING (platform)
        ORDER BY l.confirmed DESC, l.likely DESC, l.listings DESC""", (list(OPEN_STATES),))
    return rows


# ------------------------------------------------------------------ sellers
def _seller_rows(where: str, params: list, sort: str, limit: int) -> list[dict]:
    order = {"confirmed": "s.confirmed_count DESC, s.likely_count DESC",
             "likely": "s.likely_count DESC, s.confirmed_count DESC",
             "listings": "s.listings_count DESC, s.confirmed_count DESC"}.get(sort)
    if not order:
        raise HTTPException(400, "sort must be confirmed|likely|listings")
    rows = db.q(f"""
        SELECT s.seller_id, s.platform, s.name, s.profile_url, s.first_seen, s.listings_count, s.confirmed_count,
               s.likely_count,
               (SELECT count(*) FROM rh.cases c WHERE c.seller_id = s.seller_id AND c.status = ANY(%s)) AS open_cases,
               (SELECT count(*) FROM rh.cases c WHERE c.seller_id = s.seller_id) AS total_cases
        FROM rh.sellers s {where}
        ORDER BY {order}, s.seller_id LIMIT %s""", [list(OPEN_STATES), *params, limit])
    if not rows:
        return []
    ids = [r["seller_id"] for r in rows]
    recs = db.q("""
        SELECT c.seller_id, c.recall_id, r.title, r.hazard_class, count(*) AS count
        FROM rh.cases c LEFT JOIN rh.recalls r ON r.recall_id = c.recall_id
        WHERE c.seller_id = ANY(%s) AND c.status <> 'dismissed'
        GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC""", (ids,))
    by: dict[str, list] = {}
    for r in recs:
        by.setdefault(r.pop("seller_id"), []).append(r)
    for r in rows:
        r["kind"] = seller_kind(r["seller_id"], r["name"])
        r["recalls"] = by.get(r["seller_id"], [])
    return rows


@router.get("/sellers")
def sellers(platform: str | None = None, sort: str = "confirmed", limit: int = 100, include_clean: bool = False):
    where, params = ("WHERE TRUE" if include_clean else "WHERE (s.confirmed_count + s.likely_count) > 0"), []
    if platform:
        where += " AND s.platform = %s"
        params.append(platform)
    return _seller_rows(where, params, sort, max(1, min(limit, 1000)))


@router.get("/sellers/{seller_id:path}")
def seller_detail(seller_id: str):
    rows = _seller_rows("WHERE s.seller_id = %s", [seller_id], "confirmed", 1)
    if not rows:
        raise HTTPException(404, f"seller {seller_id} not found")
    s = rows[0]
    lst = db.q("""
        SELECT l.listing_id, l.recall_id, l.platform, l.url, l.title, l.price, l.currency, l.location, l.image_url,
               l.first_seen, l.seller,
               r.recall_number, r.title AS recall_title, r.hazard_class, r.url AS recall_url,
               v.final, v.category, v.match_score, v.confidence, v.reason, v.evidence_url, v.tier_reached, v.decided_at,
               c.case_id, c.status AS case_status
        FROM rh.listings l
        LEFT JOIN rh.verdicts v USING (listing_id)
        LEFT JOIN rh.recalls r ON r.recall_id = l.recall_id
        LEFT JOIN rh.cases c ON c.listing_id = l.listing_id
        WHERE l.platform = %s""", (s["platform"],))
    from .sync import seller_identity  # attribute listings exactly as sync does
    raw_rows = {r["listing_id"]: r for r in db.q(
        "SELECT listing_id, seller, jsonb_build_object('seller_name', raw->'seller_name', 'seller_url', raw->'seller_url', "
        "'store_name', raw->'store_name', 'seller_id', raw->'seller_id', 'profile_id', raw->'profile_id', 'shop', raw->'shop', "
        "'brand', raw->'brand', 'buybox_seller', raw->'buybox_seller', 'seller', raw->'seller') AS raw "
        "FROM rh.listings WHERE platform = %s", (s["platform"],))}
    out = []
    rank = {"CONFIRMED": 0, "LIKELY": 1, "REJECTED": 2, None: 3}
    for l in lst:
        rr = raw_rows[l["listing_id"]]
        raw = {k: v for k, v in (rr["raw"] or {}).items() if v is not None}
        ident = seller_identity(s["platform"], rr["seller"], raw)
        if not ident or ident["seller_id"] != seller_id:
            continue
        l = _jsonable(l)
        l["verdict"] = {k: l.pop(k) for k in ("final", "category", "match_score", "confidence", "reason", "evidence_url",
                                               "tier_reached", "decided_at")}
        out.append(l)
    out.sort(key=lambda x: rank.get(x["verdict"]["final"], 3))
    s["listings"] = out
    return s


# ------------------------------------------------------------------ cases
@router.get("/cases")
def cases(platform: str | None = None, status: str | None = None, seller_id: str | None = None, limit: int = 500):
    conds, params = [], []
    if platform:
        conds.append("c.platform = %s")
        params.append(platform)
    if status:
        sts = [x.strip() for x in status.split(",") if x.strip()]
        bad = [x for x in sts if x not in STATUSES]
        if bad:
            raise HTTPException(400, f"unknown status {bad}; use {'|'.join(STATUSES)}")
        conds.append("c.status = ANY(%s)")
        params.append(sts)
    if seller_id:
        conds.append("c.seller_id = %s")
        params.append(seller_id)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    rows = db.q(_CASE_SQL + where + " ORDER BY (c.severity = 'CONFIRMED') DESC, c.opened_at DESC, c.case_id LIMIT %s",
                [*params, max(1, min(limit, 5000))])
    return [_jsonable(r) for r in rows]


@router.get("/cases/{case_id}")
def case_detail(case_id: str):
    c = _case(case_id)
    c["notice_text"] = (db.q1("SELECT notice_text FROM rh.cases WHERE case_id=%s", (case_id,)) or {}).get("notice_text")
    c["events"] = db.q("SELECT at, type, actor, payload FROM rh.case_events WHERE case_id=%s ORDER BY at", (case_id,))
    return c


class CasePatch(BaseModel):
    status: str | None = None
    assignee: str | None = None
    notes: str | None = None


def set_status(case_id: str, new: str, actor: str, payload: dict | None = None) -> dict:
    """Move a case to `new`, stamping its *_at; moving back clears the later-stage stamps. Logs a case_event."""
    if new not in STATUSES:
        raise HTTPException(400, f"status must be one of {'|'.join(STATUSES)}")
    cur = db.q1("SELECT status FROM rh.cases WHERE case_id=%s", (case_id,))
    if not cur:
        raise HTTPException(404, f"case {case_id} not found")
    sets = ["status = %s"]
    params: list = [new]
    if new in _ORDER:
        for st, col in _TS.items():
            if _ORDER[st] <= _ORDER[new]:
                if st == new:
                    sets.append(f"{col} = coalesce({col}, now())")
            else:
                sets.append(f"{col} = NULL")
    db.execute(f"UPDATE rh.cases SET {', '.join(sets)} WHERE case_id = %s", [*params, case_id])
    if cur["status"] != new:
        typ = new if new in ("notified", "removed", "dismissed", "verified") else "reopened"
        _event(case_id, typ, actor, {"from": cur["status"], "to": new, **(payload or {})})
    return cur


@router.patch("/cases/{case_id}")
def patch_case(case_id: str, body: CasePatch):
    _case(case_id)  # 404
    if body.status is not None:
        set_status(case_id, body.status, "console")
    if body.assignee is not None:
        db.execute("UPDATE rh.cases SET assignee=%s WHERE case_id=%s", (body.assignee or None, case_id))
        _event(case_id, "assigned", "console", {"assignee": body.assignee})
    if body.notes is not None:
        db.execute("UPDATE rh.cases SET notes=%s WHERE case_id=%s", (body.notes, case_id))
        _event(case_id, "note", "console", {"notes": body.notes[:2000]})
    return _case(case_id)


@router.post("/cases/{case_id}/notice")
async def draft_notice(case_id: str):
    c = _case(case_id)
    d = await notice_mod.draft(c)
    if not d["notice_text"]:
        raise HTTPException(502, "notice generation returned empty text")
    db.execute("UPDATE rh.cases SET notice_text=%s WHERE case_id=%s", (d["notice_text"], case_id))
    _event(case_id, "notice_drafted", "console",
           {"model": d["model"], "provider": d["provider"], "latency_ms": d["latency_ms"],
            "chars": len(d["notice_text"]), **({"fallback_error": d["fallback_error"]} if d.get("fallback_error") else {})})
    return {"notice_text": d["notice_text"], "model": d["model"], "provider": d["provider"], "latency_ms": d["latency_ms"]}


@router.post("/cases/{case_id}/verify")
async def verify(case_id: str):
    from .. import sources
    from ..sources import check_live
    c = _case(case_id)
    l = db.q1("SELECT listing_id, url, raw, recall_id, platform, price FROM rh.listings WHERE listing_id=%s", (c["listing_id"],))
    t0 = time.perf_counter()
    is_live, http_status = await check_live({"url": l["url"], "raw": l["raw"] or {}})
    ms = int((time.perf_counter() - t0) * 1000)
    via = "brightdata_web_unlocker" if getattr(sources, "_zone_ok", None) else "direct_get"
    try:
        db.execute("INSERT INTO rh.listing_observations(observed_at, listing_id, recall_id, platform, is_live, price, http_status) "
                   "VALUES (now(),%s,%s,%s,%s,%s,%s)", (l["listing_id"], l["recall_id"], l["platform"], is_live,
                                                        l["price"], http_status))
    except Exception as e:  # observation history is a nice-to-have
        print("[b2b] listing_observations insert failed:", e)
    payload = {"is_live": is_live, "http_status": http_status, "via": via, "latency_ms": ms, "url": l["url"]}
    _event(case_id, "verify_live" if is_live else "verify_gone", "console", payload)
    status = c["status"]
    if not is_live and c["status"] in ("open", "notified"):
        set_status(case_id, "removed", "verify", {"http_status": http_status})
        status = "removed"
    return {"is_live": is_live, "http_status": http_status, "status": status, "via": via, "latency_ms": ms}


# ------------------------------------------------------------------ SLA
@router.get("/sla")
def sla(platform: str | None = None):
    where, params = ("WHERE platform = %s", [platform]) if platform else ("", [])
    r = db.q1(f"""
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM notified_at - opened_at) / 3600)
            FILTER (WHERE notified_at IS NOT NULL) AS median_hours_to_notify,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM removed_at - coalesce(notified_at, opened_at)) / 3600)
            FILTER (WHERE removed_at IS NOT NULL) AS median_hours_to_removal,
          count(*) FILTER (WHERE notified_at IS NOT NULL) AS n_notified_ever,
          count(*) FILTER (WHERE removed_at IS NOT NULL AND removed_at - notified_at <= interval '48 hours') AS n_removed_48h,
          count(*) FILTER (WHERE status = 'open') AS open,
          count(*) FILTER (WHERE status = 'notified') AS notified,
          count(*) FILTER (WHERE status = 'removed') AS removed,
          count(*) FILTER (WHERE status = 'verified') AS verified,
          count(*) FILTER (WHERE status = 'dismissed') AS dismissed,
          count(*) AS total
        FROM rh.cases {where}""", params)
    rep = db.q(f"""
        SELECT c.seller_id, s.name, s.platform, count(*) AS open_cases
        FROM rh.cases c JOIN rh.sellers s USING (seller_id)
        WHERE c.status = ANY(%s) AND c.severity = ANY(%s) {"AND c.platform = %s" if platform else ""}
        GROUP BY 1, 2, 3 HAVING count(*) >= 2 ORDER BY count(*) DESC, c.seller_id""",
               [list(OPEN_STATES), list(ACTIVE), *params])
    n_not = r.pop("n_notified_ever")
    n48 = r.pop("n_removed_48h")
    for k in ("median_hours_to_notify", "median_hours_to_removal"):
        r[k] = round(float(r[k]), 2) if r[k] is not None else None
    r["pct_removed_48h"] = round(100.0 * n48 / n_not, 1) if n_not else None
    r["notified_ever"] = n_not
    r["repeat_offenders"] = len(rep)
    r["repeat_offender_list"] = rep
    r["platform"] = platform
    return r


# ------------------------------------------------------------------ catalog upload
_CSV_FIELDS = ("id", "title", "brand", "model", "image_url", "url", "seller")


@router.post("/catalog/upload")
async def catalog_upload(file: UploadFile = File(...), site: str = Form("catalog")):
    try:
        from ..v2.match import match_products
    except Exception as e:
        raise HTTPException(503, f"engine not ready: {type(e).__name__}: {str(e)[:200]}")
    data = await file.read()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "title" not in [f.strip().lower() for f in reader.fieldnames]:
        raise HTTPException(400, f"CSV needs a header with at least 'title' (expected {','.join(_CSV_FIELDS)})")
    rows = []
    for i, raw in enumerate(reader):
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        if not row.get("title"):
            continue
        rows.append({"product_id": row.get("id") or f"row{i + 1}", "title": row["title"], "brand": row.get("brand", ""),
                     "model": row.get("model", ""), "image_url": row.get("image_url", ""), "url": row.get("url", ""),
                     "upc": row.get("upc", ""), "price": row.get("price", ""), "seller": row.get("seller", "")})
    if len(rows) > 2000:
        raise HTTPException(413, "max 2000 rows per upload")
    t0 = time.perf_counter()
    results = []
    for i in range(0, len(rows), 40):  # /v2/match contract: <= 40 products per call
        chunk = rows[i:i + 40]
        out = await match_products(site, chunk, "")
        meta = {r["product_id"]: r for r in chunk}
        for res in out.get("results") or []:
            src = meta.get(res.get("product_id"), {})
            results.append({**res, "title": src.get("title"), "seller": src.get("seller"), "url": src.get("url")})
    flagged = sum(1 for r in results if r.get("status") in ("recalled", "possible"))
    return {"rows": len(rows), "flagged": flagged,
            "recalled": sum(1 for r in results if r.get("status") == "recalled"),
            "latency_ms": int((time.perf_counter() - t0) * 1000), "results": results}


# ------------------------------------------------------------------ CSV export
_REPORT_COLS = ["case_id", "status", "severity", "platform", "seller_id", "seller_name", "seller_profile_url",
                "recall_number", "recall_title", "hazard_class", "recall_url", "listing_id", "listing_title",
                "listing_url", "price", "currency", "evidence_url", "confidence", "opened_at", "notified_at",
                "removed_at", "verified_at", "days_open", "assignee", "notes"]


@router.get("/report.csv")
def report_csv(platform: str | None = None, status: str | None = None):
    rows = cases(platform=platform, status=status, limit=5000)

    def gen():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(_REPORT_COLS)
        for r in rows:
            w.writerow(["" if r.get(k) is None else (r[k].isoformat() if isinstance(r[k], datetime) else r[k])
                        for k in _REPORT_COLS])
            if buf.tell() > 32768:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    name = f"recall-hunter-cases-{platform or 'all'}-{stamp}.csv"
    return StreamingResponse(gen(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
