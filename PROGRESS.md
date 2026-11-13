# PROGRESS: 2026-11-13

## RESUME HERE
Server: `RH_BD_WAIT_S=90 .venv/Scripts/python -m uvicorn app.main:app --port 8000` → http://localhost:8000
Hero recalls: SHEIN teething toys (10977, 3 confirmed), Bodum French press (11041), Magnetopia cubes (11049).

## Verified (real calls, with evidence)
- CPSC API → 80 recalls in Tiger. The API is flaky (503s and "provider failed on Open"), so the Rock 'n Play lookup failed and was skipped.
- Bright Data: Web Scraper API (Amazon, eBay, FB Marketplace, Google Shopping), SERP API zone `rh_serp`, Web Unlocker zone `rh_unlocker`. Both zones were created with the user's approval. About 860 successful calls logged.
- Gemini three-tier funnel: positive control → CONFIRMED at confidence 0.95 with a box_2d; negative control → REJECTED at tier 1. A live SHEIN hunt produced 122 candidates → 24 photo-checked → 9 escalated → **3 CONFIRMED**, 9 LIKELY.
- Tiger: hypertables, continuous aggregate, diskann vector index, BM25 index all created and in use.
- Sentry: DSN set, spans wrap each hunt stage.
- UI (browser QA at 1440×900, no console errors):
  - PASS: recall select filters the map, counts and funnel.
  - PASS: listings row opens the Evidence card. Real eBay Bodum listing, CONFIRMED at tier 2, Gemini box "BODUM BRAND ENGRAVING ON GLASS", 15 days still for sale.
  - PASS: HUNT from the UI streams live events, the funnel counts up, DONE refreshes the pillars (Magnetopia: 127 candidates, 26 LIKELY).
  - NOT TESTED: reduced-motion mode, widths below desktop.
- Totals: 11 CONFIRMED / 73+ LIKELY across 3 recalls; about 1,000 Bright Data and about 1,300 Gemini calls logged.

## Partly working
- FB Marketplace and eBay dataset jobs take 3–7 minutes and often hit the 90 s cap. Pending jobs are collected on the next run.
- Gemini free-tier quota: `gemini-3.5-flash`, `3.6-flash`, `4-argon` and `3.1-pro-preview` return 429 at times. The fallback chain uses `gemini-4-hydrogen` and `3.5-flash-lite`.

## Resolved / not built
- **DigitalOcean:** ✅ Serverless Inference works. The user-created model key runs `openai-gpt-oss-120b`, which plans the marketplace queries for each hunt (logged in `rh.api_calls`, about 6–8 s). ✅ Spaces: bucket `recall-hunter-evidence-4720` (sfo3). New hunts upload evidence there; 94 earlier files were copied up. The evidence card links to the public URL. No Droplet deploy, so this is a local demo.
- **Firefox without WebGL:** ✅ fixed. A WebGL check, a 2D SVG map fallback and an error boundary are in place, verified with `?nowebgl=1`.
- **Snowflake:** no credentials; not built.
- **System One (Jev):** skipped at the user's request.

## v2 (branch `v2-extension`), verified
- `/v2/match`: 40 clean cards p95 300 ms cold, 80 ms cached. Smoke set TP=4 FP=0 TN=38 FN=0 after Stage 2. Gemini 429s leave a product `possible` (uncached) and retry next time.
- Brand-match fix: the index had brand "HAUOM" for HAUOMS dressers; the brand regex now allows a trailing "s"/"'s".
- `/v2/alternatives` (Bodum): 3 real Google Shopping items via Bright Data SERP, 12 s cold.
- `/b2b` smoke: 224 sellers, 167 cases, a notice drafted by DO gpt-oss-120b (about 20 s), verify via Unlocker (eBay listing still live, HTTP 200), SLA, CSV, catalog upload.
- Extension: typecheck + Chrome/Firefox builds pass. On the DOM fixture with the live API, 3/3 recalled cards were tagged and 5/5 ordinary cards stayed clean; the product-page banner showed CPSC #27055 with 3 alternatives. Not yet loaded as a real unpacked extension on live amazon.com.

- **Deployed:** https://recall-hunter-ay2po.ondigitalocean.app (DO App Platform, sfo, from branch `v2-extension` via Dockerfile). Checked: /api/health db ok, /v2/health index 80, console 200, /v2/match Bodum → recalled at Stage 2 (1.3 s), Hydro Flask → clean, /b2b/sla.

## Agents
| Agent | Owns | State |
|---|---|---|
| A: 3D UI | `web/**` | Done; QA fixes in progress (map scale, per-recall filter, pillar hit areas, listing list) |
| B: Pipeline | `app/gemini`, `app/hunter`, `app/evidence.py`, `app/recheck.py` | Done |
| C: Bright Data | `app/sources` | Done; lead added the SERP fast path |
| Lead | API, schema, ingest, docs | Done |
