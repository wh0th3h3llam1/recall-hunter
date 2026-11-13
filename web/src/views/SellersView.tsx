import { useCallback, useEffect, useMemo, useState } from 'react';
import { b2b, errMsg, type Seller, type SellerDetail } from '../b2b';
import { ErrorBox, Scanning } from '../components/States';
import { hazardColor, hazardLabel, platformLabel } from '../hazard';
import Constellation, { sellerKey } from './Constellation';

interface Props {
  platform: string | null;
  recallNumber: (id: number) => string;
  webgl: boolean;
  reduced: boolean;
  onGLFail: () => void;
  onOpenCase: (caseId: string | number) => void;
}

type SortKey = 'confirmed' | 'likely' | 'listings';

export default function SellersView(p: Props) {
  const [sellers, setSellers] = useState<Seller[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('confirmed');
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<Seller | null>(null);

  const load = useCallback(() => {
    setErr(null);
    setSellers(null);
    b2b.sellers(p.platform, sort).then(
      (s) => setSellers(Array.isArray(s) ? s : []),
      (e) => setErr(errMsg(e)),
    );
  }, [p.platform, sort]);
  useEffect(load, [load]);

  const rows = useMemo(() => {
    if (!sellers) return [];
    const k = sort === 'confirmed' ? 'confirmed_count' : sort === 'likely' ? 'likely_count' : 'listings_count';
    return [...sellers].sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0) || (b.confirmed_count ?? 0) - (a.confirmed_count ?? 0));
  }, [sellers, sort]);
  const graphSellers = useMemo(() => rows.filter((s) => (s.confirmed_count ?? 0) + (s.likely_count ?? 0) > 0).slice(0, 80), [rows]);

  return (
    <div className="view-full sellers-view">
      <section className="sv-table-wrap">
        <header className="vh">
          <div>
            <div className="micro dim">SELLER REGISTER · {p.platform ? platformLabel(p.platform).toUpperCase() : 'ALL PLATFORMS'}</div>
            <h2 className="serif vh-title">Who is still selling recalled goods</h2>
          </div>
          <div className="sv-sort micro">
            SORT
            {(['confirmed', 'likely', 'listings'] as SortKey[]).map((k) => (
              <button key={k} className={sort === k ? 'is-on' : ''} onClick={() => setSort(k)}>
                {k.toUpperCase()}
              </button>
            ))}
          </div>
        </header>
        <div className="sv-scroll">
          {err ? (
            <ErrorBox title="SELLER REGISTER UNAVAILABLE" message={err} onRetry={load} />
          ) : !sellers ? (
            <Scanning label="LOADING SELLERS" />
          ) : rows.length === 0 ? (
            <div className="empty micro">NO SELLERS YET. RUN A HUNT, THEN SYNC CASES.</div>
          ) : (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>SELLER</th>
                  <th className="r">LIST.</th>
                  <th className="r">CONF.</th>
                  <th className="r">LIKELY</th>
                  <th className="r">OPEN CASES</th>
                  <th>RECALLS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const k = sellerKey(s);
                  return (
                    <tr
                      key={k}
                      className={`${hover === k ? 'is-hover' : ''} ${sel && sellerKey(sel) === k ? 'is-sel' : ''}`}
                      onMouseEnter={() => setHover(k)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => setSel(s)}
                    >
                      <td className="dim mono">{String(i + 1).padStart(2, '0')}</td>
                      <td>
                        <div className="sv-name">{s.name || String(s.seller_id)}</div>
                        <div className="micro dim">{platformLabel(s.platform).toUpperCase()}</div>
                      </td>
                      <td className="r mono">{s.listings_count ?? 0}</td>
                      <td className="r mono c-conf">{s.confirmed_count ?? 0}</td>
                      <td className="r mono c-likely">{s.likely_count ?? 0}</td>
                      <td className="r mono">{s.open_cases ?? 0}</td>
                      <td>
                        <div className="sv-chips">
                          {(s.recalls ?? []).slice(0, 4).map((r) => (
                            <span key={r.recall_id} className="rchip" style={{ ['--hz' as string]: hazardColor(r.hazard_class) }} title={`${r.title ?? ''} · ${hazardLabel(r.hazard_class)}`}>
                              <i />
                              {p.recallNumber(r.recall_id)}
                              {r.count > 1 ? <b>×{r.count}</b> : null}
                            </span>
                          ))}
                          {(s.recalls ?? []).length > 4 && <span className="micro dim">+{s.recalls.length - 4}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <section className="sv-graph">
        <div className="sv-graph-head micro">
          <span>SELLER CONSTELLATION</span>
          <span className="dim">NODE SIZE = CONFIRMED + LIKELY · DISC = RECALL · RING = REPEAT OFFENDER</span>
        </div>
        {sellers && graphSellers.length > 0 ? (
          <Constellation
            sellers={graphSellers}
            recallNumber={p.recallNumber}
            hovered={hover}
            selected={sel ? sellerKey(sel) : null}
            onHover={setHover}
            onSelect={setSel}
            webgl={p.webgl}
            reduced={p.reduced}
            onGLFail={p.onGLFail}
          />
        ) : (
          sellers && <div className="empty micro">NO FLAGGED SELLERS TO PLOT.</div>
        )}
        {hover && sellers && (() => {
          const s = sellers.find((x) => sellerKey(x) === hover);
          return s ? (
            <div className="sv-hovercard">
              <div className="micro dim">{platformLabel(s.platform).toUpperCase()}</div>
              <div className="sv-name">{s.name || String(s.seller_id)}</div>
              <div className="micro">
                <span className="c-conf">{s.confirmed_count} CONFIRMED</span> · <span className="c-likely">{s.likely_count} LIKELY</span> · {s.open_cases} OPEN
              </div>
            </div>
          ) : null;
        })()}
      </section>
      <SellerDrawer seller={sel} onClose={() => setSel(null)} recallNumber={p.recallNumber} onOpenCase={p.onOpenCase} />
    </div>
  );
}

function SellerDrawer({ seller, onClose, recallNumber, onOpenCase }: { seller: Seller | null; onClose: () => void; recallNumber: (id: number) => string; onOpenCase: (id: string | number) => void }) {
  const [d, setD] = useState<SellerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = !!seller;
  const load = useCallback(() => {
    if (!seller) return;
    setD(null);
    setErr(null);
    b2b.seller(seller.seller_id).then(setD, (e) => setErr(errMsg(e)));
  }, [seller]);
  useEffect(load, [load]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  const s = d ?? seller;
  const listings = [...(d?.listings ?? [])].sort((a, b) => (a.final === 'CONFIRMED' ? 0 : a.final === 'LIKELY' ? 1 : 2) - (b.final === 'CONFIRMED' ? 0 : b.final === 'LIKELY' ? 1 : 2));
  return (
    <>
      <div className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-label="Seller detail">
        {s && (
          <>
            <header className="drawer-head">
              <div style={{ minWidth: 0 }}>
                <div className="micro dim">SELLER FILE · {platformLabel(s.platform).toUpperCase()}</div>
                <h2 className="serif drawer-name">{s.name || String(s.seller_id)}</h2>
                <div className="micro sd-counts">
                  <span>{s.listings_count ?? 0} LISTINGS</span>
                  <span className="c-conf">{s.confirmed_count ?? 0} CONFIRMED</span>
                  <span className="c-likely">{s.likely_count ?? 0} LIKELY</span>
                  <span>{s.open_cases ?? 0} OPEN CASES</span>
                </div>
              </div>
              <div className="drawer-actions">
                {s.profile_url && (
                  <a className="btn-ghost" href={s.profile_url} target="_blank" rel="noreferrer noopener">
                    PROFILE ↗
                  </a>
                )}
                <button className="ev-close" onClick={onClose} aria-label="Close seller drawer">
                  ×
                </button>
              </div>
            </header>
            <div className="drawer-body">
              {err ? (
                <ErrorBox title="SELLER FILE UNAVAILABLE" message={err} onRetry={load} />
              ) : !d ? (
                <Scanning label="OPENING SELLER FILE" />
              ) : listings.length === 0 ? (
                <div className="empty micro">NO LISTINGS ON FILE.</div>
              ) : (
                <ul className="sd-list">
                  {listings.map((l) => (
                    <li key={l.listing_id} className="sd-row">
                      <span className="lrow-img sd-img">{l.image_url ? <img src={l.image_url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : null}</span>
                      <div className="sd-main">
                        <div className="sd-title">{l.title ?? l.listing_id}</div>
                        <div className="micro dim">
                          {l.recall_id ? `RECALL ${recallNumber(l.recall_id)} · ` : ''}
                          {l.price != null ? `$${l.price} · ` : ''}
                          {l.match_score != null ? `SCORE ${l.match_score}/10 · ` : ''}
                          {l.tier_reached ? `TIER ${l.tier_reached}` : ''}
                        </div>
                        <div className="sd-links micro">
                          {l.url && (
                            <a href={l.url} target="_blank" rel="noreferrer noopener">
                              LISTING ↗
                            </a>
                          )}
                          {l.evidence_url && (
                            <a href={l.evidence_url} target="_blank" rel="noreferrer noopener">
                              EVIDENCE ↗
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="sd-right">
                        <span className={`mini-stamp ms-${(l.final ?? 'none').toLowerCase()}`}>{l.final ?? 'UNSCREENED'}</span>
                        {l.case_id != null ? (
                          <button className="btn-hunt sd-case" onClick={() => onOpenCase(l.case_id!)}>
                            OPEN CASE → <span className="dim">{(l.case_status ?? '').toUpperCase()}</span>
                          </button>
                        ) : (
                          <span className="micro dim">NO CASE</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
