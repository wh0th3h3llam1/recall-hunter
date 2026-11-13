// HTTP client for the contract in contracts/CONTRACTS.md.
// In DEV only, `?fixture` in the URL swaps in synthetic data from src/dev/fixtures.ts
// (clearly bannered in the UI). Production builds never include it.

export interface Recall {
  recall_id: number;
  recall_number: string;
  recall_date: string | null;
  title: string;
  product_name: string | null;
  hazard: string | null;
  hazard_class: string | null;
  units: string | number | null;
  image_urls: string[] | null;
  is_child: boolean;
  priority: number | null;
  url: string | null;
  live_count: number | null;
  confirmed_count: number | null;
}

export interface LabelBox {
  box_2d: [number, number, number, number];
  label?: string | null;
}

export type Final = 'CONFIRMED' | 'LIKELY' | 'REJECTED';

export interface Listing {
  listing_id: string;
  recall_id: number;
  platform: string;
  url: string | null;
  title: string | null;
  price: number | null;
  seller: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  image_url: string | null;
  first_seen: string | null;
  category: string | null;
  match_score: number | null;
  confidence: number | null;
  tier_reached: number | null;
  label_box: LabelBox | null;
  reason: string | null;
  final: Final | null;
  evidence_url: string | null;
  days_since_recall: number | null;
  // added client-side
  hazard_class?: string | null;
}

export interface Stats {
  recalls: number;
  listings_scanned: number;
  confirmed: number;
  likely: number;
  rejected: number;
  median_days_live: number | null;
  funnel: { screened: number; vision: number; escalated: number; confirmed: number };
  by_platform: { platform: string; confirmed: number; live: number }[];
  by_hazard: { hazard_class: string; confirmed: number }[];
  gemini: { calls: number; cost_usd: number; p50_ms_by_tier: Record<string, number | null> };
}

export interface ProofRow {
  sponsor: string;
  product: string;
  endpoint: string;
  status: string | number | null;
  latency_ms: number | null;
  records: number | null;
  called_at: string | number | null;
  sample?: unknown;
}

export interface Proof {
  rows: ProofRow[];
  configured: Record<string, boolean> | null;
}

export const FIXTURE_MODE: boolean =
  import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('fixture');

async function getJSON<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { ...init, signal: ctl.signal, headers: { Accept: 'application/json', ...(init?.headers || {}) } });
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${r.status} on ${path}${detail ? ` — ${detail}` : ''}`);
    }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error(`Non-JSON response on ${path} (is the API at :8000 up?)`);
    return (await r.json()) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Timed out on ${path}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fixtures() {
  if (import.meta.env.DEV) return import('./dev/fixtures');
  throw new Error('fixtures unavailable');
}

export const api = {
  async recalls(child: boolean): Promise<Recall[]> {
    if (import.meta.env.DEV && FIXTURE_MODE) return (await fixtures()).DEV_FIXTURE_RECALLS.filter((r) => !child || r.is_child);
    return getJSON<Recall[]>(`/api/recalls?child=${child ? 1 : 0}&limit=50`);
  },
  async recall(id: number): Promise<Recall & { listings?: Listing[] }> {
    if (import.meta.env.DEV && FIXTURE_MODE) {
      const r = (await fixtures()).DEV_FIXTURE_RECALLS.find((x) => x.recall_id === id);
      if (!r) throw new Error('not found');
      return r;
    }
    return getJSON(`/api/recalls/${id}`);
  },
  async listings(recallId?: number | null): Promise<Listing[]> {
    if (import.meta.env.DEV && FIXTURE_MODE) {
      const all = (await fixtures()).DEV_FIXTURE_LISTINGS;
      return recallId ? all.filter((l) => l.recall_id === recallId) : all;
    }
    return getJSON<Listing[]>(`/api/listings${recallId ? `?recall_id=${recallId}` : ''}`);
  },
  async stats(recallId?: number | null): Promise<Stats> {
    if (import.meta.env.DEV && FIXTURE_MODE) return (await fixtures()).DEV_FIXTURE_STATS;
    return getJSON<Stats>(`/api/stats${recallId ? `?recall_id=${recallId}` : ''}`);
  },
  async proof(): Promise<Proof> {
    if (import.meta.env.DEV && FIXTURE_MODE) return { rows: [], configured: { digitalocean: false, sentry: false, snowflake: false } };
    const raw = await getJSON<unknown>('/api/proof');
    if (Array.isArray(raw)) return { rows: raw as ProofRow[], configured: null };
    const o = (raw ?? {}) as Record<string, unknown>;
    const rows = (o.rows ?? o.calls ?? o.proof ?? o.items ?? []) as ProofRow[];
    return { rows: Array.isArray(rows) ? rows : [], configured: (o.configured as Record<string, boolean>) ?? null };
  },
  async hunt(recallId: number): Promise<{ run_id: string }> {
    if (import.meta.env.DEV && FIXTURE_MODE) throw new Error('HUNT is disabled in DEV fixture mode (no backend).');
    return getJSON<{ run_id: string }>(`/api/hunt/${recallId}`, { method: 'POST' }, 30000);
  },
};
