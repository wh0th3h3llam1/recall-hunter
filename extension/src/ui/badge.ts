import { fmtDate, hazardColor, hazardShort, safeUrl } from '../common';
import type { MatchResult } from '../types';
import { h, MONO, SANS, SERIF, shadowHost } from './dom';

const BADGE_CSS = `
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

const POP_CSS = `
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

let pop: { host: HTMLElement; root: ShadowRoot } | null = null;

function closePopover() {
  pop?.host.remove();
  pop = null;
}

function clip(s: string | undefined, n: number) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function openPopover(anchor: Element, r: MatchResult) {
  closePopover();
  const rc = r.recall;
  if (!rc) return;
  pop = shadowHost('div', POP_CSS, 'popover');
  const color = hazardColor(rc.hazard_class);
  const box = h('div', { class: 'pop', role: 'dialog', 'aria-label': 'Recall details' });
  box.style.setProperty('--hz', color);
  box.style.setProperty('--hzd', color === '#FFD166' || color === '#8AC926' ? '#5a4a00' : color);
  const link = safeUrl(rc.url);
  box.append(...[
    h('button', { class: 'x', 'aria-label': 'Close', onclick: () => closePopover() }, '×'),
    h('p', { class: 'k' }, r.status === 'recalled' ? `CPSC recall #${rc.recall_number}` : `Possible match · CPSC #${rc.recall_number}`),
    h('p', { class: 't' }, clip(rc.title, 160)),
    h('div', { class: 'row' }, h('b', {}, 'Hazard'), h('span', { class: 'hz' }, `${hazardShort(rc.hazard_class)}. ${clip(rc.hazard, 220)}`)),
    h('div', { class: 'row' }, h('b', {}, 'Recalled'), h('span', {}, fmtDate(rc.recall_date))),
    h('div', { class: 'row' }, h('b', {}, 'Remedy'), h('span', {}, clip(rc.remedy, 220))),
    r.status === 'possible' ? h('p', { class: 'note' }, 'Check the model number on the listing against the CPSC notice.') : null,
    link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'View CPSC notice ↗') : null,
  ].filter((n): n is NonNullable<typeof n> => !!n));
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

// Global dismissal for the popover.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); }, true);
document.addEventListener('mousedown', (e) => {
  if (pop && !e.composedPath().includes(pop.host)) closePopover();
}, true);
window.addEventListener('scroll', () => closePopover(), { passive: true, capture: true });

export function makeBadge(r: MatchResult): HTMLElement | null {
  if (r.status === 'clean' || !r.recall) return null;
  const { host, root } = shadowHost('div', BADGE_CSS, 'badge');
  const isR = r.status === 'recalled';
  const btn = h('button', { class: `chip ${isR ? 'recalled' : 'possible'}`, type: 'button', title: 'Recall Guard: click for details' });
  btn.style.setProperty('--hz', hazardColor(r.recall.hazard_class));
  if (isR) {
    btn.append(h('span', { class: 'g' }, '⚠'), h('span', {}, `Recalled: do not buy · ${hazardShort(r.recall.hazard_class)}`));
  } else {
    btn.append(h('span', { class: 'g' }, '◬'), h('span', {}, 'Possible recall match: check model'));
  }
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  // The host can sit inside clickable cards: swallow events so the site doesn't navigate.
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) host.addEventListener(t, (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => { stop(e); openPopover(btn, r); });
  host.addEventListener('click', (e) => stop(e));
  root.append(btn);
  return host;
}
