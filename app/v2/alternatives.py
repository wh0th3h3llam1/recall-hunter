"""Safe alternatives for a recalled product (/v2/alternatives).
Bright Data SERP API (Google Shopping) for the recall's category -> drop anything that matches the recall index
(stage-1 brand/model signals) -> Gemini Flash-Lite picks the top 3 with a one-line safety note that only repeats
facts in the listing title. Cached per recall_id for 24 h in rh.alt_cache."""
import datetime as dt
import json
from typing import Optional

import httpx
from pydantic import BaseModel, Field

from .. import db, sources
from ..config import M_SCREEN, M_VISION
from ..gemini import funnel
from . import match

TTL_H = 24
_table_ready = False


def _ensure_table():
    global _table_ready
    if not _table_ready:
        db.execute("""CREATE TABLE IF NOT EXISTS rh.alt_cache (
                        recall_id int PRIMARY KEY, payload jsonb NOT NULL, built_at timestamptz DEFAULT now())""")
        _table_ready = True


class Pick(BaseModel):
    idx: int
    safety_note: Optional[str] = Field(None, description="One short line stating ONLY a safety fact written in that listing's "
                                                         "title (e.g. 'Title states BPA-free'); null if the title states none")


class Picks(BaseModel):
    picks: list[Pick] = Field(description="Best 3 alternatives, best first")


def _generic_note() -> str:
    return f"Not on the CPSC recall list as of {dt.date.today().isoformat()}"


async def get_alternatives(recall_id: int, title: str = "") -> dict:
    _ensure_table()
    row = db.q1("SELECT payload FROM rh.alt_cache WHERE recall_id=%s AND built_at > now() - make_interval(hours => %s)",
                (recall_id, TTL_H))
    if row:
        return row["payload"]

    await match._index()
    rec = match._idx["by_id"].get(int(recall_id))
    if not rec:
        return {"category": None, "items": [], "error": "recall not in index"}
    category = (rec.get("category") or rec.get("norm_name") or "").strip()
    async with httpx.AsyncClient() as client:
        raw = await sources._serp_shopping(client, category)
    items = [{"title": r.get("title"), "price": r.get("final_price"), "shop": r.get("shop"), "url": r.get("url"),
              "image": r.get("image")} for r in raw if r.get("title")]

    # drop anything that looks like ANY recalled product (brand/model match), and dupes
    cands = await match.stage1([{"title": it["title"]} for it in items]) if items else []
    seen, safe = set(), []
    for it, c in zip(items, cands):
        key = (it["title"] or "").lower()[:80]
        if key in seen or (c is not None and c["kind"] in ("strong", "brand")):
            continue
        seen.add(key)
        safe.append(it)
    safe = safe[:20]
    dropped = len(items) - len(safe)

    picked: list[dict] = []
    if safe:
        lines = "\n".join(f"[{i}] {it['title']} | {it['price'] or ''} | {it['shop'] or ''}" for i, it in enumerate(safe))
        prompt = (f"A shopper looked at a recalled product: {rec.get('product_name')} (CPSC recall {rec.get('recall_number')}, "
                  f"hazard: {(rec.get('hazard') or '')[:200]}). They were viewing: {title or 'n/a'}.\n"
                  f"Pick the 3 best alternative products from this Google Shopping list: same kind of product "
                  f"('{category}'), not an accessory or part, from a different brand than '{rec.get('brand')}', "
                  f"reputable shop preferred. safety_note: only a safety-relevant fact literally present in that "
                  f"listing's title (material, certification, safety feature); otherwise null. Never invent claims.\n\n{lines}")
        data = None
        for model in (M_SCREEN, M_VISION):
            try:
                data, _ = await funnel._gen(model, "v2_alternatives", prompt, Picks, records=len(safe),
                                            sample_extra={"recall_id": recall_id, "n": len(safe)})
                break
            except Exception as e:
                print(f"[v2.alternatives] rank error ({model}): {str(e)[:200]}")
        used = set()
        for pk in (data or {}).get("picks") or []:
            i = pk.get("idx")
            if isinstance(i, int) and 0 <= i < len(safe) and i not in used:
                used.add(i)
                note = (pk.get("safety_note") or "").strip() or _generic_note()
                picked.append({**safe[i], "safety_note": note[:160]})
            if len(picked) == 3:
                break
        if not picked:  # ranking failed: fall back to SERP order, generic note (still real SERP items)
            picked = [{**it, "safety_note": _generic_note()} for it in safe[:3]]

    out = {"category": category, "items": picked, "query": category, "serp_results": len(items),
           "filtered_out": dropped, "note": "Suggestions, not endorsements."}
    if picked:
        db.execute("""INSERT INTO rh.alt_cache(recall_id, payload, built_at) VALUES (%s, %s::jsonb, now())
                      ON CONFLICT (recall_id) DO UPDATE SET payload=EXCLUDED.payload, built_at=now()""",
                   (recall_id, json.dumps(out, default=str)))
    return out
