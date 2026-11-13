// Site adapters: pure DOM -> Product extraction. No extension APIs here, so they run under jsdom in tests.
import type { Product, SiteKey } from '../types';

export interface CardRef {
  el: Element;
  product: Product;
  /** The badge host is inserted immediately before this element (kept outside the card's link where possible). */
  anchor: Element;
}

export interface ProductPageRef {
  product: Product;
  /** Inserts the banner host into the page. */
  mount(host: HTMLElement): void;
}

export interface Adapter {
  key: SiteKey;
  site: string;
  detect(doc: Document, loc: Location | URL): boolean;
  cardSelector?: string;
  extractCard?(el: Element, loc: Location | URL): CardRef | null;
  productPage?(doc: Document, loc: Location | URL): ProductPageRef | null;
}

// ---------- helpers ----------
const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function abs(u: string | null | undefined, loc: Location | URL): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u, loc.href).href;
  } catch {
    return undefined;
  }
}

function imgSrc(img: Element | null, loc: Location | URL): string | undefined {
  if (!img) return undefined;
  const cand = img.getAttribute('data-old-hires') || img.getAttribute('src') || img.getAttribute('data-src') ||
    img.getAttribute('data-zoom-src') || (img.getAttribute('srcset') ?? '').split(/\s+/)[0];
  if (!cand || cand.startsWith('data:')) {
    const alt = img.getAttribute('data-src') || img.getAttribute('data-zoom-src');
    return alt ? abs(alt, loc) : undefined;
  }
  return abs(cand, loc);
}

function hostIs(loc: Location | URL, domain: string) {
  const h = loc.hostname.toLowerCase();
  return h === domain || h.endsWith('.' + domain);
}

function insertBefore(host: HTMLElement, ref: Element | null, fallbackParent: Element) {
  if (ref?.parentNode) ref.parentNode.insertBefore(host, ref);
  else fallbackParent.prepend(host);
}

// ---------- Amazon ----------
const AMAZON_CARD = 'div[data-component-type="s-search-result"][data-asin]';

export const amazon: Adapter = {
  key: 'amazon',
  site: 'amazon.com',
  detect: (doc, loc) => /(^|\.)amazon\.[a-z.]+$/i.test(loc.hostname) || !!doc.querySelector(AMAZON_CARD) || !!doc.querySelector('#productTitle'),
  cardSelector: AMAZON_CARD,
  extractCard(el, loc) {
    const asin = (el.getAttribute('data-asin') ?? '').trim();
    if (!asin) return null;
    // Newer layouts have two h2s: a brand row and the linked title. Prefer the linked / aria-labelled / longest one.
    const h2s = [...el.querySelectorAll('h2')];
    const h2 = h2s.find((x) => x.closest('a')) ?? h2s.find((x) => x.hasAttribute('aria-label')) ??
      h2s.sort((a, b) => txt(b).length - txt(a).length)[0];
    if (!h2) return null;
    let title = txt(h2) || (h2.getAttribute('aria-label') ?? '');
    title = title.replace(/^Sponsored Ad\s*[-–]\s*/i, '').replace(/^Sponsored\s+/i, '').trim();
    if (!title) return null;
    // Brand line sits above the title on many layouts (".a-size-base-plus.a-color-base" inside the title recipe).
    let brand = '';
    for (const b of el.querySelectorAll('[data-cy="title-recipe"] h2 span, [data-cy="title-recipe"] .a-row span.a-size-base-plus, [data-cy="title-recipe"] .a-row span.a-size-medium, .s-title-instructions-style .a-row .a-size-base-plus')) {
      const t = txt(b);
      if (t && t !== title && !h2.contains(b) && t.length < 60) { brand = t; break; }
    }
    const price = txt(el.querySelector('.a-price .a-offscreen')) || undefined;
    const link = h2.closest('a') ?? el.querySelector('a.a-link-normal[href*="/dp/"]') ?? el.querySelector('a[href*="/dp/"]');
    const url = abs(link?.getAttribute('href'), loc) ?? abs(`/dp/${asin}`, loc);
    const image_url = imgSrc(el.querySelector('img.s-image'), loc);
    const anchor = h2.closest('a') ?? h2;
    return { el, anchor, product: { product_id: asin, title, brand: brand || undefined, price, image_url, url } };
  },
  productPage(doc, loc) {
    const titleEl = doc.querySelector('#productTitle');
    if (!titleEl) return null;
    const title = txt(titleEl);
    const m = loc.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    const asin = (m?.[1] ?? (doc.querySelector('input#ASIN') as HTMLInputElement | null)?.value ?? '').toUpperCase();
    if (!asin || !title) return null;
    const byline = txt(doc.querySelector('#bylineInfo'));
    const brand = byline.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim() || undefined;
    const price = txt(doc.querySelector('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen')) || undefined;
    let model = '';
    for (const row of doc.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, #poExpander tr, .po-model_name')) {
      const t = txt(row);
      const mm = t.match(/(?:Item model number|Model Number|Model Name|Model)\s*[:‏‎]*\s*([^\s:][^:]{0,40}?)$/i);
      if (mm) { model = mm[1].trim(); break; }
    }
    const image_url = imgSrc(doc.querySelector('#landingImage, #imgBlkFront, #main-image'), loc);
    return {
      product: { product_id: asin, title, brand, price, image_url, model: model || undefined, url: abs(`/dp/${asin}`, loc) },
      mount(host) {
        const ppd = doc.querySelector('#ppd');
        if (ppd) insertBefore(host, ppd, doc.body);
        else (doc.querySelector('#dp-container') ?? doc.querySelector('#dp') ?? doc.body).prepend(host);
      },
    };
  },
};

