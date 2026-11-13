# Recall Guard: browser extension (Recall Hunter v2, B2C)

Tags products that match U.S. CPSC recalls **while you scroll** Amazon, eBay, Walmart, Target, and any store that
publishes schema.org Product data. On a recalled product page it shows a "do not buy" notice with the hazard, the
official remedy, a link to the CPSC notice, and up to three safer alternatives.

## Install (unpacked)
```bash
cd extension && npm install && npm run build
```
- **Chrome / Edge:** `chrome://extensions` → Developer mode → *Load unpacked* → `extension/dist-chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `extension/dist-firefox/manifest.json`

Open the popup to set the API base (default `http://localhost:8000`, or the deployed DigitalOcean URL) and toggle sites.

## How it works
1. A content script with per-site adapters (`src/adapters`) reads each product card: title, brand, price, image, ASIN/item id.
2. The background worker batches up to 40 cards per request to `POST /v2/match` and caches verdicts locally for 7 days.
3. **Stage 1** (Tiger Data only: BM25 + brand/model rules over `rh.recall_index`) answers in about 300 ms p95 for 40 cards.
   **Stage 2** (Gemini) confirms the few candidates in the background; the badge upgrades from *possible* to *recalled*.
4. Badges live in a Shadow DOM, so they never collide with store CSS. The toolbar icon shows the count per tab.
5. Alternatives come from `GET /v2/alternatives` (Bright Data SERP API Google Shopping, filtered against the recall index).

## Test without installing
`test/harness.html` and `test/product-harness.html` are **DOM fixtures** (fake ASINs, not real store pages) that load the
built `dist/` scripts with a small `chrome.*` shim (`test/shim.js`):
```bash
python -m http.server 8765 --bind 127.0.0.1   # from extension/
```
then open `http://127.0.0.1:8765/test/harness.html` with the API running on :8000.

## Privacy
Only product-card fields (title, brand, model, price, image URL, product URL) and the current store page URL are sent
to the configured API. No browsing history, account data, or cookies are read or sent.
