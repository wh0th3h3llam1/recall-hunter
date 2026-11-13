// Recall Guard background (Chrome: MV3 service worker; Firefox: MV3 event page).
// Owns every network call, batching to /v2/match, and the storage.local cache.
import { ext, getSettings } from './common';
import type { Alternative, MatchReply, MatchResult, Msg, Product, RecallUpdate, TabState } from './types';

const TTL_MS = 6 * 60 * 60 * 1000; // verdict cache: 6 h
const TTL_POSSIBLE_MS = 10 * 60 * 1000; // "possible" may be upgraded by Stage 2 in the background; re-ask sooner
const ALT_TTL_MS = 24 * 60 * 60 * 1000;
const CHILD_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH = 40;

interface CacheEntry { r: MatchResult; t: number }

const tabStates = new Map<number, TabState>();

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const cacheKey = (site: string, pid: string) => `v:${site}:${pid}`;

function fresh(e: CacheEntry | undefined): boolean {
  if (!e) return false;
  const ttl = e.r.status === 'possible' ? TTL_POSSIBLE_MS : TTL_MS;
  return Date.now() - e.t < ttl;
}

async function childRecallIds(apiBase: string): Promise<Set<number> | null> {
  const got = (await ext.storage.local.get('childSet')) as { childSet?: { t: number; ids: number[]; base: string } };
  if (got.childSet && got.childSet.base === apiBase && Date.now() - got.childSet.t < CHILD_TTL_MS) {
    return new Set(got.childSet.ids);
  }
  let ids: number[] | null = null;
  try {
    const rows: RecallUpdate[] = await fetchJson(`${apiBase}/v2/recalls/updates?since=2000-01-01T00:00:00Z`);
    ids = rows.filter((r) => r.is_child).map((r) => r.recall_id);
  } catch {
    try {
      const rows: RecallUpdate[] = await fetchJson(`${apiBase}/api/recalls?limit=2000`);
      ids = rows.filter((r) => r.is_child).map((r) => r.recall_id);
    } catch {
      ids = null;
    }
  }
  if (!ids) return null;
  await ext.storage.local.set({ childSet: { t: Date.now(), ids, base: apiBase } });
  return new Set(ids);
}

