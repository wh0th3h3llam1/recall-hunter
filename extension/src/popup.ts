import { ext, fmtDate, getSettings, hazardColor, safeUrl, saveSettings, SITE_LABELS } from './common';
import type { RecallUpdate, SiteKey, TabState } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ORIGINS = [
  '*://*.amazon.com/*', '*://*.ebay.com/*', '*://*.walmart.com/*', '*://*.target.com/*', 'http://localhost:8000/*',
];

async function tabCounts() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const s = (await ext.runtime.sendMessage({ type: 'getTabState', tabId: tab.id }).catch(() => null)) as TabState | null;
  const n = s ? s.recalled + s.possible : 0;
  $('count').textContent = String(n);
  $('count').parentElement!.classList.toggle('hot', !!s?.recalled);
  $('n-recalled').textContent = String(s?.recalled ?? 0);
  $('n-possible').textContent = String(s?.possible ?? 0);
  $('n-checked').textContent = String(s?.checked ?? 0);
  let host = '';
  try { host = tab.url ? new URL(tab.url).hostname.replace(/^www\./, '') : ''; } catch { /* ignore */ }
  $('tally-sub').textContent = !s
    ? host ? `Not active on ${host}.` : 'Open a store page to start.'
    : s.offline
      ? `${s.site}: engine offline, listings not checked.`
      : `${s.site}: ${s.checked} listing${s.checked === 1 ? '' : 's'} checked.`;
}

async function renderSettings() {
  const s = await getSettings();
  const box = $('sites');
  box.replaceChildren();
  for (const key of Object.keys(SITE_LABELS) as SiteKey[]) {
    const label = document.createElement('label');
    label.className = 'row';
    const span = document.createElement('span');
    span.textContent = SITE_LABELS[key];
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = s.sites[key] !== false;
    input.addEventListener('change', () => saveSettings({ sites: { [key]: input.checked } as any }));
    const sw = document.createElement('i');
    sw.className = 'sw';
    label.append(span, input, sw);
    box.append(label);
  }
  const child = $<HTMLInputElement>('child-only');
  child.checked = s.childOnly;
  child.onchange = () => saveSettings({ childOnly: child.checked });
  const api = $<HTMLInputElement>('api-base');
  api.value = s.apiBase;
  api.onchange = async () => {
    await saveSettings({ apiBase: api.value });
    testApi();
    loadUpdates();
  };
}

async function testApi() {
  const st = $('api-status');
  st.className = 'status';
  st.textContent = 'Testing…';
  const api = $<HTMLInputElement>('api-base');
  const s = await getSettings();
  if (api.value.trim().replace(/\/+$/, '') !== s.apiBase) await saveSettings({ apiBase: api.value });
  const r = (await ext.runtime.sendMessage({ type: 'health' }).catch((e) => ({ ok: false, mode: 'offline', error: String(e) }))) as
    { ok: boolean; mode: string; index_size?: number; error?: string };
  if (r.mode === 'v2' && r.ok) {
    st.className = 'status ok';
    st.textContent = `Connected · recall index ${r.index_size ?? '?'} entries`;
  } else if (r.mode === 'v1-only') {
    st.className = 'status warn';
    st.textContent = 'API up, but the v2 match engine is offline';
  } else {
    st.className = 'status bad';
    st.textContent = `Engine offline${r.error ? ` (${r.error.slice(0, 60)})` : ''}`;
  }
}

async function loadUpdates() {
  const ol = $('updates');
  const r = (await ext.runtime.sendMessage({ type: 'updates' }).catch(() => null)) as { ok: boolean; items: RecallUpdate[] } | null;
  ol.replaceChildren();
  if (!r?.ok || !r.items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = r?.ok ? 'No new recalls.' : 'Engine offline: recall feed unavailable.';
    ol.append(li);
    return;
  }
  for (const u of r.items) {
    const li = document.createElement('li');
    const bar = document.createElement('span');
    bar.className = 'hz';
    bar.style.background = hazardColor(u.hazard_class);
    const body = document.createElement('div');
    const a = document.createElement('a');
    a.textContent = u.title;
    const href = safeUrl(u.url);
    if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `#${u.recall_number} · ${fmtDate(u.recall_date)} · ${(u.hazard_class ?? 'other').replace('_', ' ')}${u.is_child ? ' · child' : ''}`;
    body.append(a, meta);
    li.append(bar, body);
    ol.append(li);
  }
}

async function checkGrant() {
  // Firefox MV3 may leave host permissions ungranted (they're opt-in there); offer a one-click grant.
  try {
    const has = await ext.permissions.contains({ origins: ORIGINS });
    $('grant').hidden = has;
    $('grant-btn').onclick = async () => {
      const ok = await ext.permissions.request({ origins: [...ORIGINS, '<all_urls>'] }).catch(() => false);
      if (ok) $('grant').hidden = true;
    };
  } catch { /* permissions API unavailable */ }
}

$('api-test').addEventListener('click', () => testApi());
$('recheck').addEventListener('click', async () => {
  // Re-checks only the products on the current tab (supported store pages), skipping cached verdicts.
  const b = $<HTMLButtonElement>('recheck');
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  b.disabled = true; b.textContent = 'Re-checking…';
  const ok = await ext.tabs.sendMessage(tab.id, { type: 'recheck' }).catch(() => null);
  if (!ok) { b.textContent = 'Not a store page'; b.disabled = false; return; }
  for (const ms of [1500, 4000, 12000]) setTimeout(tabCounts, ms);
  setTimeout(() => { b.disabled = false; b.textContent = 'Re-check this page'; }, 12000);
});
renderSettings();
tabCounts();
testApi();
loadUpdates();
checkGrant();
setInterval(tabCounts, 1500);
