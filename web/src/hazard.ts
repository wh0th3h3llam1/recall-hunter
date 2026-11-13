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

export const HAZARD_LABEL: Record<string, string> = {
  suffocation: 'Suffocation',
  tip_over: 'Tip-over',
  ingestion: 'Ingestion',
  choking: 'Choking',
  fire_burn: 'Fire / burn',
  flammability: 'Flammability',
  entrapment: 'Entrapment',
  fall: 'Fall',
  shock: 'Shock',
  laceration: 'Laceration',
  other: 'Other',
};

export function hazardColor(h?: string | null): string {
  return HAZARD_COLORS[h ?? 'other'] ?? HAZARD_COLORS.other;
}
export function hazardLabel(h?: string | null): string {
  return HAZARD_LABEL[h ?? 'other'] ?? (h || 'Other');
}

export const PLATFORM_LABEL: Record<string, string> = {
  ebay: 'eBay',
  amazon: 'Amazon',
  google_shopping: 'Google Shopping',
  fb_marketplace: 'FB Marketplace',
  craigslist: 'Craigslist',
};
export function platformLabel(p?: string | null): string {
  return PLATFORM_LABEL[p ?? ''] ?? (p || 'unknown');
}
