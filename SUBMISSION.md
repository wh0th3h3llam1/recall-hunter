# Submission: Recall Hunter

**Tagline:** A product was recalled, and it's still for sale. We tag it before you buy it, and we help the marketplace take it down.

**Live demo:** https://recall-hunter-ay2po.ondigitalocean.app (console + API on DigitalOcean App Platform) · extension: `extension/dist-chrome`, `extension/dist-firefox`

**What it does:** Every week the U.S. Consumer Product Safety Commission recalls about 10 products: infant sleepers, magnets, dressers
that tip over, French presses that shatter. With only a press release, about 6% of consumers act on the recall, and the products
keep selling online. Recall Hunter is one engine with two products:

1. **Recall Guard (B2C browser extension, Chrome + Firefox).** As you scroll Amazon, eBay, Walmart, Target or any store with
   schema.org data, every product card is checked against the live CPSC recall index. Recalled items get a "DO NOT BUY" tag with the
   hazard; a recalled product page shows the official remedy, the CPSC link and three safer alternatives. 40 cards are checked in
   about 300 ms.
2. **Trust & Safety console (B2B, for marketplaces).** It hunts each new recall across marketplaces, confirms matches with a
   three-tier Gemini funnel (the last tier draws a box around the matching label in the listing photo), groups the hits by seller,
   opens a case per listing, drafts a takedown notice, and re-checks that the listing actually came down. Repeat offenders and
   time-to-removal are tracked.

**How we built it:**
- **Bright Data:** Web Scraper API (Amazon, eBay, FB Marketplace × 5 cities, Google Shopping) for the hunt; SERP API for the fast
  path and for safer alternatives; Web Unlocker to verify that a listing was removed.
- **Gemini:** 3.5 Flash-Lite batch screen → Flash / 4-hydrogen photo comparison with `box_2d` → 3.1 Pro rulings; Stage 2 of the
  extension matcher; recall index extraction (brand, models, category); Embedding 2 vectors.
- **Tiger Data:** the whole product runs on it. BM25 (pg_textsearch) is Stage 1 of the extension matcher, vectorscale diskann for
  image search, hypertables for observations, API calls, match requests and case events, a continuous aggregate, and the match cache.
- **DigitalOcean:** Serverless Inference (`openai-gpt-oss-120b`) plans hunt queries and drafts seller notices; Spaces holds the public
  evidence files; App Platform hosts the API and console from this repo's Dockerfile.
- **Sentry:** spans for each pipeline stage, plus exception capture in the matcher.
- **Process:** a contract-first multi-agent software factory (see `FACTORY.md`, `contracts/CONTRACTS_V2.md`).

**Tracks:** Best Overall · Bright Data · Gemini · Tiger Data · DigitalOcean · Sentry · Software Factory · HyperFrames (demo video)

## 2-minute demo script
1. **0:00:** "Only about 6% of people respond to a recall notice. The products don't disappear; they keep selling."
2. **0:10, shopper:** Search results with the extension on. The Bodum French press, Magnetopia cubes and HAUOMS dresser light up
   "RECALLED: DO NOT BUY" while the rest stay clean. Open the Bodum product page: CPSC #27055 banner, remedy, three safer alternatives.
3. **0:45, marketplace:** Console → SURVEY: pick a recall, press **HUNT**. Bright Data queries stream in and the Gemini funnel counts down.
   Open a confirmed eBay listing: the evidence card with Gemini's label box.
4. **1:10:** SELLERS: hits grouped by seller, repeat offenders first. CASES: open a case → **DRAFT NOTICE** (DigitalOcean gpt-oss-120b)
   → a human marks it sent → **VERIFY** re-checks the listing live through Bright Data.
5. **1:40:** **Proof** drawer: every real sponsor call, logged in Tiger.
6. **1:50:** "Shoppers are protected on the page; marketplaces get the evidence and the workflow to pull the listing."

**Backup:** if the Wi-Fi fails, restart the server with `RH_CACHE_ONLY=1`. It replays the raw Bright Data responses captured live earlier,
labelled as cached. The extension's verdicts are cached in Tiger and locally for 7 days.
