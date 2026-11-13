# Recall Hunter: 2:30 demo script

**Live:** https://recall-hunter-ay2po.ondigitalocean.app/landing.html → console at `/` · extension: `extension/dist-chrome` (Brave/Chrome)

**Tabs to open beforehand, in order:**
1. Landing page
2. Amazon search: `Bodum Chambord french press`
3. OfferUp Rock 'n Play: https://offerup.com/item/detail/f8f28413-aa3a-3109-825e-67352b18ca03
4. Console: `/`

**Before you start:** extension loaded, "Children's products only" **off**, each store tab visited once, so the tags are cached and appear instantly.

| Time | On screen (do) | Say (about 380 words) |
|---|---|---|
| **0:00** | Landing page hero: "Recalled. Still for sale." | "Every week the U.S. Consumer Product Safety Commission recalls about ten products that can burn, choke or kill. The recall is a press release. The product keeps selling." |
| **0:12** | Scroll: the background turns red and the stats count up (6% · 10% · 55,000) | "Only **6%** of consumers act on a recall notice. Only **10%** of recalled children's products are ever fixed. Regulators sent **55,000** takedown requests to resale sites in one year, by hand." |
| **0:25** | Scroll: Hunt → Confirm → Prove with live numbers | "Recall Hunter fixes both sides. **Bright Data** hunts the marketplaces, **Gemini** confirms the match from the photos, and **Tiger Data** keeps time-stamped evidence. These numbers are live: **896** listings scanned, **24** confirmed still for sale, median **15 days** after the recall." |
| **0:38** | Amazon tab: Bodum results show red **"RECALLED: DO NOT BUY · FIRE / BURN HAZARD"** tags | "Part one is for shoppers. Our browser extension, **Recall Guard**, runs by itself on Amazon, eBay, Walmart and Target. As you scroll, recalled products get tagged. It checks 40 products in about **0.3 seconds**." |
| **0:52** | Click a tag → recall popover. Open the product page → top banner with the remedy + **safer alternatives** | "Click it and you see the CPSC recall, the hazard and the official remedy. On the product page we also suggest safer alternatives, found live through **Bright Data's** SERP API." |
| **1:05** | OfferUp tab: Rock 'n Play banner, recall **#23088** | "This is a real listing, live right now on OfferUp: a Fisher-Price **Rock 'n Play Sleeper**, recalled after infant deaths. It's illegal to sell. It's $30 in Oceanside, California." |
| **1:15** | Open the extension popup: counts, **Re-check this page** | "The popup shows what's flagged on this tab. **Re-check** runs the page again against the newest recalls." |
| **1:22** | Console tab, **SURVEY**: map with pillars, pick the Bodum recall, press **HUNT** | "Part two is for the marketplaces themselves. This is the trust and safety console. Press **HUNT**: **DigitalOcean's** gpt-oss model plans the searches, and Bright Data searches Amazon, eBay, Facebook Marketplace and Google Shopping." |
| **1:35** | Gemini funnel counts; click a CONFIRMED listing → **evidence card** with Gemini's box on the label | "**Gemini** works as a funnel: Flash-Lite screens every listing, Flash compares the photos and boxes the matching label, and Pro rules on the hard cases. Here it found the Bodum engraving." |
| **1:50** | **SELLERS** tab: register + seller constellation | "Hits are grouped by seller, repeat offenders first. Across five platforms there are **153** confirmed or likely listings." |
| **2:00** | **CASES** tab: open a case → **DRAFT NOTICE** | "Every listing becomes a case: open, notified, removed, verified. **DigitalOcean** drafts the takedown notice. A human always sends it; we never send anything automatically." |
| **2:12** | **VERIFY** on a case, then the **PROOF** drawer | "Verify re-checks the listing live through Bright Data's **Web Unlocker**. And the Proof drawer shows every real sponsor call, more than **4,500**, all logged in Tiger." |
| **2:22** | Back to the landing page CTA | "Shoppers are warned before they buy. Marketplaces get the evidence and the workflow to take it down. **Recall Hunter.**" |

**Fallbacks:**
- If HUNT is slow, open an existing CONFIRMED listing instead. The pipeline is still visible in the live log.
- DRAFT NOTICE takes about 20 s. Click it, keep talking, then come back to it.

## Metrics (live, 13 Nov 2026)
| Metric | Value |
|---|---|
| CPSC recalls indexed | **95** (Sep–Nov 2026 feed + high-risk older recalls: Rock 'n Play, Boppy, Snuga, Peloton Tread+, inclined sleepers) |
| Marketplace listings scanned | **896** across Amazon, eBay, FB Marketplace, Google Shopping, OfferUp |
| Gemini funnel | 896 screened → 89 photo-checked → 11 escalated → **24 confirmed** (+129 likely, 743 rejected) |
| Median days still for sale after the recall | **15** |
| Sellers identified / takedown cases | **244** sellers / **174** cases, 7 repeat offenders |
| Extension matcher speed | 40 products in about **300 ms** (p95, cold); **80 ms** cached |
| Extension accuracy on the test set | precision **1.00**, recall **1.00** after Gemini Stage 2 (4 TP, 0 FP, 38 TN, 0 FN) |
| Real sponsor API calls logged | Gemini **3,086** · Bright Data **1,329** · DigitalOcean **187** |

## Sponsors and the products we use
| Sponsor | Products used | What it does in Recall Hunter |
|---|---|---|
| **Bright Data** | Web Scraper API (Amazon, eBay, FB Marketplace, Google Shopping datasets) · SERP API · Web Unlocker | Hunts marketplaces for each recall · finds safer alternatives for the extension · re-checks that a listing was taken down, and reads OfferUp listings |
| **Google Gemini** | 3.5 Flash-Lite · 3.5 Flash / 4-hydrogen · 3.1 Pro · Embedding 2 | Batch screen → photo comparison with `box_2d` label boxes → final ruling · Stage 2 of the extension matcher · extracts brand, models and category for the recall index · multimodal vectors |
| **Tiger Data** | Postgres + TimescaleDB hypertables & continuous aggregates · pgvector + **vectorscale** (diskann) · **pg_textsearch** (BM25) | Stage 1 of the extension matcher (BM25 in about 300 ms) · image similarity search · time-stamped listing observations, API calls, match requests, case events |
| **DigitalOcean** | Serverless Inference (`openai-gpt-oss-120b`) · Spaces · App Platform | Plans hunt queries · drafts seller takedown notices (human-sent only) · stores public evidence files · hosts the API + console + landing page |
| **Sentry** | Python SDK, tracing + error capture | A span for every pipeline stage and match request; exceptions captured in the matcher |
| **Software Factory** | Contract-first multi-agent build | Frozen API contracts (`contracts/`) let parallel agents build the engine, extension, B2B backend and console |
| **HyperFrames** | Demo video | This video |