// ---------- eBay ----------
const EBAY_CARD = 'li.s-card, li.s-item';
const ebayItemId = (href: string | null | undefined) => href?.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/)?.[1];

export const ebay: Adapter = {
  key: 'ebay',
  site: 'ebay.com',
  detect: (doc, loc) => /(^|\.)ebay\.[a-z.]+$/i.test(loc.hostname) || !!doc.querySelector('li.s-card a[href*="/itm/"], li.s-item a[href*="/itm/"]') || !!doc.querySelector('h1.x-item-title__mainTitle'),
  cardSelector: EBAY_CARD,
  extractCard(el, loc) {
    const link = el.querySelector('a[href*="/itm/"]');
    const id = ebayItemId(link?.getAttribute('href'));
    if (!id || id === '123456') return null; // eBay's hidden template row
    const titleEl = el.querySelector('.s-card__title, .s-item__title');
    if (!titleEl) return null;
    // Drop screen-reader suffixes / badges that live inside the title node.
    const clone = titleEl.cloneNode(true) as Element;
    clone.querySelectorAll('.clipped, .LIGHT_HIGHLIGHT, .s-card__new-listing, [role="text"] > .clipped').forEach((n) => n.remove());
    const title = txt(clone).replace(/^New Listing\s*/i, '').replace(/Opens in a new window or tab$/i, '').trim();
    if (!title || /^Shop on eBay$/i.test(title)) return null;
    const price = txt(el.querySelector('.s-card__price, .s-item__price')) || undefined;
    const image_url = imgSrc(el.querySelector('.s-card__image img, .s-item__image img, img'), loc);
    const url = abs(link?.getAttribute('href'), loc)?.split('?')[0];
    const anchor = titleEl.closest('a') ?? titleEl;
    return { el, anchor, product: { product_id: id, title, price, image_url, url } };
  },
  productPage(doc, loc) {
    const h1 = doc.querySelector('h1.x-item-title__mainTitle');
    if (!h1) return null;
    const id = ebayItemId(loc.pathname);
    const title = txt(h1);
    if (!id || !title) return null;
    const img = doc.querySelector('#icImg') ?? doc.querySelector('.ux-image-carousel-item.active img') ?? doc.querySelector('.ux-image-carousel img');
    const price = txt(doc.querySelector('.x-price-primary')) || undefined;
    const brand = txt(doc.querySelector('.ux-labels-values--brand .ux-labels-values__values')) || undefined;
    const model = txt(doc.querySelector('.ux-labels-values--model .ux-labels-values__values, .ux-labels-values--mpn .ux-labels-values__values')) || undefined;
    const upc = txt(doc.querySelector('.ux-labels-values--upc .ux-labels-values__values')).replace(/\D/g, '') || undefined;
    return {
      product: { product_id: id, title, brand, price, model, upc, image_url: imgSrc(img, loc), url: `https://www.ebay.com/itm/${id}` },
      mount(host) {
        const main = doc.querySelector('#mainContent') ?? doc.querySelector('.vim.x-item-title')?.closest('.main-container') ?? doc.body;
        main.prepend(host);
      },
    };
  },
};

// ---------- Walmart (best effort; product pages also covered by the schema.org fallback) ----------
export const walmart: Adapter = {
  key: 'walmart',
  site: 'walmart.com',
  detect: (_d, loc) => hostIs(loc, 'walmart.com'),
  cardSelector: 'div[data-item-id]',
  extractCard(el, loc) {
    const id = el.getAttribute('data-item-id');
    const titleEl = el.querySelector('[data-automation-id="product-title"], span.w_iUH7, a span');
    const title = txt(titleEl);
    if (!id || !title) return null;
    const link = el.querySelector('a[href*="/ip/"]');
    const price = txt(el.querySelector('[data-automation-id="product-price"] .w_iUH7, [data-automation-id="product-price"]'))?.split(/current price/i).pop()?.trim() || undefined;
    return { el, anchor: titleEl ?? el.firstElementChild ?? el, product: { product_id: id, title, price, image_url: imgSrc(el.querySelector('img'), loc), url: abs(link?.getAttribute('href'), loc) } };
  },
};

