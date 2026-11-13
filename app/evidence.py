"""Evidence packets: listing + verdict + neutral CPSC-style report. Local JSON, or DO Spaces when configured."""
import asyncio
import json
import re
import time
from datetime import datetime, timezone

from . import config, db, obs


def safe_id(listing_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", listing_id or "unknown")[:120]


def report_text(listing: dict, verdict: dict, recall_number) -> str:
    conf = verdict.get("confidence")
    lines = [
        f"Listing appears to offer a product matching CPSC recall #{recall_number}.",
        f"Platform: {listing.get('platform')}. Listing URL: {listing.get('url')}",
        f"Listing title: {listing.get('title')}",
        f"Seller: {listing.get('seller') or 'unknown'}. Location: {listing.get('location') or 'unknown'}. "
        f"Price: {listing.get('price') if listing.get('price') is not None else 'n/a'} {listing.get('currency') or ''}".rstrip(),
        f"Automated assessment: {verdict.get('final')} ({verdict.get('category')}, confidence "
        f"{conf:.2f} at tier {verdict.get('tier_reached')})." if isinstance(conf, (int, float)) else
        f"Automated assessment: {verdict.get('final')} ({verdict.get('category')}).",
        f"Basis: {verdict.get('reason') or ''}",
        "This report was generated automatically and has not been verified by a person. Under the Consumer Product "
        "Safety Act it is unlawful to sell a recalled product; please review the listing.",
    ]
    return "\n".join(lines)


def _recall_number(listing: dict, verdict: dict):
    rn = verdict.get("recall_number") or listing.get("recall_number")
    if rn:
        return rn
    rid = verdict.get("recall_id") or listing.get("recall_id")
    if rid is None:
        return "unknown"
    try:
        row = db.q1("SELECT recall_number FROM rh.recalls WHERE recall_id=%s", (rid,))
        return (row or {}).get("recall_number") or rid
    except Exception:
        return rid


def _upload_spaces(key: str, body: bytes) -> str:
    import boto3
    s3 = boto3.client("s3", region_name=config.SPACES_REGION,
                      endpoint_url=f"https://{config.SPACES_REGION}.digitaloceanspaces.com",
                      aws_access_key_id=config.SPACES_KEY, aws_secret_access_key=config.SPACES_SECRET)
    s3.put_object(Bucket=config.SPACES_BUCKET, Key=key, Body=body, ACL="public-read", ContentType="application/json")
    return f"https://{config.SPACES_BUCKET}.{config.SPACES_REGION}.digitaloceanspaces.com/{key}"


async def save(listing: dict, verdict: dict) -> str:
    sid = safe_id(listing.get("listing_id"))
    rn = await asyncio.to_thread(_recall_number, listing, verdict)
    lst = {k: v for k, v in listing.items() if k not in ("raw", "embedding")}
    doc = {
        "listing": lst, "verdict": verdict, "recall_number": rn,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "report_text": report_text(listing, verdict, rn),
    }
    body = json.dumps(doc, default=str, indent=2).encode()
    (config.EVIDENCE_DIR / f"{sid}.json").write_bytes(body)
    verdict["report_text"] = doc["report_text"]
    if config.SPACES_KEY and config.SPACES_SECRET and config.SPACES_BUCKET:
        t0 = time.perf_counter()
        try:
            url = await asyncio.to_thread(_upload_spaces, f"evidence/{sid}.json", body)
            obs.log_call("digitalocean", "spaces", "PutObject", "200", int((time.perf_counter() - t0) * 1000), 1, 0.0,
                         {"key": f"evidence/{sid}.json", "bytes": len(body)})
            return url
        except Exception as e:
            obs.log_call("digitalocean", "spaces", "PutObject", "error", int((time.perf_counter() - t0) * 1000), 0, 0.0,
                         {"error": str(e)[:200]})
            obs.capture(e)
    return f"/evidence/{sid}.json"
