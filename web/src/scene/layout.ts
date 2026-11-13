import type { Listing } from '../api';
import { hazardColor } from '../hazard';
import { lonLatToWorld, MAP_DEPTH } from './geo';

export const RING = { a: 63, b: 43, y: 2.4, width: 1.3 };
export const ONLINE_DEFAULT = ['ebay', 'amazon', 'google_shopping'];
const GAP = 0.06; // radians between segments
const START = -Math.PI * 0.5 - 1.1; // begin at the back-left

export interface Segment {
  platform: string;
  t0: number;
  t1: number;
  count: number;
}

export interface Placed {
  l: Listing;
  x: number;
  y: number;
  z: number;
  h: number;
  color: string;
  onRing: boolean;
}

export function ellipse(t: number, grow = 0): [number, number] {
  return [(RING.a + grow) * Math.cos(t), (RING.b + grow) * Math.sin(t)];
}

export function pillarHeight(days: number | null | undefined): number {
  const d = Math.max(0, days ?? 0);
  return 2.2 + 12.5 * Math.min(1, Math.log10(1 + d) / Math.log10(1 + 3650));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function layoutListings(listings: Listing[]): { placed: Placed[]; segments: Segment[] } {
  const ringBuckets = new Map<string, Listing[]>();
  for (const p of ONLINE_DEFAULT) ringBuckets.set(p, []);
  const placed: Placed[] = [];
  for (const l of listings) {
    const w = l.lat != null && l.lon != null ? lonLatToWorld(l.lon, l.lat) : null;
    if (!w) {
      const k = l.platform || 'other';
      if (!ringBuckets.has(k)) ringBuckets.set(k, []);
      ringBuckets.get(k)!.push(l);
      continue;
    }
    const j = hash(l.listing_id);
    const jx = (j - 0.5) * 1.4;
    const jz = (hash(l.listing_id + 'z') - 0.5) * 1.4;
    placed.push({ l, x: w[0] + jx, y: MAP_DEPTH, z: w[1] + jz, h: pillarHeight(l.days_since_recall), color: hazardColor(l.hazard_class), onRing: false });
  }
  const keys = [...ringBuckets.keys()];
  // segment arc length: a floor per platform, the rest shared by listing count
  const free = Math.PI * 2 - GAP * keys.length;
  const floor = Math.min(0.55, free / keys.length);
  const total = keys.reduce((a, k) => a + ringBuckets.get(k)!.length, 0);
  let cursor = START;
  const segments: Segment[] = keys.map((k) => {
    const n = ringBuckets.get(k)!.length;
    const span = floor + (free - floor * keys.length) * (total ? n / total : 1 / keys.length);
    const seg = { platform: k, t0: cursor, t1: cursor + span, count: n };
    cursor += span + GAP;
    return seg;
  });
  segments.forEach((s) => {
    const items = ringBuckets.get(s.platform)!;
    const n = items.length;
    items.forEach((l, i) => {
      const t = s.t0 + ((i + 1) / (n + 1)) * (s.t1 - s.t0);
      const [x, z] = ellipse(t);
      placed.push({ l, x, y: RING.y + 0.06, z, h: pillarHeight(l.days_since_recall), color: hazardColor(l.hazard_class), onRing: true });
    });
  });
  return { placed, segments };
}
