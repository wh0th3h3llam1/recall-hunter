# Recall Hunter v2: one recall engine, two products (awaiting approval)

v1 (git tag `v1-b2b-console`) proved the engine: CPSC recalls → Bright Data marketplace search → three-tier Gemini match →
Tiger history → evidence on DO Spaces. v2 turns it into two products that share one backend:

| | **Recall Guard** (B2C browser extension) | **Recall Hunter Console** (B2B, evolves the v1 UI) |
|---|---|---|
| User | A shopper browsing Amazon, eBay, Walmart, Target, Facebook Marketplace | Trust & safety teams at a marketplace (eBay, Amazon, Etsy…) |
| Job | "Don't let me buy a recalled product; show me a safe alternative" | "Find recalled products in *our* catalog, see which sellers list them, get them taken down, prove it" |
| Moment | Products get tagged as you scroll; a red banner on a recalled product page | A seller-by-seller case queue; one-click seller notice; time-to-takedown metrics |
| Money | Free (trust builder; optional retailer partnerships later) | SaaS per monitored catalog, plus an API |

---

## 1. Shared backend: "Recall Engine"
v1's FastAPI app becomes the engine, with two new API surfaces. Everything in v1 keeps working.

### 1a. Fast matching for the extension (must answer in under about 600 ms per batch)
Calling Gemini on every product card while someone scrolls is too slow and too expensive. So we **pre-index** and use Gemini only to confirm:
1. **Recall index (built ahead of time, in Tiger):** each recall's brand, model numbers, UPCs, normalized product name, a text embedding and an image embedding (`gemini-embedding-2`). Rebuilt when CPSC publishes (Thursdays), plus a nightly job.
2. **Stage 1, a cheap filter (Tiger only, ~20 ms):** exact model/UPC/ASIN match (BM25 + exact) **or** text-embedding similarity above a threshold → candidate recalls. About 99% of cards stop here as "clean".
3. **Stage 2, confirmation (only for candidates):** `gemini-3.5-flash-lite` structured verdict (same rubric as v1 tier 1). If it says exact/variant, run a `gemini-3.5-flash` photo check in the background and update the badge.
4. **Cache** by `(site, product_id)` in Tiger (`rh.product_verdicts`, 7-day expiry), so the same product is never re-judged.

### 1b. Safe alternatives
For a recalled or likely product:
- Bright Data **SERP API** (Google Shopping) for the same category, e.g. "nursing pillow", from Gemini's category extraction.
- Each result goes through Stage 1 against the recall index, and any recalled ones are dropped.
- Gemini 3.5 Flash-Lite ranks the top 3 with a one-line safety note ("meets ASTM F3669 for infant pillows", only when the listing states it).
- Labelled **"Suggestions, not endorsements."** No affiliate links in v2.

### 1c. B2B case management (new tables)
- `rh.sellers(seller_id, platform, name, profile_url, first_seen, listings_count, confirmed_count)`
- `rh.cases(case_id, listing_id, seller_id, recall_id, status: open|notified|removed|verified|dismissed, opened_at, notified_at, removed_at, verified_at, assignee, notes)`
- `rh.case_events(at, case_id, type, actor, payload)`, a hypertable used as the audit trail
- A continuous aggregate `case_sla_daily`: median time to notify, time to takedown, and repeat offenders

