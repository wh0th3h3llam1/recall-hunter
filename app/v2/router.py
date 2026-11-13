"""/v2 routes for the Recall Guard extension (see contracts/CONTRACTS_V2.md)."""
import asyncio
import datetime as dt
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db, obs

router = APIRouter(prefix="/v2", tags=["v2"])


class Product(BaseModel):
    product_id: Optional[str] = ""
    title: Optional[str] = ""
    brand: Optional[str] = ""
    price: Optional[str] = ""
    image_url: Optional[str] = ""
    model: Optional[str] = ""
    upc: Optional[str] = ""
    url: Optional[str] = ""


class MatchReq(BaseModel):
    site: str = "unknown"
    page_url: str = ""
    products: list[Product] = Field(default_factory=list)


@router.post("/match")
async def v2_match(req: MatchReq):
    if len(req.products) > 40:
        raise HTTPException(413, "at most 40 products per request")
    from .match import match_products
    with obs.span("v2.match", f"{req.site} n={len(req.products)}"):
        return await match_products(req.site, [p.model_dump() for p in req.products], req.page_url)


@router.get("/alternatives")
async def v2_alternatives(recall_id: int, title: str = ""):
    from .alternatives import get_alternatives
    out = await get_alternatives(recall_id, title)
    if out.get("error") == "recall not in index":
        raise HTTPException(404, "recall not in index")
    return out


@router.get("/recalls/updates")
def v2_recall_updates(since: Optional[str] = None):
    try:
        d = dt.date.fromisoformat(since[:10]) if since else dt.date.today() - dt.timedelta(days=7)
    except ValueError:
        raise HTTPException(400, "since must be an ISO date/datetime")
    rows = db.q("""SELECT recall_id, recall_number, title, hazard_class, recall_date, url, is_child FROM rh.recalls
                   WHERE recall_date >= %s ORDER BY recall_date DESC, recall_id DESC""", (d,))
    for r in rows:
        r["recall_date"] = r["recall_date"].isoformat() if r["recall_date"] else None
    return rows


@router.get("/health")
def v2_health():
    n = db.q1("SELECT count(*) n FROM rh.recall_index")["n"]
    return {"ok": True, "index_size": n}


_rebuild: dict = {"task": None, "last": None}


@router.post("/index/rebuild")
async def v2_index_rebuild(wait: bool = False):
    """Rebuilds rh.recall_index. Runs in the background unless ?wait=true (takes ~15 s for 80 recalls)."""
    from . import index
    t = _rebuild.get("task")
    if t is not None and not t.done():
        return {"started": False, "running": True, "last": _rebuild["last"]}

    async def go():
        _rebuild["last"] = await index.build()
        return _rebuild["last"]

    _rebuild["task"] = asyncio.create_task(go())
    if wait:
        return {"started": True, "running": False, "result": await _rebuild["task"]}
    return {"started": True, "running": True, "last": _rebuild["last"]}
