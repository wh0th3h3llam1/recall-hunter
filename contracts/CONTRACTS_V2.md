# v2 Contracts (frozen; changes only by the lead)
Read `contracts/CONTRACTS.md` (v1) and `01_V2_PLAN.md` first. Repo root: `D:\Code\Hackathons\recall-hunter`, branch `v2-extension`.
Python venv: `.venv/Scripts/python` (the server runs on :8000 and must be restarted by the lead to load new routers).
v2 tables (already created, see `db/schema_v2.sql`): `rh.recall_index`, `rh.product_verdicts`, `rh.match_requests` (hypertable),
`rh.sellers`, `rh.cases`, `rh.case_events` (hypertable). Helpers: `app/db.py`, `app/obs.py` (`log_call` for EVERY external call),
`app/gemini/funnel.py` (`embed_text`, `embed_image`, `fetch_image`, `_gen`, model fallback chains), `app/sources` (Bright Data), `app/config.py`.
NEVER print or commit secrets. NEVER commit; the lead commits.

## Ownership
| Owner | Files |
|---|---|
| Lead | `app/main.py`, `app/config.py`, `db/**`, `contracts/**`, docs, `deploy/**`, `.do/**` |
| E1: Engine | `app/v2/**` (router at `app/v2/router.py`, exported `router = APIRouter(prefix="/v2")`) |
| E2: Extension | `extension/**` |
| E3: B2B backend | `app/b2b/**` (router at `app/b2b/router.py`, exported `router = APIRouter(prefix="/b2b")`) |
| E4: Console UI | `web/**` |

## /v2 (E1)
`POST /v2/match`
```json
req:  {"site":"amazon.com","page_url":"https://...","products":[
        {"product_id":"B0XXXX","title":"...","brand":"...","price":"$24.99","image_url":"https://...","model":"","upc":"","url":"https://..."}]}   // ≤40
resp: {"results":[{"product_id":"B0XXXX","status":"clean|possible|recalled",
        "recall":{"recall_id":11041,"recall_number":"27055","title":"...","product_name":"...","hazard":"...","hazard_class":"fire_burn",
                  "remedy":"...","url":"https://www.cpsc.gov/...","recall_date":"2026-10-29","units":"About 5.9 million","image":"https://..."},
        "confidence":0.92,"reason":"...","stage":1|2|3}],
       "latency_ms":123,"cache_hits":7}
```
Rules: `recall` is null when clean. `recalled` only if exact/variant with confidence ≥ 0.8; otherwise a match is `possible`. p95 under 600 ms for 40 clean cards (Stage 1 is Tiger only). Stage 2 (Gemini) runs only for candidates; if it's slow, return `possible` now and finish in the background, updating the cache. Cache in `rh.product_verdicts` (7-day expiry). Log each request in `rh.match_requests`.
`GET /v2/alternatives?recall_id=&title=` → `{"category":"french press","items":[{"title","price","shop","url","image","safety_note"}]}` (≤3, from Bright Data SERP Google Shopping, filtered against the recall index, ranked by Gemini Flash-Lite). Cache per recall_id for 24 h.
`GET /v2/recalls/updates?since=ISO` → `[{recall_id, recall_number, title, hazard_class, recall_date, url, is_child}]`
`GET /v2/health` → `{"ok":true,"index_size":N}`
`POST /v2/index/rebuild` → rebuilds `rh.recall_index` (Gemini Flash-Lite extracts brand/models/category/upcs; `gemini-embedding-2` text + image embeddings). `app/v2/index.py` is also runnable as `python -m app.v2.index`.

## /b2b (E3)
- `GET /b2b/platforms` → `[{platform, listings, confirmed, likely, sellers, open_cases}]`
- `GET /b2b/sellers?platform=&sort=confirmed|likely|listings&limit=` → `[{seller_id, platform, name, profile_url, listings_count, confirmed_count, likely_count, open_cases, recalls:[{recall_id,title,hazard_class,count}]}]`
- `GET /b2b/sellers/{seller_id}` → seller + `listings:[listing + verdict + case_id + case_status]`
- `GET /b2b/cases?platform=&status=` → `[{case_id, listing_id, seller_id, seller_name, recall_id, recall_number, recall_title, hazard_class, platform, status, severity, opened_at, notified_at, removed_at, verified_at, listing_url, listing_title, image_url, price, evidence_url, days_open}]`
- `PATCH /b2b/cases/{case_id}` body `{status?, assignee?, notes?}` → case (records a `case_events` row; sets the *_at timestamps)
- `POST /b2b/cases/{case_id}/notice` → `{notice_text, model}`. DO Serverless Inference `openai-gpt-oss-120b` (config.DO_INFERENCE_KEY, base config.DO_INFERENCE_BASE_URL, OpenAI chat format; it's a reasoning model, so max_tokens ≥ 1500 and read `message.content`). Falls back to Gemini Flash-Lite. Stores `cases.notice_text`, logs the event. **Never sends anything.**
- `POST /b2b/cases/{case_id}/verify` → runs `app.sources.check_live` (Bright Data Web Unlocker) → `{is_live, http_status, status}`. If gone, sets status `removed` + removed_at; logs `verify_gone`/`verify_live`.
- `POST /b2b/sync` → (re)build `rh.sellers` from `rh.listings` and open a case for every CONFIRMED/LIKELY verdict that has none. Idempotent.
- `GET /b2b/sla?platform=` → `{median_hours_to_notify, median_hours_to_removal, pct_removed_48h, open, notified, removed, verified, repeat_offenders}`
- `POST /b2b/catalog/upload` (multipart CSV: id,title,brand,model,image_url,url,seller) → runs `app.v2.match.match_products` on every row → `{rows, flagged, results:[...]}`. Import E1's function lazily.
- `GET /b2b/report.csv?platform=` → CSV of cases + evidence URLs.

## Python function contract between E1 and E3
`app/v2/match.py`: `async def match_products(site: str, products: list[dict], page_url: str = "") -> dict` returns the `/v2/match` response body.

## Extension (E2) → API
API base is configurable in the popup (default `http://localhost:8000`; the deployed DO URL will be added by the lead). It uses `/v2/match`, `/v2/alternatives` and `/v2/recalls/updates`. CORS is open on the server.