### 1d. New API (contract)
| Route | For | Does |
|---|---|---|
| `POST /v2/match` | extension | Body: `{site, page_url, products:[{product_id, title, brand?, price?, image_url?, model?, upc?, url}]}` (≤ 40). Returns `[{product_id, status: clean\|possible\|recalled, recall:{id, number, title, hazard, hazard_class, remedy, url, recall_date}?, confidence, reason}]` |
| `GET /v2/alternatives?recall_id=&title=` | extension | `[{title, price, shop, url, image, safety_note}]` (≤ 3) |
| `GET /v2/recalls/updates?since=` | extension | New recalls since the timestamp (for the popup's "new this week") |
| `GET /b2b/sellers?platform=&sort=` | console | Sellers ranked by confirmed recalled listings |
| `GET /b2b/cases?status=` / `PATCH /b2b/cases/{id}` | console | Case queue, status changes |
| `POST /b2b/cases/{id}/notice` | console | DO Serverless Inference (`gpt-oss-120b`) drafts the seller notice (cites the CPSC recall number, hazard, remedy, the listing URL, a removal request). Returns a draft; **nothing is sent automatically**, a human clicks "Mark as sent" |
| `POST /b2b/scan` | console | Monitor a seller's storefront or a keyword: Bright Data datasets (eBay seller/store discovery, Amazon search) |
| `POST /b2b/catalog/upload` | console | CSV of the marketplace's own listings (id, title, brand, model, image) matched in bulk through 1a. This is how a real marketplace would plug in |
| `GET /b2b/report.csv` | console | Export of cases + evidence URLs for regulators |

Hosting (needed so the extension can reach a public URL): **DigitalOcean App Platform** from this GitHub repo (after the push), or a Droplet as a fallback. Secrets live in App Platform environment variables, never in the repo.

---

## 2. Recall Guard: browser extension (B2C)
**Stack:** Manifest V3, TypeScript, Vite (`@crxjs/vite-plugin` or a plain multi-entry build). Chrome and **Firefox** builds (MV3 + `browser_specific_settings`; the user demos on Firefox). No WebGL needed.

### How it works on a page
1. **Content script**, injected on supported sites. Each site gets a small **adapter** (selectors for product cards and the product page):
   - Amazon search/product (ASIN from `data-asin`)
   - eBay search/item (`/itm/<id>`)
   - Walmart, Target
   - Facebook Marketplace (title and image only)
   - **Generic fallback** on any other store: schema.org `Product` JSON-LD, `og:` tags, `itemprop` attributes.
2. An **IntersectionObserver** batches cards as they scroll into view (every 300 ms, up to 40), then calls `POST /v2/match` through the background service worker (one place for retries and the cache).
3. **Badges** are injected into each card inside a Shadow DOM, so the site's CSS can't break them:
   - 🟥 **RECALLED: DO NOT BUY** (hazard icon + short hazard, e.g. "Suffocation risk")
   - 🟧 **Possible recall match: check model**
   - Nothing on clean items (no noise)
4. **Product page:** a full-width warning banner with the hazard, recall date, units, the remedy ("Stop using, contact Bodum for a free replacement carafe"), "View CPSC notice ↗" and **3 safe alternatives** (from `/v2/alternatives`).
5. **Toolbar popup:**
   - The count of recalls flagged on the current tab
   - An on/off switch for each site
   - A "children's products only" mode
   - New recalls this week
   - A "Report a listing" link
6. **Privacy:** only the product card fields are sent: no browsing history, no cookies, no account. A local cache in `chrome.storage.local` avoids re-asking. This is stated in the popup.

### Extension visual direction (matches v1, adapted to sit on someone else's site)
Badges are compact federal-notice tags: bone (#E8E3D6) chips with a hazard-colored left rule, JetBrains Mono uppercase, and a small hazard glyph. They stay readable on Amazon's white and on eBay's busy layouts. The banner looks like a printed recall notice with a perforated edge. The popup is a mini "survey sheet" with the counts in Instrument Serif. The full 3D map stays in the console.

---

## 3. Recall Hunter Console: the v1 UI becomes the marketplace product
Kept: the recall rail, 3D/2D hazard map, hunt log, Gemini funnel, evidence card, Proof drawer.
**Added:**
- A **tenant switch**, "Monitoring: eBay", which filters all views to one platform (each platform is a "tenant" in the demo, with no logins in v2).
- A **Sellers view:** a table plus a 3D "seller constellation" option where sellers are nodes sized by recalled listings, edges link sellers selling the same recall, and repeat offenders glow. Click a seller to see their listings, history and an "Open cases".
- A **Case queue** (kanban by status): open → notified → removed → verified. "Draft notice" opens the DO-written notice for editing, with copy/"Mark as sent". The **Verify** button runs the v1 Web Unlocker re-check and closes the case automatically when the listing is gone.
- An **SLA strip:** median time to takedown, % removed within 48 h, repeat-offender count (Tiger continuous aggregate).
- **Catalog upload** (CSV) and an **Export to CSV for regulators** button.

---

## 4. Sponsor depth in v2 (each one carries real weight)
| Sponsor | v2 role |
|---|---|
| Bright Data | B2B scanning (datasets, seller/store discovery), alternatives (SERP API), takedown checks (Web Unlocker) |
| Gemini | Confirmation stage (Flash-Lite), photo checks (Flash), the multimodal embeddings behind the recall index, category extraction, ranking alternatives |
| Tiger Data | Recall index (vectorscale + BM25), the match cache, the case audit trail hypertable, SLA continuous aggregates |
| DigitalOcean | App Platform hosting (the extension's public API), Serverless Inference (seller notices and query planning), Spaces (evidence + exports) |
| Sentry | Backend tracing on `/v2/match` latency, plus the Sentry browser SDK in the extension and console (adapter breakage shows up as errors per site) |

---

## 5. Work plan (agents, separate file ownership)
| Agent | Owns | Delivers |
|---|---|---|
| **Lead** | `app/main.py`, `app/v2/contracts.py`, `db/schema_v2.sql`, docs, deploy config | Contracts first, schema, App Platform deploy, integration, a demo reset script |
| **E1: Engine** | `app/v2/match.py`, `app/v2/index.py`, `app/v2/alternatives.py` | Recall index build, `/v2/match` (Stage 1 + 2 + cache), `/v2/alternatives`, latency test (p95 < 600 ms for 40 clean cards) |
| **E2: Extension** | `extension/**` | MV3 for Chrome + Firefox: Amazon, eBay, Walmart adapters + the generic fallback, badges, banner, popup, background worker |
| **E3: B2B backend** | `app/b2b/**` | Sellers, cases, notices (DO inference), scan, catalog upload, CSV export |
| **E4: Console UI** | `web/**` | Tenant switch, Sellers view + constellation, case kanban, SLA strip, upload/export |
| **E5: QA** | `qa/**` | Playwright: load the unpacked extension in Chromium, scroll real Amazon/eBay search pages, assert badges appear; console flows; screenshots |

### Phases
| Phase | Scope | Goal |
|---|---|---|
| **P0** (about 2 h) [DEMO CRITICAL] | Recall index + `/v2/match` + `/v2/alternatives`; extension on **Amazon + eBay** + generic fallback; console Sellers view + case queue + DO-drafted notice; deploy to App Platform | Scroll Amazon and see a red tag; open a seller in the console and draft a notice |
| **P1** | Walmart/Target/FB adapters, seller constellation 3D, SLA aggregates, catalog upload, Firefox packaging, Sentry browser SDK | |
| **P2** | Auto re-check scheduler, webhooks for marketplaces, multi-country recall sources (Health Canada, EU Safety Gate), and accounts/teams | |

### Demo (2 min)
1. **Consumer, 0:00–0:50:** On Amazon, search "magnetic building cubes" and scroll. Red RECALLED tags appear on matching listings. Open one to see the recall banner ("Ingestion hazard: magnets can come loose") and 3 safe alternatives.
2. **Marketplace, 0:50–1:40:** Open the console with "Monitoring: eBay". The Sellers view shows one seller with 4 recalled Bodum listings. Open the case and draft a notice (written by DO). Mark it sent. **Verify** re-checks the listing and moves the case to removed when it's gone.
3. **Proof, 1:40–2:00:** The Proof drawer shows every sponsor call. Close: "One engine. Shoppers get warned before they buy; marketplaces get the list to take down."

### Risks
| Risk | Mitigation |
|---|---|
| Site DOM changes break adapters | Per-site adapters + the JSON-LD/og: fallback; Sentry reports adapter errors per site |
| False "RECALLED" on lookalikes | Only exact/variant with confidence ≥ 0.8 shows red; everything else is amber "possible match: check model"; every badge links to the CPSC notice |
| Latency while scrolling | The Tiger-only Stage 1, batching, caching; Gemini only on candidates |
| Gemini free-tier quota | Stage 2 is rare by design; the fallback chain from v1 |
| Extension needs a public API | DO App Platform deploy is a P0 step (needs this repo on GitHub) |
| Legal tone | "Appears to match CPSC recall #…"; humans send notices; no automatic sending |

### What I need to start
1. **A GitHub repo URL** to push v1 to (create an empty repo; `gh` isn't installed here). App Platform then deploys from it.
2. Your approval of this plan, or edits. Then I build P0 without further questions.
