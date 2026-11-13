import type { Recall } from '../api';
import { hazardColor, hazardLabel } from '../hazard';
import { ErrorBox, Scanning } from './States';

interface Props {
  recalls: Recall[] | null;
  error: string | null;
  childOnly: boolean;
  setChildOnly: (v: boolean) => void;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onHunt: (r: Recall) => void;
  huntingId: number | null;
  huntBusy: boolean;
  onRetry: () => void;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const t = new Date(d);
  if (isNaN(t.getTime())) return String(d);
  return t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }).toUpperCase();
}

export function fmtUnits(u: string | number | null | undefined): string {
  if (u == null || u === '') return '—';
  if (typeof u === 'number') return u.toLocaleString('en-US');
  const m = String(u).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (m && /^\s*(about\s*)?[\d,.]+\s*$/i.test(String(u))) return Number(m[0]).toLocaleString('en-US');
  return String(u);
}

export function HazardChip({ h }: { h: string | null | undefined }) {
  const c = hazardColor(h);
  return (
    <span className="chip" style={{ ['--hz' as string]: c }}>
      <i />
      {hazardLabel(h).toUpperCase()}
    </span>
  );
}

export default function RecallRail(p: Props) {
  return (
    <aside className="rail" aria-label="Recall feed">
      <div className="rail-head">
        <div className="notice-k micro">NOTICE · U.S. CPSC RECALLS</div>
        <h2 className="serif rail-title">Recalled, still for sale?</h2>
        <div className="rail-controls">
          <label className="toggle">
            <input type="checkbox" checked={p.childOnly} onChange={(e) => p.setChildOnly(e.target.checked)} />
            <span className="toggle-box" aria-hidden />
            <span className="micro">CHILDREN'S PRODUCTS ONLY</span>
          </label>
          {p.selectedId != null && (
            <button className="btn-link micro" onClick={() => p.onSelect(null)}>
              SHOW ALL ×
            </button>
          )}
        </div>
      </div>
      <div className="rail-list">
        {p.error ? (
          <ErrorBox title="RECALL FEED UNREACHABLE" message={`${p.error}. The API at :8000 may still be starting.`} onRetry={p.onRetry} />
        ) : p.recalls == null ? (
          <Scanning label="LOADING RECALL FEED" />
        ) : p.recalls.length === 0 ? (
          <div className="empty micro">NO RECALLS IN FEED{p.childOnly ? ' (CHILDREN FILTER ON)' : ''}.</div>
        ) : (
          p.recalls.map((r, i) => {
            const sel = r.recall_id === p.selectedId;
            const img = r.image_urls?.[0];
            const hunting = p.huntingId === r.recall_id && p.huntBusy;
            return (
              <article
                key={r.recall_id}
                className={`notice ${sel ? 'is-sel' : ''}`}
                style={{ ['--hz' as string]: hazardColor(r.hazard_class) }}
                onClick={() => p.onSelect(sel ? null : r.recall_id)}
              >
                <div className="notice-top">
                  <HazardChip h={r.hazard_class} />
                  <span className="micro dim">NO. {String(i + 1).padStart(2, '0')}</span>
                </div>
                <div className="notice-body">
                  <div className="notice-text">
                    <h3 className="notice-title" title={r.title}>
                      {r.title}
                    </h3>
                    <dl className="notice-meta">
                      <div>
                        <dt>RECALLED</dt>
                        <dd>{fmtDate(r.recall_date)}</dd>
                      </div>
                      <div>
                        <dt>UNITS</dt>
                        <dd>{fmtUnits(r.units)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="notice-img">
                    {img ? <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <span className="micro dim">NO IMG</span>}
                  </div>
                </div>
                <div className="notice-foot">
                  <span className="counts mono">
                    <b>{r.live_count ?? 0}</b> LIVE · <b className="c-conf">{r.confirmed_count ?? 0}</b> CONFIRMED
                  </span>
                  <button
                    className={`btn-hunt ${hunting ? 'is-busy' : ''}`}
                    disabled={p.huntBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onHunt(r);
                    }}
                  >
                    {hunting ? 'HUNTING…' : 'HUNT →'}
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}
