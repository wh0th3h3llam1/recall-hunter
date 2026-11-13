# RECALL HUNTER: Build Spec (2-hour version)

> Recalled products don't disappear. They get resold. Recall Hunter takes every new federal recall,
> hunts the marketplaces for listings still selling it, confirms each match with evidence, and keeps
> re-checking until the listing is gone.

Sponsors (go deep, not wide): **Bright Data** (all collection) · **Tiger Data** (the only database) ·
**DigitalOcean** (agent runtime + hosting + evidence storage) · **Gemini API** (every decision: text, vision, label boxes, embeddings).
Optional: Sentry (5 minutes, raffle). **Not used:** Jev (no access), Snowflake (a second database adds risk and nothing the product needs).
HyperFrames is used only for the demo video, not in the product.

---

## 1. Why this matters: facts for the pitch

| Fact | Source |
|---|---|
| With only a press release, about **6%** of consumers act on a recall. With direct notice, about 50% | CPSC data FY2013–16 (Recall Effectiveness Workshop) |
| About **10%** of recalled children's products are ever fixed or destroyed | Kids In Danger (2012 finding) |
| 2021: **14 child deaths, 136 injuries, 6,058 incidents** reported *before* recalls were issued | Kids In Danger annual report |
| 2019: **38 child deaths** tied to recalled products, 37 of them inclined sleepers | Kids In Danger |
| Fisher-Price Rock 'n Play: **4.7M units**, about **100 deaths** linked, recall re-announced in 2023 after **8+ deaths after the recall**. Reselling it is illegal | CPSC recall 23-088 / CBS |
| CPSC sent **55,000 takedown requests** to resale sites in one year. That's manual, one listing at a time | Spotlight on America / Sinclair |
| PIRG **bought 30+ recalled toys** from Facebook Marketplace and eBay; some were recalled only days earlier | U.S. PIRG Trouble in Toyland 2022 |
| July 2024: CPSC ruled Amazon is a **distributor** responsible for recalling **400,000+** third-party products | CPSC / CBS / NBC |
| **Live today:** 62 new CPSC recalls since Oct 1, 2026, published every Thursday. They include Bodum French presses (**5.9M units**), a SHEIN baby rattle (choking, recalled **yesterday**), nursing pillows (suffocation), magnetic cubes (ingestion), unanchored dressers (tip-over), power banks and space heaters (fire) | `saferproducts.gov` API, pulled today |

**Hazard groups to color-code in the app:**

| Hazard | Examples from the live feed |
|---|---|
| Suffocation / sleep | Nursing pillows, inclined sleepers, loungers |
| Tip-over | Dressers |
| Ingestion | Magnets, water beads, button batteries |
| Choking | Small parts in toys and rattles |
| Fire / burn | Lithium-ion packs, power banks, heaters, fire pits |
| Flammability | Children's pajamas, rugs, mattresses |
| Entrapment | Playsets |
| Fall | Bikes, ladders, ATVs |

**Metrics our own app produces (the numbers on the demo dashboard):**
- Listings scanned, candidates, confirmed live
- **Days a listing has stayed up since the recall** (median per platform)
- Units affected
- Gemini decisions made, share escalated, cost per 1,000 decisions, latency (p50)

---

## 2. Product: two flows

### Flow A: Hunt (the regulator/journalist view) [DEMO CRITICAL]
1. **Ingest.** Pull CPSC recalls from the API into Tiger. Rank each recall by priority: child product, hazard severity, number of units.
2. **Hunt.** For the selected recall, build queries from the brand, product name and model numbers. Bright Data runs them across eBay, Facebook Marketplace (location-aware), Amazon and Google Shopping.
3. **Triage, in three tiers.** Flash-Lite screens each listing's text in bulk. Flash compares the recall photos with the listing photo and draws a box around the model label. Pro gets only the uncertain cases.
4. **Evidence.** Save a snapshot of the listing page to DigitalOcean Spaces and generate a pre-filled report for the platform's takedown form and for saferproducts.gov.
5. **Re-check.** The agent revisits confirmed listings on a schedule. Each visit is logged in Tiger, which produces the "still live after N days" number.

### Flow B: Home Check (the family view) [POLISH, build if there's time]
A parent photographs a product or its label. Gemini Flash reads the brand, model and date code. The photo is embedded with `gemini-embedding-2` (multimodal), Tiger finds candidate recalls by combining image-vector and keyword search, and Gemini Flash makes the final call:
**RECALLED / NOT RECALLED / CHECK LABEL**, with the remedy and refund link.

---

## 3. Exact sponsor usage

### Bright Data: every byte of collection

