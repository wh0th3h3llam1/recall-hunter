"use strict";
(() => {
  // src/adapters/index.ts
  var txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  function abs(u, loc) {
    if (!u) return void 0;
    try {
      return new URL(u, loc.href).href;
    } catch {
      return void 0;
    }
  }
  function imgSrc(img, loc) {
    if (!img) return void 0;
    const cand = img.getAttribute("data-old-hires") || img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-zoom-src") || (img.getAttribute("srcset") ?? "").split(/\s+/)[0];
    if (!cand || cand.startsWith("data:")) {
      const alt = img.getAttribute("data-src") || img.getAttribute("data-zoom-src");
      return alt ? abs(alt, loc) : void 0;
    }
    return abs(cand, loc);
  }
  function hostIs(loc, domain) {
    const h2 = loc.hostname.toLowerCase();
    return h2 === domain || h2.endsWith("." + domain);
  }
  function insertBefore(host, ref, fallbackParent) {
    if (ref?.parentNode) ref.parentNode.insertBefore(host, ref);
    else fallbackParent.prepend(host);
  }
  var AMAZON_CARD = 'div[data-component-type="s-search-result"][data-asin]';
  var amazon = {
    key: "amazon",
    site: "amazon.com",
    detect: (doc, loc) => /(^|\.)amazon\.[a-z.]+$/i.test(loc.hostname) || !!doc.querySelector(AMAZON_CARD) || !!doc.querySelector("#productTitle"),
    cardSelector: AMAZON_CARD,
    extractCard(el, loc) {
      const asin = (el.getAttribute("data-asin") ?? "").trim();
      if (!asin) return null;
      const h2s = [...el.querySelectorAll("h2")];
      const h2 = h2s.find((x) => x.closest("a")) ?? h2s.find((x) => x.hasAttribute("aria-label")) ?? h2s.sort((a, b) => txt(b).length - txt(a).length)[0];
      if (!h2) return null;
      let title = txt(h2) || (h2.getAttribute("aria-label") ?? "");
      title = title.replace(/^Sponsored Ad\s*[-–]\s*/i, "").replace(/^Sponsored\s+/i, "").trim();
      if (!title) return null;
      let brand = "";
      for (const b of el.querySelectorAll('[data-cy="title-recipe"] h2 span, [data-cy="title-recipe"] .a-row span.a-size-base-plus, [data-cy="title-recipe"] .a-row span.a-size-medium, .s-title-instructions-style .a-row .a-size-base-plus')) {
        const t = txt(b);
        if (t && t !== title && !h2.contains(b) && t.length < 60) {
          brand = t;
          break;
        }
      }
      const price = txt(el.querySelector(".a-price .a-offscreen")) || void 0;
      const link = h2.closest("a") ?? el.querySelector('a.a-link-normal[href*="/dp/"]') ?? el.querySelector('a[href*="/dp/"]');
      const url = abs(link?.getAttribute("href"), loc) ?? abs(`/dp/${asin}`, loc);
      const image_url = imgSrc(el.querySelector("img.s-image"), loc);
      const anchor = h2.closest("a") ?? h2;
      return { el, anchor, product: { product_id: asin, title, brand: brand || void 0, price, image_url, url } };
    },
    productPage(doc, loc) {
      const titleEl = doc.querySelector("#productTitle");
      if (!titleEl) return null;
      const title = txt(titleEl);
      const m = loc.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
      const asin = (m?.[1] ?? doc.querySelector("input#ASIN")?.value ?? "").toUpperCase();
      if (!asin || !title) return null;
      const byline = txt(doc.querySelector("#bylineInfo"));
      const brand = byline.replace(/^Visit the\s+/i, "").replace(/\s+Store$/i, "").replace(/^Brand:\s*/i, "").trim() || void 0;
      const price = txt(doc.querySelector("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen")) || void 0;
      let model = "";
      for (const row of doc.querySelectorAll("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, #poExpander tr, .po-model_name")) {
        const t = txt(row);
        const mm = t.match(/(?:Item model number|Model Number|Model Name|Model)\s*[:‏‎]*\s*([^\s:][^:]{0,40}?)$/i);
        if (mm) {
          model = mm[1].trim();
          break;
        }
      }
      const image_url = imgSrc(doc.querySelector("#landingImage, #imgBlkFront, #main-image"), loc);
      return {
        product: { product_id: asin, title, brand, price, image_url, model: model || void 0, url: abs(`/dp/${asin}`, loc) },
        mount(host) {
          const ppd = doc.querySelector("#ppd");
          if (ppd) insertBefore(host, ppd, doc.body);
          else (doc.querySelector("#dp-container") ?? doc.querySelector("#dp") ?? doc.body).prepend(host);
        }
      };
    }
  };
  var EBAY_CARD = "li.s-card, li.s-item";
  var ebayItemId = (href) => href?.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/)?.[1];
  var ebay = {
    key: "ebay",
    site: "ebay.com",
    detect: (doc, loc) => /(^|\.)ebay\.[a-z.]+$/i.test(loc.hostname) || !!doc.querySelector('li.s-card a[href*="/itm/"], li.s-item a[href*="/itm/"]') || !!doc.querySelector("h1.x-item-title__mainTitle"),
    cardSelector: EBAY_CARD,
    extractCard(el, loc) {
      const link = el.querySelector('a[href*="/itm/"]');
      const id = ebayItemId(link?.getAttribute("href"));
      if (!id || id === "123456") return null;
      const titleEl = el.querySelector(".s-card__title, .s-item__title");
      if (!titleEl) return null;
      const clone = titleEl.cloneNode(true);
      clone.querySelectorAll('.clipped, .LIGHT_HIGHLIGHT, .s-card__new-listing, [role="text"] > .clipped').forEach((n) => n.remove());
      const title = txt(clone).replace(/^New Listing\s*/i, "").replace(/Opens in a new window or tab$/i, "").trim();
      if (!title || /^Shop on eBay$/i.test(title)) return null;
      const price = txt(el.querySelector(".s-card__price, .s-item__price")) || void 0;
      const image_url = imgSrc(el.querySelector(".s-card__image img, .s-item__image img, img"), loc);
      const url = abs(link?.getAttribute("href"), loc)?.split("?")[0];
      const anchor = titleEl.closest("a") ?? titleEl;
      return { el, anchor, product: { product_id: id, title, price, image_url, url } };
    },
    productPage(doc, loc) {
      const h1 = doc.querySelector("h1.x-item-title__mainTitle");
      if (!h1) return null;
      const id = ebayItemId(loc.pathname);
      const title = txt(h1);
      if (!id || !title) return null;
      const img = doc.querySelector("#icImg") ?? doc.querySelector(".ux-image-carousel-item.active img") ?? doc.querySelector(".ux-image-carousel img");
      const price = txt(doc.querySelector(".x-price-primary")) || void 0;
      const brand = txt(doc.querySelector(".ux-labels-values--brand .ux-labels-values__values")) || void 0;
      const model = txt(doc.querySelector(".ux-labels-values--model .ux-labels-values__values, .ux-labels-values--mpn .ux-labels-values__values")) || void 0;
      const upc = txt(doc.querySelector(".ux-labels-values--upc .ux-labels-values__values")).replace(/\D/g, "") || void 0;
      return {
        product: { product_id: id, title, brand, price, model, upc, image_url: imgSrc(img, loc), url: `https://www.ebay.com/itm/${id}` },
        mount(host) {
          const main = doc.querySelector("#mainContent") ?? doc.querySelector(".vim.x-item-title")?.closest(".main-container") ?? doc.body;
          main.prepend(host);
        }
      };
    }
  };
  var walmart = {
    key: "walmart",
    site: "walmart.com",
    detect: (_d, loc) => hostIs(loc, "walmart.com"),
    cardSelector: "div[data-item-id]",
    extractCard(el, loc) {
      const id = el.getAttribute("data-item-id");
      const titleEl = el.querySelector('[data-automation-id="product-title"], span.w_iUH7, a span');
      const title = txt(titleEl);
      if (!id || !title) return null;
      const link = el.querySelector('a[href*="/ip/"]');
      const price = txt(el.querySelector('[data-automation-id="product-price"] .w_iUH7, [data-automation-id="product-price"]'))?.split(/current price/i).pop()?.trim() || void 0;
      return { el, anchor: titleEl ?? el.firstElementChild ?? el, product: { product_id: id, title, price, image_url: imgSrc(el.querySelector("img"), loc), url: abs(link?.getAttribute("href"), loc) } };
    }
  };
  var target = {
    key: "target",
    site: "target.com",
    detect: (_d, loc) => hostIs(loc, "target.com"),
    cardSelector: '[data-test="@web/site-top-of-funnel/ProductCardWrapper"], [data-test="product-grid"] section',
    extractCard(el, loc) {
      const a = el.querySelector('a[data-test="product-title"], a[href*="/A-"]');
      const id = a?.getAttribute("href")?.match(/\/A-(\d+)/)?.[1];
      const title = txt(a) || (a?.getAttribute("aria-label") ?? "");
      if (!id || !title) return null;
      const price = txt(el.querySelector('[data-test="current-price"]')) || void 0;
      return { el, anchor: a, product: { product_id: id, title, price, image_url: imgSrc(el.querySelector("img"), loc), url: abs(a?.getAttribute("href"), loc) } };
    }
  };
  function findProductLd(doc) {
    const scan = (node) => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const f = scan(n);
          if (f) return f;
        }
        return null;
      }
      const t = node["@type"];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => typeof x === "string" && /^(https?:\/\/schema\.org\/)?(Product|ProductGroup)$/i.test(x))) return node;
      if (node["@graph"]) return scan(node["@graph"]);
      if (node.mainEntity) return scan(node.mainEntity);
      return null;
    };
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const f = scan(JSON.parse(s.textContent ?? ""));
        if (f) return f;
      } catch {
      }
    }
    return null;
  }
  var meta = (doc, p) => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute("content")?.trim() || "";
  function hashId(s) {
    let h2 = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h2 ^= s.charCodeAt(i);
      h2 = Math.imul(h2, 16777619);
    }
    return "u" + (h2 >>> 0).toString(36);
  }
  var generic = {
    key: "generic",
    site: "",
    detect: () => true,
    productPage(doc, loc) {
      const ld = findProductLd(doc);
      const ogType = meta(doc, "og:type").toLowerCase();
      const isProduct = !!ld || ogType === "product" || ogType === "product.item" || ogType === "og:product" || !!doc.querySelector('[itemtype$="schema.org/Product"]');
      if (!isProduct) return null;
      const itemprop = (p) => {
        const n = doc.querySelector(`[itemtype$="schema.org/Product"] [itemprop="${p}"]`);
        return (n?.getAttribute("content") || txt(n)) ?? "";
      };
      const title = String(ld?.name ?? "").trim() || meta(doc, "og:title") || itemprop("name");
      if (!title) return null;
      let image = ld?.image;
      if (Array.isArray(image)) image = image[0];
      if (image && typeof image === "object") image = image.url ?? image.contentUrl;
      const brandRaw = ld?.brand;
      const brand = (typeof brandRaw === "string" ? brandRaw : brandRaw?.name) || meta(doc, "product:brand") || itemprop("brand") || void 0;
      const offers = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
      const priceVal = offers?.price ?? offers?.lowPrice ?? meta(doc, "product:price:amount");
      const cur = offers?.priceCurrency ?? meta(doc, "product:price:currency");
      const price = priceVal ? `${cur === "USD" || !cur ? "$" : cur + " "}${priceVal}` : void 0;
      const upc = String(ld?.gtin12 ?? ld?.gtin13 ?? ld?.gtin ?? "").replace(/\D/g, "") || void 0;
      const model = String(ld?.model?.name ?? ld?.model ?? ld?.mpn ?? "").trim() || void 0;
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || meta(doc, "og:url") || loc.href.split("#")[0];
      const pid = String(ld?.sku ?? ld?.productID ?? upc ?? "").trim() || hashId(canonical);
      return {
        product: {
          product_id: pid,
          title,
          brand: brand ? String(brand) : void 0,
          price,
          image_url: abs(typeof image === "string" ? image : meta(doc, "og:image"), loc),
          model,
          upc,
          url: abs(canonical, loc)
        },
        mount(host) {
          const main = doc.querySelector("main") ?? doc.body;
          main.prepend(host);
        }
      };
    }
  };
  var ADAPTERS = [amazon, ebay, walmart, target];
  function pickAdapter(doc, loc) {
    for (const a of ADAPTERS) if (a.detect(doc, loc)) return a;
    return generic;
  }
  function siteName(a, loc) {
    return a.site || loc.hostname.replace(/^www\./, "");
  }

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
  var HAZARD_SHORT = {
    suffocation: "Suffocation risk",
    tip_over: "Tip-over risk",
    ingestion: "Ingestion hazard",
    choking: "Choking hazard",
    fire_burn: "Fire / burn hazard",
    flammability: "Flammability hazard",
    entrapment: "Entrapment hazard",
    fall: "Fall hazard",
    shock: "Shock hazard",
    laceration: "Laceration hazard",
    other: "Safety hazard"
  };
  var hazardColor = (c) => HAZARD_COLORS[c ?? "other"] ?? HAZARD_COLORS.other;
  var hazardShort = (c) => HAZARD_SHORT[c ?? "other"] ?? HAZARD_SHORT.other;
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

  // src/ui/dom.ts
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) el.append(c);
    return el;
  }
  var MONO = `ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`;
  var SERIF = `"Instrument Serif", "Iowan Old Style", Georgia, "Times New Roman", serif`;
  var SANS = `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  function shadowHost(tag, css, attr) {
    const host = document.createElement(tag);
    host.setAttribute("data-recall-guard", attr);
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("display", "block", "important");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial;display:block}*{box-sizing:border-box}` + css;
    root.append(style);
    return { host, root };
  }

  // src/ui/badge.ts
  var BADGE_CSS = `
.chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;margin:4px 0 6px;padding:5px 9px 5px 8px;
  font:700 11px/1.25 ${MONO};letter-spacing:.06em;text-transform:uppercase;cursor:pointer;user-select:none;
  border:0;border-radius:2px;text-align:left;white-space:normal}
.chip:focus-visible{outline:2px solid #1d1d1f;outline-offset:2px}
.recalled{background:#E8E3D6;color:#1b1b1b;border-left:5px solid var(--hz);box-shadow:0 1px 0 rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.08)}
.recalled .g{color:var(--hz);font-size:13px}
.possible{background:#fffaf0;color:#7a4a00;border:1.5px solid #F3A712;padding:4px 8px}
.possible .g{color:#d48806}
.i{opacity:.55;font-weight:400}
`;
  var POP_CSS = `
.pop{position:fixed;z-index:2147483647;width:320px;max-width:calc(100vw - 16px);background:#E8E3D6;color:#1b1b1b;
  border-left:6px solid var(--hz);box-shadow:0 12px 32px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.12);padding:12px 14px 12px;font:13px/1.4 ${SANS}}
.k{font:700 10px/1.2 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:#5a554a;margin:0 0 6px}
.t{font:400 18px/1.2 ${SERIF};margin:0 0 8px}
.row{display:grid;grid-template-columns:78px 1fr;gap:8px;padding:5px 0;border-top:1px dashed rgba(0,0,0,.18)}
.row b{font:700 10px/1.5 ${MONO};letter-spacing:.1em;text-transform:uppercase;color:#5a554a}
.hz{color:var(--hzd)}
a{color:#1b1b1b;font:700 11px/1 ${MONO};letter-spacing:.06em;text-transform:uppercase;text-decoration:none;
  display:inline-block;margin-top:10px;padding:7px 10px;border:1.5px solid #1b1b1b}
a:hover{background:#1b1b1b;color:#E8E3D6}
.x{position:absolute;top:6px;right:8px;background:none;border:0;font:16px/1 ${MONO};cursor:pointer;color:#5a554a}
.note{font-size:11px;color:#5a554a;margin-top:8px}
`;
  var pop = null;
  function closePopover() {
    pop?.host.remove();
    pop = null;
  }
  function clip(s, n) {
    if (!s) return "\u2014";
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
  }
  function openPopover(anchor, r) {
    closePopover();
    const rc = r.recall;
    if (!rc) return;
    pop = shadowHost("div", POP_CSS, "popover");
    const color = hazardColor(rc.hazard_class);
    const box = h("div", { class: "pop", role: "dialog", "aria-label": "Recall details" });
    box.style.setProperty("--hz", color);
    box.style.setProperty("--hzd", color === "#FFD166" || color === "#8AC926" ? "#5a4a00" : color);
    const link = safeUrl(rc.url);
    box.append(...[
      h("button", { class: "x", "aria-label": "Close", onclick: () => closePopover() }, "\xD7"),
      h("p", { class: "k" }, r.status === "recalled" ? `CPSC recall #${rc.recall_number}` : `Possible match \xB7 CPSC #${rc.recall_number}`),
      h("p", { class: "t" }, clip(rc.title, 160)),
      h("div", { class: "row" }, h("b", {}, "Hazard"), h("span", { class: "hz" }, `${hazardShort(rc.hazard_class)}. ${clip(rc.hazard, 220)}`)),
      h("div", { class: "row" }, h("b", {}, "Recalled"), h("span", {}, fmtDate(rc.recall_date))),
      h("div", { class: "row" }, h("b", {}, "Remedy"), h("span", {}, clip(rc.remedy, 220))),
      r.status === "possible" ? h("p", { class: "note" }, "Check the model number on the listing against the CPSC notice.") : null,
      link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "View CPSC notice \u2197") : null
    ].filter((n) => !!n));
    pop.root.append(box);
    document.documentElement.append(pop.host);
    const rect = anchor.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    box.style.left = `${left}px`;
    const below = rect.bottom + 6;
    box.style.top = `${below}px`;
    requestAnimationFrame(() => {
      const bh = box.getBoundingClientRect().height;
      if (below + bh > window.innerHeight - 8) box.style.top = `${Math.max(8, rect.top - bh - 6)}px`;
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopover();
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (pop && !e.composedPath().includes(pop.host)) closePopover();
  }, true);
  window.addEventListener("scroll", () => closePopover(), { passive: true, capture: true });
  function makeBadge(r) {
    if (r.status === "clean" || !r.recall) return null;
    const { host, root } = shadowHost("div", BADGE_CSS, "badge");
    const isR = r.status === "recalled";
    const btn = h("button", { class: `chip ${isR ? "recalled" : "possible"}`, type: "button", title: "Recall Guard: click for details" });
    btn.style.setProperty("--hz", hazardColor(r.recall.hazard_class));
    if (isR) {
      btn.append(h("span", { class: "g" }, "\u26A0"), h("span", {}, `Recalled: do not buy \xB7 ${hazardShort(r.recall.hazard_class)}`));
    } else {
      btn.append(h("span", { class: "g" }, "\u25EC"), h("span", {}, "Possible recall match: check model"));
    }
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) host.addEventListener(t, (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      stop(e);
      openPopover(btn, r);
    });
    host.addEventListener("click", (e) => stop(e));
    root.append(btn);
    return host;
  }

  // src/ui/banner.ts
  var CSS = `
.wrap{margin:10px 0 14px;font:14px/1.45 ${SANS};color:#1b1b1b}
.paper{position:relative;background:#E8E3D6;border-left:8px solid var(--hz);padding:22px 22px 18px 22px;
  box-shadow:0 2px 0 rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.12)}
.paper::before{content:"";position:absolute;left:0;right:0;top:-6px;height:12px;
  background:radial-gradient(circle at 6px 6px,#fff 3.2px,transparent 3.6px) 0 0/14px 12px repeat-x}
.paper.amber{border-left-color:#F3A712}
.k{display:flex;justify-content:space-between;gap:12px;font:700 11px/1.2 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:#5a554a;
  border-bottom:1.5px solid #1b1b1b;padding-bottom:8px;margin:0 0 12px}
.k .stamp{color:var(--hzd)}
h2{font:400 28px/1.12 ${SERIF};margin:0 0 6px;color:#111}
.sub{margin:0 0 14px;color:#3a372f}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border-top:1px dashed rgba(0,0,0,.25)}
.cell{padding:10px 12px 10px 0}
.cell+.cell{padding-left:12px;border-left:1px dashed rgba(0,0,0,.25)}
.cell b{display:block;font:700 10px/1.4 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:#5a554a;margin-bottom:3px}
.cell.hz span{color:var(--hzd);font-weight:600}
@media (max-width:820px){.grid{grid-template-columns:1fr 1fr}.cell:nth-child(3){border-left:0;padding-left:0}}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}
.btn{font:700 11px/1 ${MONO};letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:#1b1b1b;
  padding:9px 12px;border:1.5px solid #1b1b1b;background:transparent;cursor:pointer}
.btn:hover{background:#1b1b1b;color:#E8E3D6}
.btn.ghost{border-color:transparent;color:#5a554a}
.btn.ghost:hover{background:transparent;color:#1b1b1b;text-decoration:underline}
.alts{margin-top:16px;padding-top:12px;border-top:1.5px solid #1b1b1b}
.alts .k2{display:flex;justify-content:space-between;align-items:baseline;font:700 11px/1.2 ${MONO};letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px}
.alts .k2 i{font-style:normal;font-weight:400;letter-spacing:.04em;text-transform:none;color:#5a554a;font-family:${SANS};font-size:12px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:820px){.cards{grid-template-columns:1fr}}
.card{display:flex;gap:10px;background:#F4F1E9;border:1px solid rgba(0,0,0,.14);padding:10px;text-decoration:none;color:#1b1b1b;min-width:0}
.card:hover{border-color:#1b1b1b}
.card img{width:64px;height:64px;object-fit:contain;background:#fff;flex:none}
.card .ph{width:64px;height:64px;background:repeating-linear-gradient(45deg,#ddd8cb 0 6px,#e8e3d6 6px 12px);flex:none}
.card .tt{font-size:13px;line-height:1.3;max-height:2.6em;overflow:hidden;margin:0 0 4px}
.card .pr{font:700 12px/1.2 ${MONO}}
.card .sh{font:11px/1.3 ${MONO};color:#5a554a;text-transform:uppercase;letter-spacing:.06em}
.card .sn{font-size:11px;color:#2f5d2f;margin-top:3px}
.muted{color:#5a554a;font-size:13px}
`;
  function short(s, n) {
    if (!s) return "\u2014";
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
  }
  function makeBanner(r, onDismiss) {
    const rc = r.recall;
    if (!rc || r.status === "clean") return null;
    const { host, root } = shadowHost("div", CSS, "banner");
    const isR = r.status === "recalled";
    const color = hazardColor(rc.hazard_class);
    const paper = h("section", { class: `paper${isR ? "" : " amber"}`, role: "alert", "aria-label": "Recall Guard recall notice" });
    paper.style.setProperty("--hz", color);
    paper.style.setProperty("--hzd", color === "#FFD166" || color === "#8AC926" ? "#5a4a00" : color);
    const link = safeUrl(rc.url);
    const headline = isR ? `This product appears to match CPSC recall #${rc.recall_number}` : `This product may match CPSC recall #${rc.recall_number}. Check the model.`;
    const alts = h(
      "div",
      { class: "alts" },
      h("p", { class: "k2" }, h("span", {}, "Safer alternatives"), h("i", {}, "Suggestions, not endorsements"))
    );
    const altBody = h("div", { class: "cards" }, h("p", { class: "muted" }, "Finding alternatives\u2026"));
    alts.append(altBody);
    paper.append(
      h(
        "p",
        { class: "k" },
        h("span", {}, `Recall Guard \xB7 ${isR ? "Recall notice" : "Possible recall match"}`),
        h("span", { class: "stamp" }, `\u26A0 ${hazardShort(rc.hazard_class)}`)
      ),
      h("h2", {}, headline),
      h("p", { class: "sub" }, short(rc.title, 220)),
      h(
        "div",
        { class: "grid" },
        h("div", { class: "cell hz" }, h("b", {}, "Hazard"), h("span", {}, short(rc.hazard, 260))),
        h("div", { class: "cell" }, h("b", {}, "Remedy"), h("span", {}, short(rc.remedy, 260))),
        h("div", { class: "cell" }, h("b", {}, "Recall date"), h("span", {}, fmtDate(rc.recall_date))),
        h("div", { class: "cell" }, h("b", {}, "Units"), h("span", {}, rc.units || "\u2014"))
      ),
      h(
        "div",
        { class: "actions" },
        link ? h("a", { class: "btn", href: link, target: "_blank", rel: "noopener noreferrer" }, "View CPSC notice \u2197") : null,
        h("button", { class: "btn ghost", type: "button", onclick: () => {
          host.remove();
          onDismiss();
        } }, "Dismiss for this product \xD7")
      ),
      alts
    );
    root.append(h("div", { class: "wrap" }, paper));
    return {
      host,
      setAlternatives({ loading, items, error }) {
        altBody.replaceChildren();
        if (loading) {
          altBody.append(h("p", { class: "muted" }, "Finding alternatives\u2026"));
          return;
        }
        if (error || !items?.length) {
          altBody.append(h("p", { class: "muted" }, error ? "Alternatives unavailable right now (engine offline)." : "No vetted alternatives found yet."));
          return;
        }
        for (const a of items.slice(0, 3)) {
          const img = safeUrl(a.image) ? (() => {
            const i = h("img", { src: safeUrl(a.image), alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
            i.addEventListener("error", () => i.replaceWith(h("div", { class: "ph" })));
            return i;
          })() : h("div", { class: "ph" });
          const href = safeUrl(a.url);
          const card = h(
            href ? "a" : "div",
            href ? { class: "card", href, target: "_blank", rel: "noopener noreferrer nofollow" } : { class: "card" },
            img,
            h(
              "div",
              { style: "min-width:0" },
              h("p", { class: "tt" }, short(a.title, 90)),
              h("div", { class: "pr" }, a.price || ""),
              h("div", { class: "sh" }, a.shop || ""),
              a.safety_note ? h("div", { class: "sn" }, short(a.safety_note, 110)) : null
            )
          );
          altBody.append(card);
        }
      }
    };
  }
  var PILL_CSS = `.p{position:fixed;right:14px;bottom:14px;z-index:2147483646;background:#232427;color:#E8E3D6;font:700 11px/1.3 ${MONO};
letter-spacing:.06em;text-transform:uppercase;padding:8px 10px 8px 12px;border-left:4px solid #9A9A9A;box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center}
.p button{background:none;border:0;color:#E8E3D6;font:14px/1 ${MONO};cursor:pointer;padding:0}`;
  var pill = null;
  function showPill(text) {
    if (pill) return;
    const { host, root } = shadowHost("div", PILL_CSS, "pill");
    pill = host;
    const p = h("div", { class: "p", role: "status" }, h("span", {}, text), h("button", { "aria-label": "Dismiss", onclick: () => host.remove() }, "\xD7"));
    root.append(p);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 8e3);
  }
  function hidePill() {
    pill?.remove();
    pill = null;
  }

  // src/content.ts
  var BATCH_MS = 300;
  var MAX_BATCH = 40;
  var g = globalThis;
  var current = null;
  async function boot() {
    current?.dispose();
    current = null;
    try {
      current = await run();
    } catch (e) {
      console.debug("[Recall Guard]", e);
    }
  }
  var forceNext = false;
  if (!g.__recallGuardLoaded && document.documentElement) {
    g.__recallGuardLoaded = true;
    ext.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) boot();
    });
    ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "getState") sendResponse(current ? { ...current.state } : null);
      if (msg?.type === "recheck") {
        forceNext = true;
        boot();
        sendResponse({ ok: true });
      }
    });
    boot();
  }
  async function run() {
    const loc = location;
    const adapter = pickAdapter(document, loc);
    const site = siteName(adapter, loc);
    const settings = await getSettings();
    let disposed = false;
    const force = forceNext;
    forceNext = false;
    const seen = /* @__PURE__ */ new WeakSet();
    const cardState = /* @__PURE__ */ new Map();
    const injected = /* @__PURE__ */ new Set();
    let queue = [];
    let timer = null;
    const state = { site, recalled: 0, possible: 0, checked: 0, offline: false };
    let bannerFor = null;
    let io = null;
    let mo = null;
    const enabled = () => settings.sites[adapter.key] !== false;
    function recount() {
      let recalled = 0, possible = 0, checked = 0;
      for (const s of cardState.values()) {
        if (!s.result) continue;
        checked++;
        if (s.result.status === "recalled") recalled++;
        else if (s.result.status === "possible") possible++;
      }
      Object.assign(state, { recalled, possible, checked });
      ext.runtime.sendMessage({ type: "report", state: { ...state } }).catch(() => {
      });
    }
    function applyResult(r) {
      if (disposed) return;
      const s = cardState.get(r.product_id);
      if (!s) return;
      s.result = r;
      for (const ref of s.refs) {
        ref.el.querySelectorAll(':scope [data-recall-guard="badge"]').forEach((n) => n.remove());
        const badge = makeBadge(r);
        if (!badge) continue;
        if (ref.anchor.isConnected && ref.el.contains(ref.anchor)) ref.anchor.parentNode.insertBefore(badge, ref.anchor);
        else ref.el.prepend(badge);
        injected.add(badge);
      }
    }
    async function sendMatch(products) {
      try {
        const reply = await ext.runtime.sendMessage({ type: "match", site, page_url: location.href, products, force });
        if (reply?.offline) {
          state.offline = true;
          state.error = reply.error;
          showPill("Recall Guard: engine offline, listings not checked");
        } else if (reply) {
          state.offline = false;
          state.error = void 0;
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
    function enqueue(el) {
      if (seen.has(el) || !adapter.extractCard) return;
      const ref = adapter.extractCard(el, loc);
      if (!ref) return;
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
              io.unobserve(e.target);
              enqueue(e.target);
            }
          }
        }, { rootMargin: "300px 0px" });
      }
      for (const el of document.querySelectorAll(adapter.cardSelector)) {
        if (!seen.has(el) && !el.__rgObserved) {
          el.__rgObserved = true;
          io.observe(el);
        }
      }
    }
    async function productPage() {
      let ref = adapter.productPage?.(document, loc) ?? null;
      let key = adapter.key;
      if (!ref && settings.sites.generic !== false) {
        ref = generic.productPage(document, loc);
        key = "generic";
      }
      if (!ref || key === "generic" && settings.sites.generic === false) return;
      const pid = ref.product.product_id;
      if (bannerFor === pid) return;
      bannerFor = pid;
      const dismissKey = `dismissed:${site}:${pid}`;
      const got = await ext.storage.local.get(dismissKey);
      const reply = await sendMatch([ref.product]);
      const r = reply?.results?.find((x) => x.product_id === pid);
      if (r) {
        cardState.set(pid, { refs: [], result: r });
        recount();
      }
      if (disposed || !r || r.status === "clean" || !r.recall || got[dismissKey]) return;
      const banner = makeBanner(r, () => {
        ext.storage.local.set({ [dismissKey]: Date.now() });
      });
      if (!banner) return;
      ref.mount(banner.host);
      injected.add(banner.host);
      banner.setAlternatives({ loading: true });
      const alts = await ext.runtime.sendMessage({ type: "alternatives", recall_id: r.recall.recall_id, title: ref.product.title }).catch(() => null);
      banner.setAlternatives(alts?.ok ? { items: alts.items } : { error: alts?.error ?? "offline" });
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
      for (const el of document.querySelectorAll(adapter.cardSelector ?? "__none__")) el.__rgObserved = false;
      Object.assign(state, { recalled: 0, possible: 0, checked: 0 });
    }
    start();
    recount();
    return { dispose: stop, state };
  }
})();
