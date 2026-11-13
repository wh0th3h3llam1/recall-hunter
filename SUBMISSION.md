# Submission: Recall Hunter

**Tagline:** A product was recalled, and it's still for sale. We find it.

**What it does:** Every week the U.S. Consumer Product Safety Commission recalls about 10 products: infant sleepers, magnets, dressers
that tip over, heaters that catch fire. With only a press release, about 6% of consumers act on the recall, and the products keep
selling on marketplaces. Recall Hunter takes each new recall, searches Amazon, eBay, Facebook Marketplace and Google Shopping
through Bright Data, and confirms matches with a three-tier Gemini funnel. The final tier compares the official recall photo to the
listing photo and draws a box around the matching label. It stores every observation in Tiger Data, so it can show how long recalled
items stay for sale.

**How we built it:**
- **Bright Data:** Web Scraper API (Amazon, eBay, FB Marketplace × 5 cities, Google Shopping), a SERP API zone, and a Web Unlocker zone for checking whether a listing is still live.
- **Gemini:** 3.5 Flash-Lite batch screen with fixed-format JSON → Flash photo comparison with `box_2d` → 3.1 Pro rulings on uncertain cases, plus Embedding 2 multimodal vectors.
- **Tiger Data:** hypertables, a continuous aggregate, vectorscale diskann image search, pg_textsearch BM25 model-number search.
- **Sentry:** spans for each pipeline stage.
- **UI:** React Three Fiber 3D "hazard cartography" map.
- **Process:** a contract-first multi-agent software factory (see `FACTORY.md`).

**Tracks:** Best Overall · Bright Data · Gemini · Tiger Data · Sentry · Software Factory · HyperFrames (demo video)

## 2-minute demo script
1. **0:00:** "Only about 6% of people respond to a recall notice. The products don't disappear; they get resold."
2. **0:15:** Left rail: today's real CPSC feed. Pick the SHEIN teething toy (choking hazard). Press **HUNT**.
3. **0:30:** Live log: Bright Data queries go to Amazon, Google Shopping, eBay and Marketplace; candidates stream in.
4. **0:50:** Gemini funnel counts up: 122 screened → 24 photo-checked → 9 escalated → 3 confirmed.
5. **1:10:** Click a confirmed listing. The Evidence card shows the listing photo with Gemini's label box, the CONFIRMED stamp, Gemini's reasoning and the evidence file.
6. **1:35:** **Proof** drawer: every real sponsor call, logged in Tiger.
7. **1:50:** "Every Thursday CPSC publishes about 10 recalls. Recall Hunter can hunt them within minutes."

**Backup:** if the Wi-Fi fails, restart the server with `RH_CACHE_ONLY=1`. It replays the raw Bright Data responses captured live earlier, labelled as cached.
