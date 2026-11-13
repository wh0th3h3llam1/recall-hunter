import type { Settings, SiteKey } from './types';

// One API surface for Firefox (`browser`, promise-based) and Chrome (`chrome`, promise-based in MV3).
export const ext: typeof chrome = (globalThis as any).browser ?? (globalThis as any).chrome;

export const DEFAULT_API = 'http://localhost:8000';

export const DEFAULT_SETTINGS: Settings = {
  apiBase: DEFAULT_API,
  sites: { amazon: true, ebay: true, walmart: true, target: true, generic: true },
  childOnly: false,
};

export async function getSettings(): Promise<Settings> {
  const got = (await ext.storage.local.get('settings')) as { settings?: Partial<Settings> };
  const s = got.settings ?? {};
  return {
    apiBase: (s.apiBase || DEFAULT_API).replace(/\/+$/, ''),
    sites: { ...DEFAULT_SETTINGS.sites, ...(s.sites ?? {}) },
    childOnly: !!s.childOnly,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = { ...cur, ...patch, sites: { ...cur.sites, ...(patch.sites ?? {}) } };
  next.apiBase = (next.apiBase || DEFAULT_API).trim().replace(/\/+$/, '');
  await ext.storage.local.set({ settings: next });
  return next;
}

export const SITE_LABELS: Record<SiteKey, string> = {
  amazon: 'Amazon',
  ebay: 'eBay',
  walmart: 'Walmart',
  target: 'Target',
  generic: 'Other stores (schema.org)',
};

export const HAZARD_COLORS: Record<string, string> = {
  suffocation: '#E4572E',
  tip_over: '#F3A712',
  ingestion: '#3A86FF',
  choking: '#8AC926',
  fire_burn: '#FF3B1F',
  flammability: '#B5179E',
  entrapment: '#6D597A',
  fall: '#8D99AE',
  shock: '#FFD166',
  laceration: '#EF8354',
  other: '#9A9A9A',
};

export const HAZARD_SHORT: Record<string, string> = {
  suffocation: 'Suffocation risk',
  tip_over: 'Tip-over risk',
  ingestion: 'Ingestion hazard',
  choking: 'Choking hazard',
  fire_burn: 'Fire / burn hazard',
  flammability: 'Flammability hazard',
  entrapment: 'Entrapment hazard',
  fall: 'Fall hazard',
  shock: 'Shock hazard',
  laceration: 'Laceration hazard',
  other: 'Safety hazard',
};

export const hazardColor = (c?: string) => HAZARD_COLORS[c ?? 'other'] ?? HAZARD_COLORS.other;
export const hazardShort = (c?: string) => HAZARD_SHORT[c ?? 'other'] ?? HAZARD_SHORT.other;

export function fmtDate(d?: string): string {
  if (!d) return '—';
  const t = Date.parse(d.length === 10 ? d + 'T12:00:00Z' : d);
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Only allow http(s) links into the page (API data is untrusted). */
export function safeUrl(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : undefined;
  } catch {
    return undefined;
  }
}
