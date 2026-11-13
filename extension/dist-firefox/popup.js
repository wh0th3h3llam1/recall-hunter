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
  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch, sites: { ...cur.sites, ...patch.sites ?? {} } };
    next.apiBase = (next.apiBase || DEFAULT_API).trim().replace(/\/+$/, "");
    await ext.storage.local.set({ settings: next });
    return next;
  }
  var SITE_LABELS = {
    amazon: "Amazon",
    ebay: "eBay",
    walmart: "Walmart",
    target: "Target",
    generic: "Other stores (schema.org)"
  };
  var HAZARD_COLORS = {
    suffocation: "#E4572E",
    tip_over: "#F3A712",
    ingestion: "#3A86FF",
    choking: "#8AC926",
    fire_burn: "#FF3B1F",
    flammability: "#B5179E",
    entrapment: "#6D597A",
    fall: "#8D99AE",
    shock: "#FFD166",
    laceration: "#EF8354",
    other: "#9A9A9A"
  };
  var hazardColor = (c) => HAZARD_COLORS[c ?? "other"] ?? HAZARD_COLORS.other;
  function fmtDate(d) {
    if (!d) return "\u2014";
    const t = Date.parse(d.length === 10 ? d + "T12:00:00Z" : d);
    if (Number.isNaN(t)) return d;
    return new Date(t).toLocaleDateString(void 0, { year: "numeric", month: "short", day: "numeric" });
  }
  function safeUrl(u) {
    if (!u) return void 0;
    try {
      const p = new URL(u);
      return p.protocol === "https:" || p.protocol === "http:" ? p.href : void 0;
    } catch {
      return void 0;
    }
  }

  // src/popup.ts
  var $ = (id) => document.getElementById(id);
  var ORIGINS = [
    "*://*.amazon.com/*",
    "*://*.ebay.com/*",
    "*://*.walmart.com/*",
    "*://*.target.com/*",
    "http://localhost:8000/*"
  ];
  async function tabCounts() {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const s = await ext.runtime.sendMessage({ type: "getTabState", tabId: tab.id }).catch(() => null);
    const n = s ? s.recalled + s.possible : 0;
    $("count").textContent = String(n);
    $("count").parentElement.classList.toggle("hot", !!s?.recalled);
    $("n-recalled").textContent = String(s?.recalled ?? 0);
    $("n-possible").textContent = String(s?.possible ?? 0);
    $("n-checked").textContent = String(s?.checked ?? 0);
    let host = "";
    try {
      host = tab.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "";
    } catch {
    }
    $("tally-sub").textContent = !s ? host ? `Not active on ${host}.` : "Open a store page to start." : s.offline ? `${s.site}: engine offline, listings not checked.` : `${s.site}: ${s.checked} listing${s.checked === 1 ? "" : "s"} checked.`;
  }
  async function renderSettings() {
    const s = await getSettings();
    const box = $("sites");
    box.replaceChildren();
    for (const key of Object.keys(SITE_LABELS)) {
      const label = document.createElement("label");
      label.className = "row";
      const span = document.createElement("span");
      span.textContent = SITE_LABELS[key];
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = s.sites[key] !== false;
      input.addEventListener("change", () => saveSettings({ sites: { [key]: input.checked } }));
      const sw = document.createElement("i");
      sw.className = "sw";
      label.append(span, input, sw);
      box.append(label);
    }
    const child = $("child-only");
    child.checked = s.childOnly;
    child.onchange = () => saveSettings({ childOnly: child.checked });
    const api = $("api-base");
    api.value = s.apiBase;
    api.onchange = async () => {
      await saveSettings({ apiBase: api.value });
      testApi();
      loadUpdates();
    };
  }
  async function testApi() {
    const st = $("api-status");
    st.className = "status";
    st.textContent = "Testing\u2026";
    const api = $("api-base");
    const s = await getSettings();
    if (api.value.trim().replace(/\/+$/, "") !== s.apiBase) await saveSettings({ apiBase: api.value });
    const r = await ext.runtime.sendMessage({ type: "health" }).catch((e) => ({ ok: false, mode: "offline", error: String(e) }));
    if (r.mode === "v2" && r.ok) {
      st.className = "status ok";
      st.textContent = `Connected \xB7 recall index ${r.index_size ?? "?"} entries`;
    } else if (r.mode === "v1-only") {
      st.className = "status warn";
      st.textContent = "API up, but the v2 match engine is offline";
    } else {
      st.className = "status bad";
      st.textContent = `Engine offline${r.error ? ` (${r.error.slice(0, 60)})` : ""}`;
    }
  }
  async function loadUpdates() {
    const ol = $("updates");
    const r = await ext.runtime.sendMessage({ type: "updates" }).catch(() => null);
    ol.replaceChildren();
    if (!r?.ok || !r.items.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = r?.ok ? "No new recalls." : "Engine offline: recall feed unavailable.";
      ol.append(li);
      return;
    }
    for (const u of r.items) {
      const li = document.createElement("li");
      const bar = document.createElement("span");
      bar.className = "hz";
      bar.style.background = hazardColor(u.hazard_class);
      const body = document.createElement("div");
      const a = document.createElement("a");
      a.textContent = u.title;
      const href = safeUrl(u.url);
      if (href) {
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `#${u.recall_number} \xB7 ${fmtDate(u.recall_date)} \xB7 ${(u.hazard_class ?? "other").replace("_", " ")}${u.is_child ? " \xB7 child" : ""}`;
      body.append(a, meta);
      li.append(bar, body);
      ol.append(li);
    }
  }
  async function checkGrant() {
    try {
      const has = await ext.permissions.contains({ origins: ORIGINS });
      $("grant").hidden = has;
      $("grant-btn").onclick = async () => {
        const ok = await ext.permissions.request({ origins: [...ORIGINS, "<all_urls>"] }).catch(() => false);
        if (ok) $("grant").hidden = true;
      };
    } catch {
    }
  }
  $("api-test").addEventListener("click", () => testApi());
  renderSettings();
  tabCounts();
  testApi();
  loadUpdates();
  checkGrant();
  setInterval(tabCounts, 1500);
})();
