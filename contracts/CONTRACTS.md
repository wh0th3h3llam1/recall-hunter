# Shared Contracts (frozen; changes only by the lead)

Root: `D:\Code\Hackathons\recall-hunter`. Python venv: `.venv/Scripts/python` (Windows, Git Bash). The `.env` holds the keys and is already loaded by `app/config.py`. **Never print or commit secrets.**
DB: Tiger (Postgres 18 + timescaledb + vector + vectorscale diskann + pg_textsearch bm25), schema `rh` already created: see `db/schema.sql`.
Helpers: `app/db.py` (`q`, `q1`, `execute`, `vec`, `js`), `app/obs.py` (`log_call`, `span`, `capture`), `app/events.py` (`emit`, `make_emitter`, `stream`), `app/config.py`.

**Every external API call MUST call `obs.log_call(sponsor, product, endpoint, status, latency_ms, records, cost_usd, sample)`.** That feeds the Proof drawer.
sponsor ∈ `brightdata | gemini | tiger | digitalocean | sentry | snowflake | cpsc`.

## Ownership
| Owner | Files |
|---|---|
| Lead | `app/main.py`, `app/config.py`, `app/db.py`, `app/obs.py`, `app/events.py`, `app/ingest.py`, `db/**`, `contracts/**`, docs |
| A: 3D UI | `web/**` only |
| B: Pipeline | `app/gemini/**`, `app/hunter/**`, `app/evidence.py`, `app/recheck.py` |
| C: Bright Data | `app/sources/**` |

## Python module contracts

### `app/sources/__init__.py` (C)
```python
async def search_all(recall: dict, queries: list[str], emit) -> list[dict]
# recall = row from rh.recalls (dict). queries = 1..4 search strings.
# emit(type, data) for progress: emit("query", {"platform","query"}), emit("source_done", {"platform","count","status","ms"})
# Returns Listing dicts (NOT yet saved):
# { listing_id: "ebay:1234", platform: "ebay"|"fb_marketplace"|"amazon"|"google_shopping"|"craigslist",
#   url, title, description, price: float|None, currency, seller, location: str|None, image_url, raw: dict }
# Must cache raw responses under data/cache/<sha1>.json so a repeat run is instant (env RH_CACHE_ONLY=1 => never call network).
async def check_live(listing: dict) -> tuple[bool, int]   # (is_live, http_status) used by recheck
```

### `app/gemini/funnel.py` (B)
```python
async def make_queries(recall: dict) -> list[str]                         # 2-4 marketplace search strings (flash-lite)
async def triage(recall: dict, listings: list[dict], emit) -> list[dict]  # returns Verdict dicts
# Verdict: { listing_id, recall_id, category: exact_recalled_model|likely_variant|different_product|accessory_or_part|insufficient_info,
#   match_score 0-10, code_in_range bool|None, remedy_applied bool|None, confidence 0-1, tier_reached 1|2|3,
#   label_box: {box_2d:[ymin,xmin,ymax,xmax] 0-1000, label} | None, reason, final: CONFIRMED|LIKELY|REJECTED, latency_ms }
# Tier 1: M_SCREEN batch of <=10 listings per call, structured JSON. Drop category in (different_product) with conf>=.7 -> REJECTED.
# Tier 2: M_VISION per surviving listing with recall images + listing image -> same schema + label_box.
# Tier 3: M_JUDGE when tier-2 confidence < 0.75.
# emit("screened", {...counts}), emit("vision", {listing_id,...}), emit("escalated", {listing_id}), emit("verdict", Verdict)
async def embed_image(url: str) -> list[float] | None                     # M_EMBED, 768 dims
async def geocode(locations: list[str]) -> dict[str, tuple[float,float]]   # flash-lite structured lat/lon for "City, ST"
```

### `app/hunter/agent.py` (B)
```python
async def run_hunt(run_id: str, recall_id: int) -> dict
# 1 make_queries -> 2 sources.search_all -> 3 upsert rh.listings (+geocode lat/lon, +embedding) -> 4 triage -> 5 upsert rh.verdicts
# -> 6 evidence.save for CONFIRMED/LIKELY -> 7 insert rh.listing_observations (is_live=true) -> 8 emit("done", stats)
# Uses events.make_emitter(run_id). Writes rh.hunt_runs. If DO_INFERENCE_KEY set, planner step uses DO Serverless Inference (OpenAI-compatible), else Gemini.
```

### `app/evidence.py` (B)
```python
async def save(listing: dict, verdict: dict) -> str   # returns URL; DO Spaces if keys set, else local data/evidence/<id>.json served at /evidence/<id>.json
```

## HTTP API (lead implements in app/main.py; UI consumes)
Base `http://localhost:8000`. JSON.
- `GET /api/recalls?child=0|1&limit=50` → `[{recall_id, recall_number, recall_date, title, product_name, hazard, hazard_class, units, image_urls, is_child, priority, url, live_count, confirmed_count}]` sorted by priority desc
- `GET /api/recalls/{id}` → recall + `listings: [Listing+verdict fields]`
- `POST /api/hunt/{recall_id}` → `{run_id}`
- `GET /api/hunt/{run_id}/events` → SSE. Event types: `start, query, source_done, candidate, screened, vision, escalated, verdict, evidence, done, error`. Each payload `{type, ts, data}`
- `GET /api/listings?recall_id=&final=` → `[{listing_id, recall_id, platform, url, title, price, seller, location, lat, lon, image_url, first_seen, category, match_score, confidence, tier_reached, label_box, reason, final, evidence_url, days_since_recall}]`
- `GET /api/stats` → `{recalls, listings_scanned, confirmed, likely, rejected, median_days_live, funnel:{screened, vision, escalated, confirmed}, by_platform:[{platform, confirmed, live}], by_hazard:[{hazard_class, confirmed}], gemini:{calls, cost_usd, p50_ms_by_tier:{1,2,3}}}`
- `GET /api/proof` → `[{sponsor, product, endpoint, status, latency_ms, records, called_at, sample}]`: last call per sponsor+product, plus `configured:{digitalocean:bool, sentry:bool, snowflake:bool}`
- `POST /api/recheck` → `{checked, live, gone}`
- `GET /evidence/{file}` → evidence JSON

hazard_class colors (UI): suffocation, tip_over, ingestion, choking, fire_burn, flammability, entrapment, fall, shock, laceration, other.