| Product | Call | What for |
|---|---|---|
| **Web Scraper API: Facebook Marketplace, discover by keyword** | `POST /datasets/v3/trigger?dataset_id=gd_lvt9iwuh6fbcwmx1a` with keyword + location, then poll the snapshot | Local resale, where most recalled baby gear gets resold |
| **Web Scraper API: Amazon** (verify the dataset ID in the Bright Data dashboard) | Discover by keyword | Third-party sellers (the Amazon distributor ruling) |
| **Web Unlocker** | `POST /request` with zone=unlocker on `ebay.com/sch/i.html?_nkw=<q>` (and Craigslist) | eBay search pages: parse title, price, image, URL |
| **SERP API** | Google Shopping and Google Images query for "<brand> <product>" | Long-tail stores, plus image-similarity hits |
| **Location targeting** | Country/city parameter on Unlocker and Marketplace location | "Sold 4 miles from you" |
| **Bright Data MCP** | Tool server attached to the DigitalOcean agent | The agent itself can search and scrape when queries need refining |

Budget: the free tier covers 5,000 Unlocker/SERP requests. The Scraper APIs are billed per record, so **ask the Bright Data team on site for hackathon credits right away; they're the host.**
Cache: every raw response is stored in Tiger (`raw_pages`) and never re-fetched during the demo.

### Gemini API: every decision (key from AI Studio, Python SDK `google-genai`)
Model IDs were checked today on the AI Studio models page. Pin them in `.env` in case they change.

| Gemini feature | Model | Use |
|---|---|---|
| **Structured output** (JSON schema with enums) | `gemini-3.5-flash-lite` | **Tier 1, bulk text screen** for every candidate. Returns `{category: exact_recalled_model \| likely_variant \| different_product \| accessory_or_part \| insufficient_info, match_score 0–10, code_in_range: bool, remedy_applied: bool, confidence 0–1, reason}`. Cheap and fast |
| **Multimodal image comparison** | `gemini-3.8-flash` | **Tier 2, for listings that pass tier 1.** One call with the recall images + listing image + recall text: "same product?" Returns the same schema |
| **Object detection / bounding boxes** (`box_2d`, normalized 0–1000) | `gemini-3.8-flash` | Box around the model/lot label or the recalled part in the listing photo. Drawn in the UI as evidence |
| **Thinking + structured output** | `gemini-3.1-pro-preview` | **Tier 3, only when confidence < 0.75.** Careful ruling with a written reason |
| **Multimodal embeddings** | `gemini-embedding-2` | Embeds recall images and listing images in one shared space and stores them in Tiger. Catches **the same photo relisted under a new brand**, and powers Home Check by photo |
| **URL context** | Flash | Reads the full CPSC recall page to extract exact model/lot/date ranges the API leaves out |
| **Function calling** | Flash | [POLISH] The Hunter's planner: picks the next queries and platforms from the hits so far |
| **Batch mode** | Flash-Lite | [POLISH] Overnight re-screening of all open recalls at half price |

Routing: tier 1 drops obvious non-matches → tier 2 vision confirms → tier 3 only for uncertain cases.
The UI shows the funnel counter: *1,240 screened → 96 vision-checked → 11 escalated → 7 confirmed · $0.0X · p50 latency per tier.*
That's the Gemini pitch: the right model size for each decision.

### Tiger Data: the only database
- **Time-series table** `listing_observations`: every visit to every listing (live or gone, price). This is the source of "days still live after recall".
- **Live rolling aggregate** `platform_daily`: confirmed live listings and median days since recall, per platform per day. Drives the scoreboard.
- **Vector search** (pgvector / pgvectorscale) on listing image embeddings: catches the same product **relisted under a new brand**, and powers Home Check.
- **Keyword search** (BM25 via pg_textsearch, or Postgres full-text search as a fallback) on titles: exact model numbers like `DR-HSH015`.
- **Zero-copy fork**: snapshot a known-good demo state and run the live hunt in a fork, so you can reset in one command. Also say "we fork before every agent run; a bad run never pollutes the main database".
- **Tiger MCP**: used to build the schema during development (show this in the video). [POLISH] "Ask the data" box.

### DigitalOcean: agent runtime, inference, hosting, evidence

| Product | Use |
|---|---|
| **Managed Agents** | The **Hunter agent**. Tools: `cpsc_fetch`, Bright Data MCP, `tiger_sql`, `gemini_triage`, `save_evidence`. Runs the hunt and the scheduled re-checks |
| **Serverless Inference** | The agent's own reasoning model, plus writing the pre-filled report text. Gemini stays the judge |
| **App Platform** | FastAPI backend + frontend, with a scheduled job for re-checks |
| **Spaces** | Listing snapshots and images as evidence (S3-compatible) |

Fallback rule: if Managed Agents isn't working within 15 minutes, run the same loop as a worker on App Platform with Serverless Inference. That still counts as DigitalOcean. Don't burn time on it.

---

## 4. Architecture

