# Recall Hunter

**A product was recalled, and it's still for sale.** Recall Hunter takes each new U.S. CPSC recall, hunts the marketplaces for live
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
