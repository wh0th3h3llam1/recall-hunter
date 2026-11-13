import { fmtDate, hazardColor, hazardShort, safeUrl } from '../common';
import type { Alternative, MatchResult } from '../types';
import { h, MONO, SANS, SERIF, shadowHost } from './dom';

const CSS = `
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

function short(s: string | undefined, n: number) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export interface BannerHandle {
  host: HTMLElement;
  setAlternatives(state: { loading?: boolean; items?: Alternative[]; error?: string }): void;
}

export function makeBanner(r: MatchResult, onDismiss: () => void): BannerHandle | null {
  const rc = r.recall;
  if (!rc || r.status === 'clean') return null;
  const { host, root } = shadowHost('div', CSS, 'banner');
  const isR = r.status === 'recalled';
  const color = hazardColor(rc.hazard_class);
  const paper = h('section', { class: `paper${isR ? '' : ' amber'}`, role: 'alert', 'aria-label': 'Recall Guard recall notice' });
  paper.style.setProperty('--hz', color);
  paper.style.setProperty('--hzd', color === '#FFD166' || color === '#8AC926' ? '#5a4a00' : color);
  const link = safeUrl(rc.url);

  const headline = isR
    ? `This product appears to match CPSC recall #${rc.recall_number}`
    : `This product may match CPSC recall #${rc.recall_number}. Check the model.`;

  const alts = h('div', { class: 'alts' },
    h('p', { class: 'k2' }, h('span', {}, 'Safer alternatives'), h('i', {}, 'Suggestions, not endorsements')),
  );
  const altBody = h('div', { class: 'cards' }, h('p', { class: 'muted' }, 'Finding alternatives…'));
  alts.append(altBody);

  paper.append(
    h('p', { class: 'k' },
      h('span', {}, `Recall Guard · ${isR ? 'Recall notice' : 'Possible recall match'}`),
      h('span', { class: 'stamp' }, `⚠ ${hazardShort(rc.hazard_class)}`)),
    h('h2', {}, headline),
    h('p', { class: 'sub' }, short(rc.title, 220)),
    h('div', { class: 'grid' },
      h('div', { class: 'cell hz' }, h('b', {}, 'Hazard'), h('span', {}, short(rc.hazard, 260))),
      h('div', { class: 'cell' }, h('b', {}, 'Remedy'), h('span', {}, short(rc.remedy, 260))),
      h('div', { class: 'cell' }, h('b', {}, 'Recall date'), h('span', {}, fmtDate(rc.recall_date))),
      h('div', { class: 'cell' }, h('b', {}, 'Units'), h('span', {}, rc.units || '—')),
    ),
    h('div', { class: 'actions' },
      link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'View CPSC notice ↗') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { host.remove(); onDismiss(); } }, 'Dismiss for this product ×'),
    ),
    alts,
  );
  root.append(h('div', { class: 'wrap' }, paper));

  return {
    host,
    setAlternatives({ loading, items, error }) {
      altBody.replaceChildren();
      if (loading) { altBody.append(h('p', { class: 'muted' }, 'Finding alternatives…')); return; }
      if (error || !items?.length) {
        altBody.append(h('p', { class: 'muted' }, error ? 'Alternatives unavailable right now (engine offline).' : 'No vetted alternatives found yet.'));
        return;
      }
      for (const a of items.slice(0, 3)) {
        const img = safeUrl(a.image)
          ? (() => {
              const i = h('img', { src: safeUrl(a.image), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
              i.addEventListener('error', () => i.replaceWith(h('div', { class: 'ph' })));
              return i;
            })()
          : h('div', { class: 'ph' });
        const href = safeUrl(a.url);
        const card = h(href ? 'a' : 'div' as any, href ? { class: 'card', href, target: '_blank', rel: 'noopener noreferrer nofollow' } : { class: 'card' },
          img,
          h('div', { style: 'min-width:0' },
            h('p', { class: 'tt' }, short(a.title, 90)),
            h('div', { class: 'pr' }, a.price || ''),
            h('div', { class: 'sh' }, a.shop || ''),
            a.safety_note ? h('div', { class: 'sn' }, short(a.safety_note, 110)) : null,
          ),
        );
        altBody.append(card);
      }
    },
  };
}

const PILL_CSS = `.p{position:fixed;right:14px;bottom:14px;z-index:2147483646;background:#232427;color:#E8E3D6;font:700 11px/1.3 ${MONO};
letter-spacing:.06em;text-transform:uppercase;padding:8px 10px 8px 12px;border-left:4px solid #9A9A9A;box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center}
.p button{background:none;border:0;color:#E8E3D6;font:14px/1 ${MONO};cursor:pointer;padding:0}`;

let pill: HTMLElement | null = null;
/** Small, dismissible status pill (used for "engine offline"). */
export function showPill(text: string) {
  if (pill) return;
  const { host, root } = shadowHost('div', PILL_CSS, 'pill');
  pill = host;
  const p = h('div', { class: 'p', role: 'status' }, h('span', {}, text), h('button', { 'aria-label': 'Dismiss', onclick: () => host.remove() }, '×'));
  root.append(p);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 8000);
}
export function hidePill() {
  pill?.remove();
  pill = null;
}
