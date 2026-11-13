// DEV-ONLY SYNTHETIC FIXTURE. NOT REAL DATA.
// Loaded only when import.meta.env.DEV and the URL has ?fixture. Every record is labelled "[DEV FIXTURE]".
// It exists so the 3D layout can be checked before the backend is up. Never shipped in `npm run build`.
import type { Listing, Recall, Stats } from '../api';

const HZ = ['suffocation', 'tip_over', 'ingestion', 'fire_burn', 'choking', 'shock'];

export const DEV_FIXTURE_RECALLS: Recall[] = HZ.map((h, i) => ({
  recall_id: 9000 + i,
  recall_number: `DEV-${i}`,
  recall_date: `202${i % 5}-0${(i % 9) + 1}-15`,
  title: `[DEV FIXTURE] Synthetic ${h.replace('_', '-')} recall placeholder number ${i + 1} for layout testing only`,
  product_name: `[DEV FIXTURE] product ${i + 1}`,
  hazard: `[DEV FIXTURE] Synthetic hazard text for ${h}. Not a real CPSC recall.`,
  hazard_class: h,
  units: `${(i + 1) * 12000}`,
  image_urls: [],
  is_child: i % 2 === 0,
  priority: 10 - i,
  url: null,
  live_count: 0,
  confirmed_count: 0,
}));

const CITIES: [string, number, number][] = [
  ['Seattle, WA', 47.6, -122.3], ['Portland, OR', 45.5, -122.7], ['Oakland, CA', 37.8, -122.3], ['Los Angeles, CA', 34.05, -118.25],
  ['Phoenix, AZ', 33.45, -112.07], ['Denver, CO', 39.74, -104.99], ['Dallas, TX', 32.78, -96.8], ['Houston, TX', 29.76, -95.37],
  ['Chicago, IL', 41.88, -87.63], ['Minneapolis, MN', 44.98, -93.27], ['Atlanta, GA', 33.75, -84.39], ['Miami, FL', 25.76, -80.19],
  ['New York, NY', 40.71, -74.0], ['Boston, MA', 42.36, -71.06], ['Detroit, MI', 42.33, -83.05], ['Anchorage, AK', 61.2, -149.9],
];

export const DEV_FIXTURE_LISTINGS: Listing[] = [
  ...CITIES.map(([loc, lat, lon], i) => mk(i, i % 3 === 0 ? 'craigslist' : 'fb_marketplace', loc, lat, lon)),
  ...Array.from({ length: 9 }, (_, i) => mk(100 + i, ['ebay', 'amazon', 'google_shopping'][i % 3], null, null, null)),
];

function mk(i: number, platform: string, location: string | null, lat: number | null, lon: number | null): Listing {
  const r = DEV_FIXTURE_RECALLS[i % DEV_FIXTURE_RECALLS.length];
  return {
    listing_id: `dev:${i}`,
    recall_id: r.recall_id,
    platform,
    url: null,
    title: `[DEV FIXTURE] synthetic listing ${i}`,
    price: null,
    seller: null,
    location,
    lat,
    lon,
    image_url: null,
    first_seen: null,
    category: i % 2 ? 'exact_recalled_model' : 'likely_variant',
    match_score: null,
    confidence: null,
    tier_reached: (i % 3) + 1,
    label_box: { box_2d: [200, 250, 800, 750], label: '[DEV FIXTURE] box' },
    reason: '[DEV FIXTURE] synthetic reason text, not a Gemini output.',
    final: i % 5 === 4 ? 'REJECTED' : i % 2 ? 'CONFIRMED' : 'LIKELY',
    evidence_url: null,
    days_since_recall: [12, 90, 400, 1200, 2400][i % 5],
  };
}

export const DEV_FIXTURE_STATS: Stats = {
  recalls: DEV_FIXTURE_RECALLS.length,
  listings_scanned: 0,
  confirmed: 0,
  likely: 0,
  rejected: 0,
  median_days_live: null,
  funnel: { screened: 0, vision: 0, escalated: 0, confirmed: 0 },
  by_platform: [],
  by_hazard: [],
  gemini: { calls: 0, cost_usd: 0, p50_ms_by_tier: {} },
};