// ---------- Target (best effort) ----------
export const target: Adapter = {
  key: 'target',
  site: 'target.com',
  detect: (_d, loc) => hostIs(loc, 'target.com'),
  cardSelector: '[data-test="@web/site-top-of-funnel/ProductCardWrapper"], [data-test="product-grid"] section',
  extractCard(el, loc) {
    const a = el.querySelector('a[data-test="product-title"], a[href*="/A-"]');
    const id = a?.getAttribute('href')?.match(/\/A-(\d+)/)?.[1];
    const title = txt(a) || (a?.getAttribute('aria-label') ?? '');
    if (!id || !title) return null;
    const price = txt(el.querySelector('[data-test="current-price"]')) || undefined;
    return { el, anchor: a!, product: { product_id: id, title, price, image_url: imgSrc(el.querySelector('img'), loc), url: abs(a?.getAttribute('href'), loc) } };
  },
};

// ---------- Generic fallback: schema.org Product JSON-LD / og: tags, product pages only ----------
function findProductLd(doc: Document): any | null {
  const scan = (node: any): any | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const n of node) { const f = scan(n); if (f) return f; }
      return null;
    }
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => typeof x === 'string' && /^(https?:\/\/schema\.org\/)?(Product|ProductGroup)$/i.test(x))) return node;
    if (node['@graph']) return scan(node['@graph']);
    if (node.mainEntity) return scan(node.mainEntity);
    return null;
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const f = scan(JSON.parse(s.textContent ?? ''));
      if (f) return f;
    } catch { /* malformed JSON-LD is common */ }
  }
  return null;
}

const meta = (doc: Document, p: string) =>
  doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute('content')?.trim() || '';

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'u' + (h >>> 0).toString(36);
}

export const generic: Adapter = {
  key: 'generic',
  site: '',
  detect: () => true,
  productPage(doc, loc) {
    const ld = findProductLd(doc);
    const ogType = meta(doc, 'og:type').toLowerCase();
    const isProduct = !!ld || ogType === 'product' || ogType === 'product.item' || ogType === 'og:product' ||
      !!doc.querySelector('[itemtype$="schema.org/Product"]');
    if (!isProduct) return null;
    const itemprop = (p: string) => {
      const n = doc.querySelector(`[itemtype$="schema.org/Product"] [itemprop="${p}"]`);
      return (n?.getAttribute('content') || txt(n)) ?? '';
    };
    const title = String(ld?.name ?? '').trim() || meta(doc, 'og:title') || itemprop('name');
    if (!title) return null;
    let image = ld?.image;
    if (Array.isArray(image)) image = image[0];
    if (image && typeof image === 'object') image = image.url ?? image.contentUrl;
    const brandRaw = ld?.brand;
    const brand = (typeof brandRaw === 'string' ? brandRaw : brandRaw?.name) || meta(doc, 'product:brand') || itemprop('brand') || undefined;
    const offers = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
    const priceVal = offers?.price ?? offers?.lowPrice ?? meta(doc, 'product:price:amount');
    const cur = offers?.priceCurrency ?? meta(doc, 'product:price:currency');
    const price = priceVal ? `${cur === 'USD' || !cur ? '$' : cur + ' '}${priceVal}` : undefined;
    const upc = String(ld?.gtin12 ?? ld?.gtin13 ?? ld?.gtin ?? '').replace(/\D/g, '') || undefined;
    const model = String(ld?.model?.name ?? ld?.model ?? ld?.mpn ?? '').trim() || undefined;
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || meta(doc, 'og:url') || loc.href.split('#')[0];
    const pid = String(ld?.sku ?? ld?.productID ?? upc ?? '').trim() || hashId(canonical);
    return {
      product: {
        product_id: pid,
        title,
        brand: brand ? String(brand) : undefined,
        price,
        image_url: abs(typeof image === 'string' ? image : meta(doc, 'og:image'), loc),
        model,
        upc,
        url: abs(canonical, loc),
      },
      mount(host) {
        const main = doc.querySelector('main') ?? doc.body;
        main.prepend(host);
      },
    };
  },
};

export const ADAPTERS: Adapter[] = [amazon, ebay, walmart, target];

/** Pick the site adapter for this page; the generic fallback is handled separately (product pages only). */
export function pickAdapter(doc: Document, loc: Location | URL): Adapter {
  for (const a of ADAPTERS) if (a.detect(doc, loc)) return a;
  return generic;
}

export function siteName(a: Adapter, loc: Location | URL): string {
  return a.site || loc.hostname.replace(/^www\./, '');
}

/** All extractable cards currently in the DOM (used by tests and the content script's initial scan). */
export function extractAllCards(a: Adapter, doc: Document, loc: Location | URL): CardRef[] {
  if (!a.cardSelector || !a.extractCard) return [];
  const out: CardRef[] = [];
  for (const el of doc.querySelectorAll(a.cardSelector)) {
    const c = a.extractCard(el, loc);
    if (c) out.push(c);
  }
  return out;
}
