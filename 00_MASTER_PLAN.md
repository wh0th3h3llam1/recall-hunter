# RECALL HUNTER: Master Build Plan (2 hours, awaiting approval)

**One line:** a recall was issued, and the product is still for sale. Recall Hunter takes each new CPSC recall, hunts
the marketplaces for live listings with Bright Data, confirms matches with a three-model Gemini funnel, stores everything in
Tiger, runs the hunt as an agent on DigitalOcean, and shows the result as a 3D map of hazards still for sale.

Product detail, statistics and pitch: `RECALL_HUNTER_SPEC.md`. This file covers **how we build it in 120 minutes**.

---

## 0. Checked before planning (read-only probes, nothing built yet)

| Item | Result |
|---|---|
| Gemini key | ✅ Works. Available: `gemini-3.5-flash-lite`, `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-3.1-pro-preview`, `gemini-embedding-2` |
| Tiger DB | ✅ Connects. Postgres 18.6, **timescaledb 2.32 installed**; `vector`, `vectorscale`, `pg_textsearch` available (we'll enable them). Public schema has only 2 system tables, so we use our own schema `rh` |
| CPSC API | ✅ Public, no auth. 62 recalls since Oct 1, 2026 |
| Bright Data key | ⚠️ Valid, but **0 active zones**, and the key **lacks permission** for the balance endpoint, so it may also lack permission to create zones. See §6 |
| Local tools | Python 3.13, Node 22, git. **No** Docker, gh, doctl or psql. Deployment plan below avoids needing them |

---

## 1. Sponsor tracks and exactly what earns each one

| Track | What we ship | Evidence in the UI |
|---|---|---|
| **Best Overall** | Working end-to-end hunt on real recalls and real listings | Live demo |
| **Bright Data** | Web Unlocker (eBay and Craigslist search pages), SERP API (Google Shopping), Web Scraper API (Facebook Marketplace by keyword + location, plus Amazon), location targeting, Bright Data MCP as a tool for the Hunter agent | "Proof" drawer: last real call per product with status, latency and record count |
| **Gemini** | `3.5-flash-lite` batch text screen (fixed-format JSON) → `3.5-flash` photo comparison + `box_2d` label boxes → `3.1-pro-preview` rulings → `gemini-embedding-2` multimodal image vectors → URL-context reading of recall pages | The funnel counter, the label box drawn on the photo, the Pro ruling text |
| **Tiger Data** | Time-series tables (`listing_observations`, `api_calls`), a live rolling aggregate (`platform_daily`), pgvector + vectorscale image search (catching relisted items), BM25 model-number search, a fork for demo reset (if Tiger console credentials are given) | Scoreboard, "same photo, different brand" hit, a SQL panel |
| **DigitalOcean** | Hunter agent (Managed Agents if the preview API responds within 10 minutes; otherwise an agent loop on DO Serverless Inference running on a Droplet), Serverless Inference for report drafting, **Spaces** for evidence and the app bundle, a **Droplet** hosting the app | Public URL on a DO IP, evidence links on Spaces, agent run log |
| **Sentry** | `sentry-sdk` in FastAPI with tracing spans per pipeline stage, Sentry browser SDK in the UI, a cron monitor on the re-check job | Trace screenshot in the submission |
| **Snowflake** [STRETCH] | After each hunt, sync verdicts to Snowflake. A Cortex `AI_COMPLETE` call over the table produces a "Regulator Brief" panel | Brief panel labelled "Snowflake Cortex". **Cut at T+80 if it isn't working** |
| **Software Factory** | We build it with a contract-first multi-agent factory: 5 agents with separate file ownership, shared contracts, a proof log of real calls, and a Playwright QA gate. Documented in `FACTORY.md` | `FACTORY.md` + `PROGRESS.md` |
| **HyperFrames** | Demo video written as an HTML composition from real screenshots and rendered with `npx hyperframes` | The MP4 |
| System One | ❌ Skipped (no Jev access, per your instruction) | — |

Rule: nothing is labelled live unless the call actually ran. Cached results say "cached from live run at HH:MM".

---

## 2. Architecture

```
            ┌──────────── DigitalOcean Droplet (Ubuntu, systemd) ────────────┐
CPSC API ──▶│ FastAPI  /api/*   + static 3D frontend (Vite build)             │
            │   ├─ ingest.py        CPSC → rh.recalls                          │
            │   ├─ hunter/agent.py  DO agent loop (tools below)                │──▶ Sentry
            │   │    tools: search_marketplaces (Bright Data adapters)          │
            │   │           triage (Gemini funnel)                              │
            │   │           save_evidence (Spaces)  sql (Tiger)                 │
            │   ├─ recheck.py       re-visits confirmed listings → observations│
            │   └─ snowflake_sync.py [stretch]                                 │
            └─────────────────────────────────────────────────────────────────┘
                 │ Bright Data APIs        │ Gemini API        │ Tiger (rh schema)   │ DO Spaces
```

Stack: Python 3.13 + FastAPI + httpx + psycopg 3 + google-genai + boto3 + sentry-sdk (+ snowflake-connector).
Frontend: Vite + React + TypeScript + @react-three/fiber + drei, plus d3-geo and us-atlas for the map. FastAPI serves the built files, so there's one process and one URL.

**Deployment without Docker or gh:** zip the app, upload it to Spaces, create a Droplet through the DO API with a cloud-init script that downloads the zip, installs dependencies and starts systemd. Fallback: run locally, which is fine for a desktop demo, and show DO through Spaces, inference and the agent.

---

## 3. Data contracts (frozen at T+10; every agent codes against these)

**Schema `rh`:**
- `recalls(recall_id pk, recall_number, recall_date, title, description, url, product_name, models, units, hazard, hazard_class, remedy, image_urls text[], is_child bool, priority int)`
- `listings(listing_id pk 'platform:id', recall_id fk, platform, url, title, description, price, seller, location, lat, lon, image_url, first_seen, embedding vector(768))` with a vectorscale diskann index and a BM25 index on `title`
- `verdicts(listing_id pk, category, match_score, code_in_range, remedy_applied, confidence, tier_reached, label_box jsonb, reason, final 'CONFIRMED|LIKELY|REJECTED', evidence_url, report_text, decided_at)`
- `listing_observations(observed_at, listing_id, is_live, price, http_status)`, a hypertable
- `api_calls(called_at, sponsor, product, endpoint, status, latency_ms, records, cost_usd, sample jsonb)`, a hypertable (feeds the Proof drawer)
- `platform_daily`, a continuous aggregate of live confirmed listings per platform per day
- `hunt_runs(run_id pk, recall_id, started_at, status, stats jsonb)`

**API:**
| Route | Returns |
|---|---|
| `GET /api/recalls?child=` | Ranked recalls with hazard class and live-listing counts |
| `POST /api/hunt/{recall_id}` | `{run_id}` and starts the agent |
| `GET /api/hunt/{run_id}/events` | Server-sent events: `query`, `candidate`, `screened`, `vision`, `escalated`, `verdict`, `evidence`, `done` |
| `GET /api/listings?recall_id=` | Listings, verdicts and coordinates |
| `GET /api/stats` | Totals, Gemini funnel, median days live since recall, per platform |
| `GET /api/proof` | Last real call per sponsor product |
| `POST /api/recheck` | Re-check results |
| `POST /api/homecheck` (multipart photo) | Recall match [POLISH] |
| `GET /api/brief` | Snowflake Cortex brief [STRETCH] |

**Hazard classes** (these drive colors on the map): `suffocation`, `tip_over`, `ingestion`, `choking`, `fire_burn`, `flammability`, `entrapment`, `fall`, `other`.

---

## 4. Agents and file ownership (no two agents edit the same file)

| Agent | Owns | Tasks |
|---|---|---|
| **Lead (me)** | `contracts/`, `.env`, `db/schema.sql`, `app/main.py`, `PROGRESS.md`, `FACTORY.md`, `README.md` | Scaffold, schema, CPSC ingest, integration, merges, final run-through |
| **A: 3D UI** | `web/**` | 3D US map, hazard pillars, the funnel panel, listing evidence card with the label box, Proof drawer, loading/empty/error states, reduced-motion fallback |
| **B: Pipeline** | `app/gemini/**`, `app/hunter/**`, `app/recheck.py` | Gemini funnel tiers 1–3 + embeddings + url_context, agent loop on DO inference, live event stream |
| **C: Bright Data** | `app/sources/**` | Zone setup or dataset path, eBay/Craigslist via Unlocker, Google Shopping via SERP, Marketplace and Amazon via the Scraper API, caching into Tiger, writing to `api_calls` |
| **D: Infra/sponsors** | `deploy/**`, `app/evidence.py`, `app/snowflake_sync.py`, `app/obs.py` | Spaces, Droplet deploy, Sentry, Managed Agents probe, Snowflake stretch |
| **E: QA/demo** | `qa/**`, `video/**` | Playwright run on the live app: screenshots, console and network errors, clicking every control; then the HyperFrames composition |

---

## 5. Timeline (T = the moment you approve)

| T+ | Milestone | Gate (must pass) |
|---|---|---|
| 0–10 | Scaffold, `.env`, enable extensions, apply schema, ingest CPSC (from 2019 so Rock 'n Play is included), Bright Data access probe, Gemini smoke test | Recalls in the DB; one real Gemini call logged |
| 10–55 | Agents A, B, C and D work in parallel against the contracts | Each adapter returns real data into Tiger |
| 55–75 | **Integration:** run real hunts on 3 hero recalls, end to end | At least one CONFIRMED listing with evidence and a label box |
| 75–90 | Deploy to the Droplet; Sentry traces checked; Snowflake brief or cut | Public URL works |
| 90–105 | Agent E: Playwright QA, then fix the top 3 defects and re-test | PASS/FAIL report with screenshots |
| 105–120 | README, FACTORY.md, submission text, demo script; HyperFrames video if time allows | Submitted |

**Hero recalls:** Fisher-Price Rock 'n Play (about 100 deaths, resale illegal), Bodum French press (5.9M units, recalled Oct 29), SHEIN baby rattle (choking, recalled Nov 12). Backups: Magnetopia magnetic cubes, Kikea nursing pillow, DREO DR-HSH015 heater.

**Cut order if behind:** Snowflake → Home Check → Amazon → Tiger fork → Managed Agents (keep the inference loop) → Droplet (demo locally).
**Never cut:** Bright Data real calls, the Gemini funnel, Tiger, the 3D map, the evidence card, the Proof drawer.

---

## 6. Bright Data access plan (the main risk)
1. Probe `GET /zone/get_active_zones`, `POST /zone` (create `rh_unlocker` and `rh_serp`) and `GET /datasets/list`.
2. If zone creation is refused, use the **Web Scraper API** only (needs just the token): Facebook Marketplace `gd_lvt9iwuh6fbcwmx1a` by keyword, plus the eBay and Amazon keyword datasets found through `/datasets/list`.
3. If the token can't do either, I'll keep building everything else, and the README will state exactly what permission is missing. Fastest fix: give an **admin-permission token**, or create the zones `rh_unlocker` (Web Unlocker) and `rh_serp` (SERP API) in the dashboard.

Creating the zones changes your Bright Data account configuration. Approving this plan approves creating those two zones. They're billed on use; the 5,000 free requests cover the demo.

---

## 7. What I still need from you (paste with your approval)
| Needed for | What |
|---|---|
| DigitalOcean | **API token** (read/write), **Spaces access key + secret**, **model access key** for Serverless Inference |
| Sentry | **DSN** (one project, Python/FastAPI is fine) |
| Snowflake [stretch] | Account identifier, user, password (a trial account is fine) |
| Tiger fork [optional] | Tiger Cloud project ID + client access key/secret (from the Tiger console) |
| Bright Data | Nothing more unless §6 step 3 happens |

If something is missing, I build around it and mark that integration NOT DONE. I won't fake it.

**Security:** keys go only into `recall-hunter/.env` (gitignored) and are never printed or committed. They were pasted into this chat, so **rotate all of them after the event.**
