// Recall Guard content script: finds product cards / product pages, asks the background for verdicts, injects badges.
import { generic, pickAdapter, siteName, type Adapter, type CardRef } from './adapters/index';
import { ext, getSettings } from './common';
import type { MatchReply, MatchResult, Product, Settings, TabState } from './types';
import { makeBadge } from './ui/badge';
import { hidePill, makeBanner, showPill } from './ui/banner';

const BATCH_MS = 300;
const MAX_BATCH = 40;

interface Instance { dispose(): void; state: TabState }

const g = globalThis as any;
let current: Instance | null = null;

async function boot() {
  current?.dispose();
  current = null;
  try {
    current = await run();
  } catch (e) {
    console.debug('[Recall Guard]', e);
  }
}

let forceNext = false; // set by the popup's "Re-check this page"

if (!g.__recallGuardLoaded && document.documentElement) {
  g.__recallGuardLoaded = true;
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) boot();
  });
  ext.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === 'getState') sendResponse(current ? { ...current.state } : null);
    if (msg?.type === 'recheck') { forceNext = true; boot(); sendResponse({ ok: true }); }
  });
  boot();
}

async function run(): Promise<Instance> {
  const loc = location;
  const adapter = pickAdapter(document, loc);
  const site = siteName(adapter, loc);
  const settings: Settings = await getSettings();
  let disposed = false;
  const force = forceNext;
  forceNext = false;

  const seen = new WeakSet<Element>();
  const cardState = new Map<string, { refs: CardRef[]; result?: MatchResult }>();
  const injected = new Set<HTMLElement>();
  let queue: CardRef[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state: TabState = { site, recalled: 0, possible: 0, checked: 0, offline: false };
  let bannerFor: string | null = null;
  let io: IntersectionObserver | null = null;
  let mo: MutationObserver | null = null;

  const enabled = () => settings.sites[adapter.key] !== false;

  function recount() {
    let recalled = 0, possible = 0, checked = 0, hidden = 0;
    for (const s of cardState.values()) {
      if (!s.result) continue;
      checked++;
      if (s.result.reason?.startsWith('filtered:')) hidden++;
      if (s.result.status === 'recalled') recalled++;
      else if (s.result.status === 'possible') possible++;
    }
    Object.assign(state, { recalled, possible, checked, hidden });
    ext.runtime.sendMessage({ type: 'report', state: { ...state } }).catch(() => {});
  }

  function applyResult(r: MatchResult) {
    if (disposed) return;
    const s = cardState.get(r.product_id);
    if (!s) return;
    s.result = r;
    for (const ref of s.refs) {
      ref.el.querySelectorAll(':scope [data-recall-guard="badge"]').forEach((n) => n.remove());
      const badge = makeBadge(r);
      if (!badge) continue;
      if (ref.anchor.isConnected && ref.el.contains(ref.anchor)) ref.anchor.parentNode!.insertBefore(badge, ref.anchor);
      else ref.el.prepend(badge);
      injected.add(badge);
    }
  }

  async function sendMatch(products: Product[]): Promise<MatchReply | null> {
    try {
      const reply = (await ext.runtime.sendMessage({ type: 'match', site, page_url: location.href, products, force })) as MatchReply;
      if (reply?.offline) {
        state.offline = true;
        state.error = reply.error;
        showPill('Recall Guard: engine offline, listings not checked');
      } else if (reply) {
        state.offline = false;
        state.error = undefined;
        hidePill();
      }
      return reply;
    } catch (e) {
      state.offline = true;
      state.error = String(e);
      return null;
    }
  }

  async function flush() {
    timer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, MAX_BATCH);
    if (queue.length) timer = setTimeout(flush, BATCH_MS);
    const products = [...new Map(batch.map((c) => [c.product.product_id, c.product])).values()];
    const reply = await sendMatch(products);
    for (const r of reply?.results ?? []) applyResult(r);
    recount();
  }

  function enqueue(el: Element) {
    if (seen.has(el) || !adapter.extractCard) return;
    const ref = adapter.extractCard(el, loc);
    if (!ref) return; // maybe not hydrated yet; a later mutation will retry
    seen.add(el);
    const s = cardState.get(ref.product.product_id);
    if (s) {
      s.refs.push(ref);
      if (s.result) applyResult(s.result);
      return;
    }
    cardState.set(ref.product.product_id, { refs: [ref] });
    queue.push(ref);
    if (!timer) timer = setTimeout(flush, BATCH_MS);
  }

  function observeCards() {
    if (!adapter.cardSelector) return;
    if (!io) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io!.unobserve(e.target);
            enqueue(e.target);
          }
        }
      }, { rootMargin: '300px 0px' });
    }
    for (const el of document.querySelectorAll(adapter.cardSelector)) {
      if (!seen.has(el) && !(el as any).__rgObserved) {
        (el as any).__rgObserved = true;
        io.observe(el);
      }
    }
  }

  async function productPage() {
    // Site adapter first, then the schema.org / og: fallback (product pages only).
    let ref = adapter.productPage?.(document, loc) ?? null;
    let key = adapter.key;
    if (!ref && settings.sites.generic !== false) {
      ref = generic.productPage!(document, loc);
      key = 'generic';
    }
    if (!ref || (key === 'generic' && settings.sites.generic === false)) return;
    const pid = ref.product.product_id;
    if (bannerFor === pid) return;
    bannerFor = pid;
    const dismissKey = `dismissed:${site}:${pid}`;
    const got = (await ext.storage.local.get(dismissKey)) as Record<string, number>;
    const reply = await sendMatch([ref.product]);
    const r = reply?.results?.find((x) => x.product_id === pid);
    if (r) {
      cardState.set(pid, { refs: [], result: r });
      recount();
    }
    if (disposed || !r || r.status === 'clean' || !r.recall || got[dismissKey]) return;
    const banner = makeBanner(r, () => { ext.storage.local.set({ [dismissKey]: Date.now() }); });
    if (!banner) return;
    ref.mount(banner.host);
    injected.add(banner.host);
    banner.setAlternatives({ loading: true });
    const alts = (await ext.runtime.sendMessage({ type: 'alternatives', recall_id: r.recall.recall_id, title: ref.product.title }).catch(() => null)) as
      { ok: boolean; items: any[]; error?: string } | null;
    banner.setAlternatives(alts?.ok ? { items: alts.items } : { error: alts?.error ?? 'offline' });
  }

  function start() {
    if (!enabled()) return;
    observeCards();
    productPage();
    let pending = false;
    mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        observeCards();
        // SPA navigations (eBay/Amazon swap content in place): re-check the product page.
        productPage();
      }, 250);
    });
    mo.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  }

  function stop() {
    disposed = true;
    if (timer) clearTimeout(timer);
    mo?.disconnect();
    io?.disconnect();
    mo = null;
    io = null;
    for (const n of injected) n.remove();
    document.querySelectorAll('[data-recall-guard="badge"]').forEach((n) => n.remove());
    injected.clear();
    cardState.clear();
    queue = [];
    bannerFor = null;
    for (const el of document.querySelectorAll(adapter.cardSelector ?? '__none__')) (el as any).__rgObserved = false;
    Object.assign(state, { recalled: 0, possible: 0, checked: 0 });
  }

  start();
  recount();
  return { dispose: stop, state };
}
