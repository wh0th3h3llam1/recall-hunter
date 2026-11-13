// Shared types for Recall Guard. Shapes follow contracts/CONTRACTS_V2.md (/v2/match etc.).

export type Status = 'clean' | 'possible' | 'recalled';

export type HazardClass =
  | 'suffocation' | 'tip_over' | 'ingestion' | 'choking' | 'fire_burn' | 'flammability'
  | 'entrapment' | 'fall' | 'shock' | 'laceration' | 'other';

export interface Product {
  product_id: string;
  title: string;
  brand?: string;
  price?: string;
  image_url?: string;
  model?: string;
  upc?: string;
  url?: string;
}

export interface Recall {
  recall_id: number;
  recall_number: string;
  title: string;
  product_name?: string;
  hazard?: string;
  hazard_class?: HazardClass | string;
  remedy?: string;
  url?: string;
  recall_date?: string;
  units?: string;
  image?: string;
}

export interface MatchResult {
  product_id: string;
  status: Status;
  recall: Recall | null;
  confidence?: number;
  reason?: string;
  stage?: number;
}

export interface Alternative {
  title: string;
  price?: string;
  shop?: string;
  url?: string;
  image?: string;
  safety_note?: string;
}

export type SiteKey = 'amazon' | 'ebay' | 'walmart' | 'target' | 'generic';

export interface Settings {
  apiBase: string;
  sites: Record<SiteKey, boolean>;
  childOnly: boolean;
}

export interface RecallUpdate {
  recall_id: number;
  recall_number: string;
  title: string;
  hazard_class?: string;
  recall_date?: string;
  url?: string;
  is_child?: boolean;
}

export interface TabState {
  site: string;
  recalled: number;
  possible: number;
  checked: number;
  offline: boolean;
  error?: string;
}

// Messages content/popup -> background
export type Msg =
  | { type: 'match'; site: string; page_url: string; products: Product[]; force?: boolean }
  | { type: 'alternatives'; recall_id: number; title: string }
  | { type: 'report'; state: TabState }
  | { type: 'getTabState'; tabId: number }
  | { type: 'health' }
  | { type: 'updates' };

export interface MatchReply {
  ok: boolean;
  offline?: boolean;
  error?: string;
  results: MatchResult[];
}
