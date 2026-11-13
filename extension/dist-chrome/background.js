"use strict";
(() => {
  // src/common.ts
  var ext = globalThis.browser ?? globalThis.chrome;
  var DEFAULT_API = "https://recall-hunter-ay2po.ondigitalocean.app";
  var DEFAULT_SETTINGS = {
    apiBase: DEFAULT_API,
    sites: { amazon: true, ebay: true, walmart: true, target: true, generic: true },
    childOnly: false
  };
  async function getSettings() {
    const got = await ext.storage.local.get("settings");
    const s = got.settings ?? {};
    return {
      apiBase: (s.apiBase || DEFAULT_API).replace(/\/+$/, ""),
      sites: { ...DEFAULT_SETTINGS.sites, ...s.sites ?? {} },
      childOnly: !!s.childOnly
    };
  }

  // src/background.ts
  var TTL_MS = 6 * 60 * 60 * 1e3;
  var TTL_POSSIBLE_MS = 10 * 60 * 1e3;
  var ALT_TTL_MS = 24 * 60 * 60 * 1e3;
  var CHILD_TTL_MS = 6 * 60 * 60 * 1e3;
  var MAX_BATCH = 40;
  var tabStates = /* @__PURE__ */ new Map();
  async function fetchJson(url, init = {}, timeoutMs = 1e4) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal, credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  var cacheKey = (site, pid) => `v:${site}:${pid}`;
  function fresh(e) {
    if (!e) return false;
    const ttl = e.r.status === "possible" ? TTL_POSSIBLE_MS : TTL_MS;
    return Date.now() - e.t < ttl;
  }
  async function childRecallIds(apiBase) {
    const got = await ext.storage.local.get("childSet");
    if (got.childSet && got.childSet.base === apiBase && Date.now() - got.childSet.t < CHILD_TTL_MS) {
      return new Set(got.childSet.ids);
    }
    let ids = null;
    try {
      const rows = await fetchJson(`${apiBase}/v2/recalls/updates?since=2000-01-01T00:00:00Z`);
      ids = rows.filter((r) => r.is_child).map((r) => r.recall_id);
    } catch {
      try {
        const rows = await fetchJson(`${apiBase}/api/recalls?limit=2000`);
        ids = rows.filter((r) => r.is_child).map((r) => r.recall_id);
      } catch {
        ids = null;
      }
    }
    if (!ids) return null;
    await ext.storage.local.set({ childSet: { t: Date.now(), ids, base: apiBase } });
    return new Set(ids);
  }
  async function handleMatch(site, page_url, products) {
    const settings = await getSettings();
    const base = settings.apiBase;
    const uniq = /* @__PURE__ */ new Map();
    for (const p of products) if (p.product_id && p.title && !uniq.has(p.product_id)) uniq.set(p.product_id, p);
    const keys = [...uniq.keys()].map((id) => cacheKey(site, id));
    const cached = keys.length ? await ext.storage.local.get(keys) : {};
    const results = [];
    const todo = [];
    for (const [id, p] of uniq) {
      const e = cached[cacheKey(site, id)];
      if (fresh(e)) results.push(e.r);
      else todo.push(p);
    }
    let offline = false;
    let error;
    for (let i = 0; i < todo.length; i += MAX_BATCH) {
      const chunk = todo.slice(i, i + MAX_BATCH);
      try {
        const body = await fetchJson(`${base}/v2/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site, page_url, products: chunk })
        }, 15e3);
        const got = Array.isArray(body?.results) ? body.results : [];
        const toStore = {};
        for (const r of got) {
          if (!r || !r.product_id) continue;
          results.push(r);
          toStore[cacheKey(site, r.product_id)] = { r, t: Date.now() };
        }
        if (Object.keys(toStore).length) await ext.storage.local.set(toStore);
      } catch (e) {
        offline = true;
        error = String(e?.message ?? e);
        for (const p of chunk.slice(0)) {
          const stale = cached[cacheKey(site, p.product_id)];
          if (stale) results.push(stale.r);
        }
      }
    }
    if (settings.childOnly) {
      const kids = await childRecallIds(base);
      if (kids) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status !== "clean" && r.recall && !kids.has(r.recall.recall_id)) {
            results[i] = { ...r, status: "clean", recall: null, reason: "filtered: not a children's product" };
          }
        }
      }
    }
    return { ok: !offline, offline, error, results };
  }
  async function handleAlternatives(recall_id, title) {
    const { apiBase } = await getSettings();
    const k = `alt:${recall_id}`;
    const got = await ext.storage.local.get(k);
    const c = got[k];
    if (c && Date.now() - c.t < ALT_TTL_MS && c.items.length) return { ok: true, category: c.category, items: c.items };
    try {
      const q = new URLSearchParams({ recall_id: String(recall_id), title: title.slice(0, 200) });
      const body = await fetchJson(`${apiBase}/v2/alternatives?${q}`, {}, 25e3);
      const items = Array.isArray(body?.items) ? body.items.slice(0, 3) : [];
      if (items.length) await ext.storage.local.set({ [k]: { t: Date.now(), category: body?.category, items } });
      return { ok: true, category: body?.category, items };
    } catch (e) {
      return { ok: false, items: [], error: String(e?.message ?? e) };
    }
  }
  async function handleHealth() {
    const { apiBase } = await getSettings();
    try {
      const h = await fetchJson(`${apiBase}/v2/health`, {}, 5e3);
      return { ok: !!h?.ok, mode: "v2", index_size: h?.index_size, base: apiBase };
    } catch (e) {
      try {
        const h = await fetchJson(`${apiBase}/api/health`, {}, 5e3);
        return { ok: !!h?.ok, mode: "v1-only", base: apiBase, error: "v2 engine not available yet" };
      } catch (e2) {
        return { ok: false, mode: "offline", base: apiBase, error: String(e2?.message ?? e2) };
      }
    }
  }
  async function handleUpdates() {
    const { apiBase } = await getSettings();
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    const newest = (rows) => [...rows].sort((a, b) => String(b.recall_date ?? "").localeCompare(String(a.recall_date ?? ""))).slice(0, 5);
    try {
      const rows = await fetchJson(`${apiBase}/v2/recalls/updates?since=${encodeURIComponent(since)}`, {}, 6e3);
      if (Array.isArray(rows) && rows.length) return { ok: true, items: newest(rows), source: "v2" };
    } catch {
    }
    try {
      const rows = await fetchJson(`${apiBase}/api/recalls?limit=5`, {}, 6e3);
      return { ok: true, items: newest(Array.isArray(rows) ? rows : []), source: "v1" };
    } catch (e) {
      return { ok: false, items: [], error: String(e?.message ?? e) };
    }
  }
  function setActionBadge(tabId, s) {
    const n = s.recalled + s.possible;
    const text = s.offline && n === 0 ? "!" : n > 0 ? String(n) : "";
    const color = s.recalled > 0 ? "#E4572E" : s.possible > 0 ? "#F3A712" : "#6B6B6B";
    try {
      ext.action.setBadgeText({ tabId, text });
      ext.action.setBadgeBackgroundColor({ tabId, color });
    } catch {
    }
  }
  async function route(msg, sender) {
    switch (msg.type) {
      case "match":
        return handleMatch(msg.site, msg.page_url, msg.products ?? []);
      case "alternatives":
        return handleAlternatives(msg.recall_id, msg.title);
      case "report": {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          tabStates.set(tabId, msg.state);
          setActionBadge(tabId, msg.state);
        }
        return { ok: true };
      }
      case "getTabState": {
        const s = tabStates.get(msg.tabId);
        if (s) return s;
        try {
          return await ext.tabs.sendMessage(msg.tabId, { type: "getState" });
        } catch {
          return null;
        }
      }
      case "health":
        return handleHealth();
      case "updates":
        return handleUpdates();
      default:
        return { ok: false, error: "unknown message" };
    }
  }
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    route(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });
  ext.tabs.onRemoved.addListener((tabId) => tabStates.delete(tabId));
  ext.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "loading" && info.url) tabStates.delete(tabId);
  });
  (async () => {
    try {
      const all = await ext.storage.local.get(null);
      const dead = Object.keys(all).filter((k) => k.startsWith("v:") && Date.now() - (all[k]?.t ?? 0) > TTL_MS || k.startsWith("alt:") && Date.now() - (all[k]?.t ?? 0) > ALT_TTL_MS);
      if (dead.length) await ext.storage.local.remove(dead);
    } catch {
    }
  })();
})();