async function handleMatch(site: string, page_url: string, products: Product[], force = false): Promise<MatchReply> {
  const settings = await getSettings();
  const base = settings.apiBase;
  const uniq = new Map<string, Product>();
  for (const p of products) if (p.product_id && p.title && !uniq.has(p.product_id)) uniq.set(p.product_id, p);
  const keys = [...uniq.keys()].map((id) => cacheKey(site, id));
  const cached = (keys.length ? await ext.storage.local.get(keys) : {}) as Record<string, CacheEntry>;

  const results: MatchResult[] = [];
  const todo: Product[] = [];
  for (const [id, p] of uniq) {
    const e = cached[cacheKey(site, id)];
    if (!force && fresh(e)) results.push(e.r);
    else todo.push(p);
  }

  let offline = false;
  let error: string | undefined;
  for (let i = 0; i < todo.length; i += MAX_BATCH) {
    const chunk = todo.slice(i, i + MAX_BATCH);
    try {
      const body = await fetchJson(`${base}/v2/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, page_url, products: chunk, force }),
      }, 15000);
      const got: MatchResult[] = Array.isArray(body?.results) ? body.results : [];
      const toStore: Record<string, CacheEntry> = {};
      for (const r of got) {
        if (!r || !r.product_id) continue;
        results.push(r);
        toStore[cacheKey(site, r.product_id)] = { r, t: Date.now() };
      }
      if (Object.keys(toStore).length) await ext.storage.local.set(toStore);
    } catch (e) {
      offline = true;
      error = String((e as Error)?.message ?? e);
      // Fall back to stale cache entries if we have any; never invent results.
      for (const p of chunk.slice(0)) {
        const stale = cached[cacheKey(site, p.product_id)];
        if (stale) results.push(stale.r);
      }
    }
  }

  // "Children's products only": hide flags on recalls that aren't children's products.
  if (settings.childOnly) {
    // Newer engine responses say per recall whether it's a children's product; older cached ones fall back to the list.
    const needList = results.some((r) => r.status !== 'clean' && r.recall && typeof r.recall.is_child !== 'boolean');
    const kids = needList ? await childRecallIds(base) : new Set<number>();
    if (kids) {
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const isChild = typeof r.recall?.is_child === 'boolean' ? r.recall.is_child : kids.has(r.recall?.recall_id ?? -1);
        if (r.status !== 'clean' && r.recall && !isChild) {
          results[i] = { ...r, status: 'clean', recall: null, reason: 'filtered: not a children\'s product' };
        }
      }
    }
  }
  return { ok: !offline, offline, error, results };
}

async function handleAlternatives(recall_id: number, title: string): Promise<{ ok: boolean; category?: string; items: Alternative[]; error?: string }> {
  const { apiBase } = await getSettings();
  const k = `alt:${recall_id}`;
  const got = (await ext.storage.local.get(k)) as Record<string, { t: number; category?: string; items: Alternative[] }>;
  const c = got[k];
  if (c && Date.now() - c.t < ALT_TTL_MS && c.items.length) return { ok: true, category: c.category, items: c.items };
  try {
    const q = new URLSearchParams({ recall_id: String(recall_id), title: title.slice(0, 200) });
    const body = await fetchJson(`${apiBase}/v2/alternatives?${q}`, {}, 25000);
    const items: Alternative[] = Array.isArray(body?.items) ? body.items.slice(0, 3) : [];
    if (items.length) await ext.storage.local.set({ [k]: { t: Date.now(), category: body?.category, items } });
    return { ok: true, category: body?.category, items };
  } catch (e) {
    return { ok: false, items: [], error: String((e as Error)?.message ?? e) };
  }
}

async function handleHealth(): Promise<{ ok: boolean; mode: 'v2' | 'v1-only' | 'offline'; index_size?: number; base: string; error?: string }> {
  const { apiBase } = await getSettings();
  try {
    const h = await fetchJson(`${apiBase}/v2/health`, {}, 5000);
    return { ok: !!h?.ok, mode: 'v2', index_size: h?.index_size, base: apiBase };
  } catch (e) {
    try {
      const h = await fetchJson(`${apiBase}/api/health`, {}, 5000);
      return { ok: !!h?.ok, mode: 'v1-only', base: apiBase, error: 'v2 engine not available yet' };
    } catch (e2) {
      return { ok: false, mode: 'offline', base: apiBase, error: String((e2 as Error)?.message ?? e2) };
    }
  }
}

async function handleUpdates(): Promise<{ ok: boolean; items: RecallUpdate[]; source?: string; error?: string }> {
  const { apiBase } = await getSettings();
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const newest = (rows: RecallUpdate[]) =>
    [...rows].sort((a, b) => String(b.recall_date ?? '').localeCompare(String(a.recall_date ?? ''))).slice(0, 5);
  try {
    const rows: RecallUpdate[] = await fetchJson(`${apiBase}/v2/recalls/updates?since=${encodeURIComponent(since)}`, {}, 6000);
    if (Array.isArray(rows) && rows.length) return { ok: true, items: newest(rows), source: 'v2' };
  } catch { /* fall through to v1 */ }
  try {
    const rows: RecallUpdate[] = await fetchJson(`${apiBase}/api/recalls?limit=5`, {}, 6000);
    return { ok: true, items: newest(Array.isArray(rows) ? rows : []), source: 'v1' };
  } catch (e) {
    return { ok: false, items: [], error: String((e as Error)?.message ?? e) };
  }
}

function setActionBadge(tabId: number, s: TabState) {
  const n = s.recalled + s.possible;
  const text = s.offline && n === 0 ? '!' : n > 0 ? String(n) : '';
  const color = s.recalled > 0 ? '#E4572E' : s.possible > 0 ? '#F3A712' : '#6B6B6B';
  try {
    ext.action.setBadgeText({ tabId, text });
    ext.action.setBadgeBackgroundColor({ tabId, color });
  } catch { /* action API can throw for closed tabs */ }
}

async function route(msg: Msg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'match':
      return handleMatch(msg.site, msg.page_url, msg.products ?? [], !!msg.force);
    case 'alternatives':
      return handleAlternatives(msg.recall_id, msg.title);
    case 'report': {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        tabStates.set(tabId, msg.state);
        setActionBadge(tabId, msg.state);
      }
      return { ok: true };
    }
    case 'getTabState': {
      const s = tabStates.get(msg.tabId);
      if (s) return s;
      // Event page / service worker may have restarted: ask the tab directly.
      try {
        return await ext.tabs.sendMessage(msg.tabId, { type: 'getState' });
      } catch {
        return null;
      }
    }
    case 'health':
      return handleHealth();
    case 'updates':
      return handleUpdates();
    default:
      return { ok: false, error: 'unknown message' };
  }
}

ext.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  route(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true; // keep the channel open (works in both Chrome and Firefox)
});

ext.tabs.onRemoved.addListener((tabId) => tabStates.delete(tabId));
ext.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) tabStates.delete(tabId);
});

// Prune expired verdicts once per startup so storage.local doesn't grow forever.
(async () => {
  try {
    const all = (await ext.storage.local.get(null)) as Record<string, any>;
    const dead = Object.keys(all).filter((k) => (k.startsWith('v:') && Date.now() - (all[k]?.t ?? 0) > TTL_MS) ||
      (k.startsWith('alt:') && Date.now() - (all[k]?.t ?? 0) > ALT_TTL_MS));
    if (dead.length) await ext.storage.local.remove(dead);
  } catch { /* ignore */ }
})();
