"""Recall index builder: rh.recalls -> rh.recall_index.
Gemini Flash-Lite extracts {brand, norm_name, category, models, upcs} (batches of 8), gemini-embedding-2 embeds
text + first recall image (both optional: a failed embedding is stored as NULL, never faked).
Run: .venv/Scripts/python -m app.v2.index"""
import asyncio
import re
import time
from typing import Optional

from pydantic import BaseModel, Field

from .. import db
from ..config import M_SCREEN, M_VISION
from ..gemini import funnel


class Extract(BaseModel):
    recall_id: int
    brand: str = Field(description="Brand name printed on the product (not the importer/retailer unless it is the brand). Empty if none.")
    norm_name: str = Field(description="Short normalized product name, lowercase, no brand, e.g. 'chambord french press coffee maker'")
    category: str = Field(description="Generic product category in 2-3 lowercase words, e.g. 'french press', 'nursing pillow', 'magnetic building blocks'")
    models: list[str] = Field(description="Model numbers, SKUs, item numbers or named model lines exactly as written in the recall. Empty list if none.")
    upcs: list[str] = Field(description="UPC/EAN barcodes (digits only) listed in the recall. Empty list if none.")


class ExtractOut(BaseModel):
    results: list[Extract]


def _clean_model(m: str) -> Optional[str]:
    m = re.sub(r"\s+", " ", (m or "").strip().upper()).strip(" .,;:()")
    return m if len(m) >= 3 else None


def _clean_upc(u: str) -> Optional[str]:
    d = re.sub(r"\D", "", u or "")
    return d if 8 <= len(d) <= 14 else None


def _prompt(recalls: list[dict]) -> str:
    parts = []
    for r in recalls:
        parts.append(f"RECALL_ID {r['recall_id']}\nTitle: {r['title']}\nProduct: {r.get('product_name') or ''}\n"
                     f"Models/codes: {(r.get('models') or '')[:800]}\nDescription: {(r.get('description') or '')[:1200]}")
    return ("Extract structured matching keys for each US CPSC recall below, one result per RECALL_ID. Only use facts "
            "stated in the text. models: every model number / SKU / item number, plus named model lines (e.g. Chambord) "
            "if the recall lists them. upcs: only barcodes explicitly given.\n\n" + "\n\n---\n\n".join(parts))


async def _extract(batch: list[dict]) -> dict[int, dict]:
    last = None
    for model in (M_SCREEN, M_VISION):  # Flash-Lite first; Flash as fallback if Lite is overloaded
        try:
            data, _ = await funnel._gen(model, "v2_index_extract", _prompt(batch), ExtractOut, records=len(batch),
                                        sample_extra={"recall_ids": [r["recall_id"] for r in batch]})
            return {int(x["recall_id"]): x for x in data.get("results") or []}
        except Exception as e:
            last = e
    print(f"[index] extract failed for {[r['recall_id'] for r in batch]}: {str(last)[:200]}")
    return {}


async def build(recall_ids: list[int] | None = None, embed: bool = True) -> dict:
    t0 = time.perf_counter()
    where, params = ("WHERE recall_id = ANY(%s)", (recall_ids,)) if recall_ids else ("", None)
    recalls = db.q(f"SELECT recall_id, title, product_name, models, description, image_urls FROM rh.recalls {where} "
                   "ORDER BY recall_id", params)
    batches = [recalls[i:i + 8] for i in range(0, len(recalls), 8)]
    sem = asyncio.Semaphore(4)

    async def run(b):
        async with sem:
            return await _extract(b)

    ext: dict[int, dict] = {}
    for res in await asyncio.gather(*[run(b) for b in batches]):
        ext.update(res)

    emb_sem = asyncio.Semaphore(6)
    stats = {"recalls": len(recalls), "extracted": 0, "text_emb": 0, "img_emb": 0, "written": 0, "errors": []}
    embed_dead = False

    async def one(r):
        nonlocal embed_dead
        x = ext.get(r["recall_id"])
        if not x:
            stats["errors"].append(f"no extraction for {r['recall_id']}")
            return
        stats["extracted"] += 1
        brand = (x.get("brand") or "").strip()
        name = (x.get("norm_name") or "").strip().lower()
        cat = (x.get("category") or "").strip().lower()
        models = sorted({m for m in map(_clean_model, x.get("models") or []) if m})
        # also keep raw model tokens from the CPSC field (digits-bearing), in case extraction dropped some
        for tok in re.findall(r"[A-Za-z0-9][A-Za-z0-9\-./]{3,}", r.get("models") or ""):
            if re.search(r"\d", tok):
                cm = _clean_model(tok)
                if cm:
                    models = sorted(set(models) | {cm})
        upcs = sorted({u for u in map(_clean_upc, x.get("upcs") or []) if u})
        keywords = " ".join(p for p in [brand, name, " ".join(models), cat] if p)
        temb = iemb = None
        if embed and not embed_dead:
            async with emb_sem:
                temb = await funnel.embed_text(f"{brand} {name} {cat}".strip())
                if temb is None:
                    embed_dead = True  # quota/outage: stop hammering, store NULLs
                imgs = r.get("image_urls") or []
                if imgs and not embed_dead:
                    iemb = await funnel.embed_image(imgs[0])
        stats["text_emb"] += temb is not None
        stats["img_emb"] += iemb is not None
        db.execute(
            """INSERT INTO rh.recall_index(recall_id, brand, norm_name, category, models, upcs, keywords, text_emb, img_emb, built_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s::vector,%s::vector, now())
               ON CONFLICT (recall_id) DO UPDATE SET brand=EXCLUDED.brand, norm_name=EXCLUDED.norm_name,
                 category=EXCLUDED.category, models=EXCLUDED.models, upcs=EXCLUDED.upcs, keywords=EXCLUDED.keywords,
                 text_emb=COALESCE(EXCLUDED.text_emb, rh.recall_index.text_emb),
                 img_emb=COALESCE(EXCLUDED.img_emb, rh.recall_index.img_emb), built_at=now()""",
            (r["recall_id"], brand, name, cat, models, upcs, keywords, db.vec(temb), db.vec(iemb)))
        stats["written"] += 1

    await asyncio.gather(*[one(r) for r in recalls])
    if embed and embed_dead:
        stats["errors"].append("embedding unavailable (see rh.api_calls gemini embed errors); text_emb/img_emb left NULL")
    stats["index_size"] = db.q1("SELECT count(*) n FROM rh.recall_index")["n"]
    stats["ms"] = int((time.perf_counter() - t0) * 1000)
    try:
        from . import match
        match.invalidate_index()
    except Exception:
        pass
    return stats


def main():
    db.open_pool()
    try:
        s = asyncio.run(build())
        print(s)
    finally:
        db.pool.close()


if __name__ == "__main__":
    main()
