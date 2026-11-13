import { useEffect, useState } from 'react';
import type { Listing } from '../api';
import { hazardColor, platformLabel } from '../hazard';

const RANK: Record<string, number> = { CONFIRMED: 0, LIKELY: 1, REJECTED: 2 };

/** Reliable click path: every visible listing as a row. Click = same Evidence card + camera focus as a pillar. */
export default function ListingStrip({
  listings,
  selectedId,
  onOpen,
  scope,
  onShowAll,
}: {
  listings: Listing[];
  selectedId: string | null;
  onOpen: (l: Listing) => void;
  scope: string;
  onShowAll: (() => void) | null;
}) {
  // open by default when a single recall is selected (the demo path); collapsed for the all-recalls view
  const [open, setOpen] = useState(!!onShowAll);
  useEffect(() => setOpen(!!onShowAll), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!listings.length) return null;
  const rows = [...listings].sort(
    (a, b) => (RANK[a.final ?? ''] ?? 3) - (RANK[b.final ?? ''] ?? 3) || (b.match_score ?? 0) - (a.match_score ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  return (
    <section className={`lstrip ${open ? 'is-open' : ''}`} aria-label="Listings">
      <header className="lstrip-head">
        <button className="lstrip-toggle micro" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? '▾' : '▸'} LISTINGS · {rows.length}
        </button>
        <span className="micro dim lstrip-scope">{scope}</span>
        {onShowAll && (
          <button className="btn-link micro" onClick={onShowAll}>
            SHOW ALL ×
          </button>
        )}
      </header>
      {open && (
        <ol className="lstrip-list">
          {rows.map((l) => (
            <li key={l.listing_id}>
              <button
                className={`lrow ${l.listing_id === selectedId ? 'is-sel' : ''} f-${(l.final ?? 'none').toLowerCase()}`}
                style={{ ['--hz' as string]: hazardColor(l.hazard_class) }}
                onClick={() => onOpen(l)}
                title={l.title ?? ''}
              >
                <span className="lrow-img">
                  {l.image_url ? <img src={l.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : null}
                </span>
                <span className="lrow-main">
                  <span className="lrow-top micro">
                    <b className="lrow-final">{l.final === 'CONFIRMED' ? '■' : '□'} {l.final}</b>
                    <span className="dim">{platformLabel(l.platform).toUpperCase()}</span>
                  </span>
                  <span className="lrow-title">{l.title ?? 'Untitled listing'}</span>
                </span>
                <span className="lrow-price mono">{l.price == null ? '—' : `$${l.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