```
CPSC API ──▶ ingest ──▶ Tiger.recalls
                            │
             DO Managed Agent "Hunter"
                            │ queries
        ┌───────────────────┼───────────────────┐
  BD Marketplace API   BD Unlocker (eBay)   BD SERP (Shopping)
        └───────────────────┼───────────────────┘
                            ▼
                     Tiger.listings (+raw_pages)
                            ▼
        Gemini tier 1: Flash-Lite text screen (structured JSON)
                            ▼ passes
        Gemini tier 2: Flash vision compare + label box_2d
                  │ conf ≥ .75          │ conf < .75
                  ▼                     ▼
              verdicts  ◀──  Gemini tier 3: Pro ruling
        (gemini-embedding-2 image vectors ▶ Tiger vector index)
                            ▼
              DO Spaces snapshot + report text
                            ▼
          re-check job ▶ Tiger.listing_observations
                            ▼
        live rolling aggregate ▶ API ▶ UI dashboard
```

Stack: Python 3.12, FastAPI, httpx, psycopg 3, boto3 (Spaces), a minimal Vite/React or plain HTML UI.

### Env
```
TIGER_DATABASE_URL=
BRIGHTDATA_API_TOKEN=
BRIGHTDATA_UNLOCKER_ZONE=
BRIGHTDATA_SERP_ZONE=
GEMINI_API_KEY=
GEMINI_MODEL_SCREEN=gemini-3.5-flash-lite
GEMINI_MODEL_VISION=gemini-3.8-flash
GEMINI_MODEL_JUDGE=gemini-3.1-pro-preview
GEMINI_MODEL_EMBED=gemini-embedding-2
DO_INFERENCE_KEY=
DO_INFERENCE_BASE_URL=https://inference.do-ai.run/v1
DO_SPACES_KEY= DO_SPACES_SECRET= DO_SPACES_BUCKET= DO_SPACES_REGION=
```

### Schema (Tiger)
```sql
CREATE TABLE recalls (
  recall_id     int PRIMARY KEY,
  recall_number text, recall_date date, title text, description text,
  url text, product_name text, models text, units text,
  hazard text, hazard_class text, remedy text, image_urls text[],
  is_child_product bool, priority int
);

CREATE TABLE listings (
  listing_id   text PRIMARY KEY,          -- platform:native_id
  recall_id    int REFERENCES recalls,
  platform     text,                      -- ebay|fb_marketplace|amazon|shopping
  url text, title text, description text, price numeric,
  seller text, location text, image_url text,
  first_seen   timestamptz DEFAULT now(),
  embedding    vector(768)
);

CREATE TABLE verdicts (
  listing_id   text PRIMARY KEY REFERENCES listings,
  choice text, choice_conf real, match_score real,
  has_code_in_range real, remedy_applied real,
  label_box jsonb, escalated bool, vlm_reason text,
  final text,                              -- CONFIRMED|LIKELY|REJECTED
  tier_reached int, latency_ms int, decided_at timestamptz DEFAULT now(),
  evidence_url text, report_text text
);

CREATE TABLE listing_observations (
  observed_at timestamptz NOT NULL,
  listing_id  text NOT NULL,
  is_live     bool, price numeric, http_status int
);
SELECT create_hypertable('listing_observations', 'observed_at');

CREATE MATERIALIZED VIEW platform_daily WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', o.observed_at) AS day, l.platform,
       count(DISTINCT o.listing_id) FILTER (WHERE o.is_live) AS live_listings
FROM listing_observations o JOIN listings l USING (listing_id)
GROUP BY 1, 2;
-- "days live since recall" is computed in the API: now() - recalls.recall_date for live CONFIRMED listings

CREATE TABLE ai_calls (
  called_at timestamptz NOT NULL, model text, tier int, latency_ms int,
  input_tokens int, output_tokens int, cost_usd numeric
);
SELECT create_hypertable('ai_calls', 'called_at');
-- vector dimension: set listings.embedding to gemini-embedding-2's output size (check the docs, or request 768 via output_dimensionality)
```

### API
| Route | Does |
|---|---|
| `POST /api/recalls/sync` | Pull CPSC since a date and upsert |
| `GET /api/recalls?child=true` | Ranked list |
| `POST /api/hunt/{recall_id}` | Start a hunt (agent or worker); returns `run_id` |
| `GET /api/hunt/{run_id}/events` | Server-sent events: `candidate`, `verdict`, `escalated`, `evidence`, `done` |
| `GET /api/recalls/{id}/listings` | Listings with verdicts |
| `POST /api/recheck` | Re-visit confirmed listings and write observations |
| `GET /api/stats` | Scanned / confirmed / median days live / Gemini funnel, cost and latency per tier / per-platform |
| `POST /api/homecheck` | Photo → recall verdict [POLISH] |

