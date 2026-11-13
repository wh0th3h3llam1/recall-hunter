// Client for the /b2b console API (contracts/CONTRACTS_V2.md). No mocks: failures surface as errors.

export interface PlatformRow {
  platform: string;
  listings: number;
  confirmed: number;
  likely: number;
  sellers: number;
  open_cases: number;
}

export interface SellerRecall {
  recall_id: number;
  title: string | null;
  hazard_class: string | null;
  count: number;
}

export interface Seller {
  seller_id: string | number;
  platform: string;
  name: string | null;
  profile_url: string | null;
  listings_count: number;
  confirmed_count: number;
  likely_count: number;
  open_cases: number;
  recalls: SellerRecall[];
}

export interface SellerListing {
  listing_id: string;
  recall_id?: number | null;
  platform?: string;
  url?: string | null;
  title?: string | null;
  price?: number | null;
  image_url?: string | null;
  final?: string | null;
  category?: string | null;
  match_score?: number | null;
  confidence?: number | null;
  tier_reached?: number | null;
  evidence_url?: string | null;
  case_id?: string | number | null;
  case_status?: string | null;
  [k: string]: unknown;
}

export type SellerDetail = Seller & { listings: SellerListing[] };

export interface CaseEvent {
  ts?: string;
  at?: string;
  created_at?: string;
  type?: string;
  event?: string;
  kind?: string;
  detail?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

export interface Case {
  case_id: string | number;
  listing_id: string;
  seller_id: string | number | null;
  seller_name: string | null;
  recall_id: number | null;
  recall_number: string | null;
  recall_title: string | null;
  hazard_class: string | null;
  platform: string;
  status: string;
  severity: string | number | null;
  opened_at: string | null;
  notified_at: string | null;
  removed_at: string | null;
  verified_at: string | null;
  listing_url: string | null;
  listing_title: string | null;
  image_url: string | null;
  price: number | null;
  evidence_url: string | null;
  days_open: number | null;
  notes?: string | null;
  assignee?: string | null;
  notice_text?: string | null;
  events?: CaseEvent[];
}

export interface SLA {
  median_hours_to_notify: number | null;
  median_hours_to_removal: number | null;
  pct_removed_48h: number | null;
  open: number;
  notified: number;
  removed: number;
  verified: number;
  repeat_offenders: number | unknown[] | null;
}

export class B2BError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { ...init, signal: ctl.signal, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers || {}) } });
    if (r.status === 404 && path.startsWith('/b2b/') && !/\/b2b\/(sellers|cases)\/[^/?]+/.test(path)) {
      throw new B2BError('The /b2b API is not loaded on this server yet (404). It appears after the lead restarts the server.', 404);
    }
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.text()).slice(0, 240);
      } catch {
        /* ignore */
      }
      throw new B2BError(`HTTP ${r.status} on ${path}${detail ? ` — ${detail}` : ''}`, r.status);
    }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new B2BError(`Non-JSON response on ${path}`, r.status);
    return (await r.json()) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new B2BError(`Timed out on ${path}`, 0);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const seg = (id: string | number): string => encodeURIComponent(String(id)).replace(/%2F/gi, "/");

const q = (o: Record<string, string | number | null | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v != null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};

export const b2b = {
  platforms: () => call<PlatformRow[]>('/b2b/platforms'),
  sellers: (platform: string | null, sort = 'confirmed') => call<Seller[]>(`/b2b/sellers${q({ platform, sort, limit: 200 })}`),
  seller: async (id: string | number) => {
    const d = await call<SellerDetail>(`/b2b/sellers/${seg(id)}`);
    // the API nests verdict fields under `verdict`; flatten for the UI
    d.listings = (d.listings ?? []).map((l) => ({ ...((l as { verdict?: object }).verdict ?? {}), ...l, ...((l as { verdict?: object }).verdict ?? {}) }));
    return d;
  },
  caseDetail: (id: string | number) => call<Case>(`/b2b/cases/${seg(id)}`),
  cases: (platform: string | null, status?: string | null) => call<Case[]>(`/b2b/cases${q({ platform, status })}`),
  patchCase: (id: string | number, body: { status?: string; assignee?: string; notes?: string }) =>
    call<Case>(`/b2b/cases/${seg(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  notice: (id: string | number) => call<{ notice_text: string; model: string }>(`/b2b/cases/${seg(id)}/notice`, { method: 'POST' }, 120000),
  verify: (id: string | number) => call<{ is_live: boolean; http_status: number | null; status: string }>(`/b2b/cases/${seg(id)}/verify`, { method: 'POST' }, 90000),
  sync: () => call<Record<string, unknown>>('/b2b/sync', { method: 'POST' }, 60000),
  sla: (platform: string | null) => call<SLA>(`/b2b/sla${q({ platform })}`),
  reportUrl: (platform: string | null) => `/b2b/report.csv${q({ platform })}`,
};

export const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
