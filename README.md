# Recall Hunter

**A product was recalled, and it's still for sale.** Recall Hunter ships as two products on one engine:

| | Who | What |
|---|---|---|
| **Recall Guard** (`extension/`) | Shoppers (B2C) | A Chrome/Firefox extension that tags recalled products **while you scroll** Amazon, eBay, Walmart, Target or any schema.org store, warns "do not buy", and suggests safer alternatives |
| **Trust & Safety console** (`web/`) | Marketplaces (B2B) | Finds recalled listings and the sellers behind them, opens a case per listing, drafts a takedown notice for a human to send, and re-checks that the listing came down |

**Live:** console and API at https://recall-hunter-ay2po.ondigitalocean.app (DigitalOcean App Platform). The extension uses it by default.

Under both: Recall Hunter takes each new U.S. CPSC recall, hunts the marketplaces for live
listings with **Bright Data**, confirms matches with a three-tier **Gemini** funnel (text screen → photo comparison with a label
bounding box → careful ruling), stores everything in **Tiger Data**, and shows the result as a 3D "hazard cartography" map.

Why it matters: about **6%** of consumers act on a recall notice, about **10%** of recalled children's products are ever fixed or
destroyed, and CPSC sends takedown requests to resale sites by hand (**55,000** in one year). Sources are in `RECALL_HUNTER_SPEC.md`.

## Run
```bash
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt selectolax
cd web && npm install && npm run build && cd ..
.venv/Scripts/python -m app.ingest            # pull CPSC recalls into Tiger
RH_BD_WAIT_S=90 .venv/Scripts/python -m uvicorn app.main:app --port 8000
# open http://localhost:8000  → pick a recall → HUNT
```
Env (`.env`, gitignored): `TIGER_DATABASE_URL, BRIGHTDATA_API_TOKEN, BRIGHTDATA_UNLOCKER_ZONE, BRIGHTDATA_SERP_ZONE,
GEMINI_API_KEY, GEMINI_MODEL_*, SENTRY_DSN, DO_*`.
Cache replay (no network, for an offline demo): `RH_CACHE_ONLY=1`. It replays raw Bright Data responses captured live earlier.

## v2 API
- `POST /v2/match`: up to 40 store cards → `clean | possible | recalled`. Stage 1 runs on Tiger only (BM25 + brand/model rules over `rh.recall_index`), **p95 about 300 ms for 40 cards**. Stage 2 (Gemini) confirms candidates in the background and the result is cached for 7 days (`rh.product_verdicts`). Measured on the smoke set: precision 1.00, recall 1.00 after Stage 2.
- `GET /v2/alternatives`: safer alternatives from Bright Data SERP Google Shopping, filtered against the recall index and cached for 24 h.
- `/b2b/*`: platforms, sellers, cases (open → notified → removed → verified), SLA, CSV report, catalog CSV upload. Notices are drafted by DigitalOcean `openai-gpt-oss-120b`; **nothing is sent automatically**, and a human marks a case as sent. Verify re-checks the listing through the Bright Data Web Unlocker.
- Full contract: `contracts/CONTRACTS_V2.md`. Smoke tests: `python -m app.v2._smoke`, `python -m app.b2b._smoke`.

## Deploy
`Dockerfile` (builds the web UI, runs uvicorn on :8080) → DigitalOcean App Platform via `deploy/do_app.py <branch>`, which sends secrets as encrypted SECRET env vars. `deploy/status.py --wait` shows the deployment phase and URL.

## Sponsor usage: what really runs
| Sponsor | Used for | Status |
|---|---|---|
| **Bright Data** | Web Scraper API datasets: Amazon product search, eBay keyword discovery, Facebook Marketplace by keyword × 5 cities, Google Shopping. **SERP API** zone `rh_serp` (Google Shopping JSON, the fast path). **Web Unlocker** zone `rh_unlocker` (checking whether a listing is still live) | ✅ Real calls; 860+ successful calls logged in `rh.api_calls` |
| **Gemini** | `gemini-3.5-flash-lite` batch screen + query planning + geocoding · `gemini-3.5-flash` / `gemini-4-hydrogen` photo comparison returning `box_2d` label boxes · `gemini-3.1-pro-preview` judge (falls back to other models on quota limits) · `gemini-embedding-2` multimodal image vectors | ✅ Real; the key hit free-tier 429s on some models, which the fallback chain handles |
| **Tiger Data** | `rh` schema: hypertables `listing_observations` and `api_calls`, a live rolling aggregate `platform_daily`, **pgvector + vectorscale diskann** image search (`/api/similar`), **pg_textsearch BM25** model-number search (`/api/search`) | ✅ |
| **Sentry** | `sentry-sdk` with tracing; a span for each hunt stage (plan, search, triage, evidence) | ✅ DSN configured |
| **DigitalOcean** | Serverless Inference (`openai-gpt-oss-120b`) plans the marketplace search queries for each hunt; Spaces for evidence files (`app/evidence.py`) | ✅ Inference and Spaces are real and logged (bucket `recall-hunter-evidence-4720`, public evidence JSON) |
| **Snowflake** | Stretch | ❌ Not built: no credentials |

## Honesty rules
- Nothing in the product path is mocked. The UI has a DEV-only fixture (`web/src/dev/fixtures.ts`, `?fixture=1` in dev only) with a red "SYNTHETIC" banner, and it is excluded from the build.
- The **Proof** drawer shows the last real call per sponsor product, straight from `rh.api_calls`.
- Verdicts are machine-generated leads, not legal findings. The UI says "listing appears to match", and a human files the report.