CPSC call (verified working today, no auth):
`GET https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2026-10-01`
Fields: `RecallNumber, RecallDate, Title, Description, URL, Products[{Name, Model, Type, NumberOfUnits}], Images[{URL, Caption}], Hazards[{Name}], Injuries, Remedies, Retailers`.

---

## 5. Two-hour schedule

| Time | Person A: pipeline | Person B: Bright Data | Person C: UI + deploy |
|---|---|---|---|
| 0:00–0:15 | Keys (Gemini, Tiger, DO), schema, CPSC sync | Bright Data credits/zones, **go/no-go search** | DO account, Spaces bucket, App Platform skeleton |
| 0:15–0:50 | Gemini tier 1 + tier 2 (structured JSON + vision + `box_2d`) | eBay (Unlocker) + Marketplace (dataset) + SERP adapters → `listings` | Dashboard: recall list, listing stream, verdict badges, label boxes |
| 0:50–1:15 | Tier 3 Pro escalation, evidence, report text | Amazon + caching + `gemini-embedding-2` vectors → Tiger | Live stream wiring, stats panel with the Gemini funnel |
| 1:15–1:35 | Re-check job → observations, aggregate | Managed Agent with tools (fallback: worker) | Deploy to App Platform |
| 1:35–1:50 | Fork the demo DB, seed the hunts | Rehearse the live hunt | Record the HyperFrames video |
| 1:50–2:00 | **Submit.** Tick Bright Data, Tiger, DigitalOcean, Gemini, Overall (+ Sentry, HyperFrames) | | |

Solo or two people: cut Amazon, Home Check and tier 3 (Pro). Keep eBay + Marketplace + Gemini tiers 1–2 with label boxes + Tiger + Spaces.

### Go/no-go (first 10 minutes)
Search these through Bright Data (Unlocker on eBay, plus Marketplace):
`rock n play sleeper` · `bodum french press` · `magnetopia magnetic cubes` · `HAUOMS dresser` · `DREO DR-HSH015` · `kikea nursing pillow`.
Any live hits → GO. Rock 'n Play is the hero demo: about 100 deaths, illegal to resell.

---

## 6. Demo script (2 minutes)

| Time | Beat |
|---|---|
| 0:00 | **Hook.** "Rock 'n Play sleepers are linked to about 100 infant deaths. Reselling one is illegal. We found **N** for sale in the last hour, here are their locations." Show the map. |
| 0:15 | **The problem.** Only about 6% of consumers act on a recall notice. CPSC sends takedowns by hand: 55,000 in one year. |
| 0:30 | **Live.** Open today's CPSC feed: the SHEIN baby rattle recalled yesterday. Click **Hunt**. Bright Data results stream in from eBay, Marketplace and Google Shopping. |
| 0:55 | **Triage.** The Gemini funnel runs live: Flash-Lite screens hundreds of listings, Flash compares photos and **draws a box on the model label**, and one uncertain case goes to Pro, which writes its ruling. Counter: "640 screened → 41 vision-checked → 3 escalated → 6 confirmed, $0.0X." |
| 1:20 | **Evidence + relist catch.** A confirmed listing shows its snapshot in Spaces, the label box, and the pre-filled report. Then the image-vector search finds the **same photo under a different brand name**. |
| 1:35 | **Accountability.** Tiger scoreboard: "Recalled items stay up a median of X days, by platform." |
| 1:50 | **Close.** "Every Thursday CPSC publishes about 10 recalls. Recall Hunter is hunting them within minutes." |

**Real vs. seeded:** all recalls and listings are real and live. The only seeded part is the forked demo snapshot used as a backup, and it's labelled as such.

---

## 7. Pitch tips
- Lead with **one product and one number** (Rock 'n Play: about 100 deaths). Don't open with the architecture.
- Say each sponsor's role in one sentence, as it's used: "Bright Data is our eyes, Gemini is our judge, Tiger is our memory, DigitalOcean runs the hunter."
- Show the **Gemini funnel** (Flash-Lite → Flash → Pro) with cost and latency per tier. That proves deep, deliberate Gemini usage rather than one chat call.
- Be careful with wording: say "listings matching a recalled product", not "illegal sellers". Let the evidence speak.
- Have a **recorded backup** of the live hunt in case the venue Wi-Fi dies.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Bright Data dataset jobs take minutes | Trigger them at the start; use Unlocker on eBay for instant results; cache everything |
| Gemini rate limits on the free tier | Tier 1 batches 10 listings per call; cache verdicts by `listing_id`; log every call to `ai_calls` |
| A model ID changes | All IDs come from `.env`; fall back to `gemini-3.6-flash` / `gemini-3.1-flash-lite` |
| Managed Agents access blocked | App Platform worker + Serverless Inference after 15 minutes |
| False matches | Always show the confidence and the reason; never auto-file a report, a human clicks "report" |
