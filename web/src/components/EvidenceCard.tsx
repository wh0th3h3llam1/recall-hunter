import { useEffect, useState } from 'react';
import type { Listing, Recall } from '../api';
import { hazardColor, platformLabel } from '../hazard';
import { fmtDate, HazardChip } from './RecallRail';

const TIER: Record<number, string> = { 1: '3.5 FLASH-LITE', 2: '3.5 FLASH', 3: '3.1 PRO' };

function fmtPrice(p: number | null) {
  return p == null ? '—' : `$${p.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export default function EvidenceCard({ listing, recall, onClose }: { listing: Listing | null; recall: Recall | null; onClose: () => void }) {
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => setImgOk(true), [listing?.listing_id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const open = !!listing;
  const l = listing;
  const box = l?.label_box?.box_2d;
  const final = l?.final ?? 'LIKELY';
  const hz = l?.hazard_class ?? recall?.hazard_class;

  return (
    <div className={`evidence ${open ? 'is-open' : ''}`} aria-hidden={!open} role="dialog" aria-label="Listing evidence">
      {l && (
        <div className="ev-inner" style={{ ['--hz' as string]: hazardColor(hz) }}>
          <div className="ev-media">
            <div className="ev-imgwrap">
              {l.image_url && imgOk ? (
                <>
                  <img src={l.image_url} alt={l.title ?? 'listing image'} referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
                  {box && box.length === 4 && (
                    <div
                      className="ev-box"
                      style={{
                        top: `${box[0] / 10}%`,
                        left: `${box[1] / 10}%`,
                        height: `${(box[2] - box[0]) / 10}%`,
                        width: `${(box[3] - box[1]) / 10}%`,
                      }}
                    >
                      <span className="ev-box-label">{l.label_box?.label || 'MATCH REGION'}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="ev-noimg micro">IMAGE UNAVAILABLE{l.image_url ? ' (HOST BLOCKED)' : ''}</div>
              )}
            </div>
            <div className="micro dim ev-caption">GEMINI LABEL BOX · box_2d [{box ? box.join(', ') : 'none'}]</div>
          </div>

          <div className="ev-body">
            <div className="ev-top">
              <div>
                <div className="micro dim">EVIDENCE · {platformLabel(l.platform).toUpperCase()} · {l.listing_id}</div>
                <h2 className="serif ev-title">{l.title ?? 'Untitled listing'}</h2>
                <div className="ev-sub mono">
                  {fmtPrice(l.price)} · {l.seller ?? 'seller unknown'} · {l.location ?? 'online'}
                </div>
              </div>
              <div className={`stamp stamp-${final.toLowerCase()}`}>
                <span>{final}</span>
                <small>INSPECTED · TIER {l.tier_reached ?? '?'}</small>
              </div>
              <button className="ev-close" onClick={onClose} aria-label="Close evidence">
                ×
              </button>
            </div>

            <dl className="ev-grid">
              <div>
                <dt>CATEGORY</dt>
                <dd>{(l.category ?? '—').replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt>MATCH SCORE</dt>
                <dd>
                  <b className="serif">{l.match_score ?? '—'}</b>
                  <span className="dim">/10</span>
                </dd>
              </div>
              <div>
                <dt>CONFIDENCE</dt>
                <dd>
                  <b className="serif">{l.confidence == null ? '—' : Math.round(l.confidence * 100)}</b>
                  <span className="dim">%</span>
                </dd>
              </div>
              <div>
                <dt>DECIDED AT</dt>
                <dd>
                  <span className="tier-badge">TIER {l.tier_reached ?? '?'}</span>
                  <span className="dim micro"> {TIER[l.tier_reached ?? 0] ?? ''}</span>
                </dd>
              </div>
              <div>
                <dt>STILL FOR SALE</dt>
                <dd>{l.days_since_recall == null ? '—' : `${l.days_since_recall} DAYS`}</dd>
              </div>
            </dl>

            <div className="ev-text">
              <div className="micro dim">GEMINI REASON</div>
              <p>{l.reason ?? '—'}</p>
            </div>
            <div className="ev-text ev-hazard">
              <div className="ev-hz-head">
                <HazardChip h={hz} />
                <span className="micro dim">
                  RECALL {recall?.recall_number ?? `#${l.recall_id}`} · {fmtDate(recall?.recall_date)}
                </span>
              </div>
              <p>{recall?.hazard ?? 'Recall hazard text not loaded.'}</p>
            </div>

            <div className="ev-links">
              {l.url ? (
                <a href={l.url} target="_blank" rel="noreferrer noopener">
                  OPEN LISTING ↗
                </a>
              ) : (
                <span className="dim">NO LISTING URL</span>
              )}
              {l.evidence_url ? (
                <a href={l.evidence_url} target="_blank" rel="noreferrer noopener">
                  EVIDENCE JSON ↗
                </a>
              ) : (
                <span className="dim">NO EVIDENCE FILE</span>
              )}
              {recall?.url ? (
                <a href={recall.url} target="_blank" rel="noreferrer noopener">
                  CPSC RECALL ↗
                </a>
              ) : (
                <span className="dim">NO CPSC URL</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
