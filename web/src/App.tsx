import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, FIXTURE_MODE, type Listing, type Recall, type Stats } from './api';
import ContourBackground from './components/ContourBackground';
import EvidenceCard from './components/EvidenceCard';
import ProofDrawer from './components/ProofDrawer';
import RecallRail from './components/RecallRail';
import RightPanel from './components/RightPanel';
import { ErrorBox, Scanning } from './components/States';
import SurveyFrame from './components/SurveyFrame';
import ListingStrip from './components/ListingStrip';
import { HAZARD_COLORS, HAZARD_LABEL, platformLabel } from './hazard';
import MapScene, { type HoverInfo } from './scene/MapScene';
import Map2D from './scene/Map2D';
import GLBoundary from './components/GLBoundary';
import { hasWebGL, markWebGLBroken } from './webgl';
import { useHunt } from './useHunt';

function useReducedMotion() {
  const q = '(prefers-reduced-motion: reduce)';
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setR(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return r;
}

const msg = (e: unknown) => String((e as Error)?.message ?? e);

export default function App() {
  const reduced = useReducedMotion();
  const [webgl, setWebgl] = useState(() => hasWebGL());
  const [childOnly, setChildOnly] = useState(false);
  const [recalls, setRecalls] = useState<Recall[] | null>(null);
  const [recallsErr, setRecallsErr] = useState<string | null>(null);
  const recallCache = useRef(new Map<number, Recall>());
  const [selRecall, setSelRecall] = useState<number | null>(null);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [listingsErr, setListingsErr] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [selListing, setSelListing] = useState<Listing | null>(null);
  const [evRecall, setEvRecall] = useState<Recall | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadRecalls = useCallback(() => {
    setRecallsErr(null);
    setRecalls(null);
    api.recalls(childOnly).then(
      (rs) => {
        rs.forEach((r) => recallCache.current.set(r.recall_id, r));
        setRecalls(rs);
      },
      (e) => setRecallsErr(msg(e)),
    );
  }, [childOnly]);

  // sequence guards: only the latest request for the current selection may land
  const listSeq = useRef(0);
  const statSeq = useRef(0);
  const loadListings = useCallback((rid: number | null) => {
    const n = ++listSeq.current;
    setListingsErr(null);
    return api.listings(rid).then(
      (ls) => n === listSeq.current && setListings(Array.isArray(ls) ? ls : []),
      (e) => n === listSeq.current && setListingsErr(msg(e)),
    );
  }, []);

  const loadStats = useCallback((rid: number | null) => {
    const n = ++statSeq.current;
    setStatsErr(null);
    return api.stats(rid).then(
      (s) => n === statSeq.current && setStats(s),
      (e) => n === statSeq.current && setStatsErr(msg(e)),
    );
  }, []);

  useEffect(loadRecalls, [loadRecalls]);
  useEffect(() => {
    setListings(null);
    setSelListing(null);
    loadListings(selRecall);
    loadStats(selRecall);
  }, [selRecall, loadListings, loadStats]);

  const selRecallRef = useRef(selRecall);
  selRecallRef.current = selRecall;
  const childOnlyRef = useRef(childOnly);
  childOnlyRef.current = childOnly;

  const hunt = useHunt(
    useCallback(
      (rid: number | null) => {
        setRefreshing(true);
        Promise.allSettled([loadListings(selRecallRef.current), loadStats(selRecallRef.current)]).finally(() => setRefreshing(false));
        api.recalls(childOnlyRef.current).then((rs) => {
          rs.forEach((r) => recallCache.current.set(r.recall_id, r));
          setRecalls(rs);
        }, () => undefined);
      },
      [loadListings, loadStats],
    ),
  );

  const startHunt = useCallback(
    (r: Recall) => {
      setSelRecall(r.recall_id);
      hunt.begin(r.recall_id);
      api.hunt(r.recall_id).then(
        ({ run_id }) => hunt.start(run_id, r.recall_id),
        (e) => hunt.fail(r.recall_id, `HUNT dispatch failed: ${msg(e)}`),
      );
    },
    [hunt],
  );

  const huntBusy = hunt.status === 'starting' || hunt.status === 'running';
  const runActive = huntBusy || refreshing;

  const enriched = useMemo(() => {
    if (!listings) return null;
    return listings.map((l) => ({ ...l, hazard_class: l.hazard_class ?? recallCache.current.get(l.recall_id)?.hazard_class ?? 'other' }));
  }, [listings, recalls]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => (enriched ?? []).filter((l) => l.final === 'CONFIRMED' || l.final === 'LIKELY' || (showRejected && l.final === 'REJECTED')), [enriched, showRejected]);
  const counts = useMemo(() => {
    const c = { CONFIRMED: 0, LIKELY: 0, REJECTED: 0, online: 0, pending: 0 };
    (enriched ?? []).forEach((l) => {
      if (l.final) c[l.final] += 1;
      else c.pending += 1;
    });
    visible.forEach((l) => (l.lat == null || l.lon == null) && c.online++);
    return c;
  }, [enriched, visible]);

  const openListing = useCallback((l: Listing) => {
    setSelListing(l);
    setHover(null);
    const r = recallCache.current.get(l.recall_id) ?? null;
    setEvRecall(r);
    if (!r || !r.hazard) api.recall(l.recall_id).then((x) => setEvRecall(x), () => undefined);
  }, []);
  const closeEvidence = useCallback(() => setSelListing(null), []);

  const selRecallObj = selRecall != null ? recallCache.current.get(selRecall) : null;
  const apiDown = !!recallsErr && !!statsErr;
  const presentHazards = useMemo(() => [...new Set(visible.map((l) => l.hazard_class ?? 'other'))], [visible]);

  return (
    <div className="app">
      <ContourBackground reduced={reduced} webgl={webgl} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="26" height="26" viewBox="0 0 26 26">
              <path d="M13 2 L24 22 H2 Z" fill="none" stroke="#F3A712" strokeWidth="1.4" />
              <path d="M13 9 V15 M13 17.5 V19" stroke="#F3A712" strokeWidth="1.6" />
            </svg>
          </span>
          <span className="brand-name mono">RECALL HUNTER</span>
          <span className="brand-sep">/</span>
          <span className="brand-sub mono">LIVE MARKETPLACE SURVEILLANCE</span>
        </div>
        <div className="bulletin mono">
          <span>BULLETIN · {new Date().toISOString().slice(0, 10)}</span>
          <span className="dim">SOURCE: U.S. CPSC RECALLS</span>
          <span className={`link-dot ${apiDown ? 'down' : stats ? 'up' : 'wait'}`}>
            <i /> API {apiDown ? 'OFFLINE' : stats ? 'LINKED' : 'CONNECTING'}
          </span>
        </div>
        <button className="btn-proof" onClick={() => setProofOpen(true)}>
          PROOF ▸
        </button>
      </header>

      <RecallRail
        recalls={recalls}
        error={recallsErr}
        childOnly={childOnly}
        setChildOnly={setChildOnly}
        selectedId={selRecall}
        onSelect={setSelRecall}
        onHunt={startHunt}
        huntingId={hunt.recallId}
        huntBusy={huntBusy}
        onRetry={loadRecalls}
      />

      <main className="center">
        {webgl ? (
          <GLBoundary
            fallback={<Map2D listings={visible} selectedId={selListing?.listing_id ?? null} reduced={reduced} onHover={setHover} onSelect={openListing} />}
            onError={() => {
              markWebGLBroken();
              setWebgl(false);
            }}
          >
            <MapScene listings={visible} selectedId={selListing?.listing_id ?? null} reduced={reduced} onHover={setHover} onSelect={openListing} />
          </GLBoundary>
        ) : (
          <Map2D listings={visible} selectedId={selListing?.listing_id ?? null} reduced={reduced} onHover={setHover} onSelect={openListing} />
        )}
        <SurveyFrame />

        <div className="sheet-title">
          <div className="micro dim">SURVEY SHEET · {selRecallObj ? `RECALL ${selRecallObj.recall_number}` : 'ALL RECALLS'}</div>
          <div className="serif sheet-h">{selRecallObj ? selRecallObj.product_name || selRecallObj.title : 'Hazards still for sale'}</div>
          <div className="micro sheet-counts">
            <span className="c-conf">■ {counts.CONFIRMED} CONFIRMED</span>
            <span className="c-likely">□ {counts.LIKELY} LIKELY</span>
            <span className="dim">{counts.REJECTED} REJECTED</span>
            {counts.pending > 0 && <span className="dim">{counts.pending} UNSCREENED</span>}
          </div>
        </div>

        <div className="map-key">
          <div className="key-row">
            <span className="micro dim">PILLAR HEIGHT = DAYS SINCE RECALL (LOG)</span>
          </div>
          <div className="key-row">
            <span className="key-solid" /> <span className="micro">CONFIRMED</span>
            <span className="key-hollow" /> <span className="micro">LIKELY</span>
            <span className="micro dim">MAP = LOCAL RESALE · RING = ONLINE SELLERS</span>
          </div>
          <div className="key-hz">
            {(presentHazards.length ? presentHazards : Object.keys(HAZARD_COLORS)).map((h) => (
              <span key={h} className="micro">
                <i style={{ background: HAZARD_COLORS[h] ?? HAZARD_COLORS.other }} />
                {(HAZARD_LABEL[h] ?? h).toUpperCase()}
              </span>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
            <span className="toggle-box" aria-hidden />
            <span className="micro">SHOW REJECTED</span>
          </label>
        </div>

        <ListingStrip listings={visible} selectedId={selListing?.listing_id ?? null} onOpen={openListing} scope={selRecallObj ? `RECALL ${selRecallObj.recall_number}` : 'ALL RECALLS'} onShowAll={selRecall != null ? () => setSelRecall(null) : null} />

        <div className="proj-note micro dim">PROJ. ALBERS USA · AK / HI INSET · NOT TO SCALE VERTICALLY</div>

        {listingsErr && !listings && (
          <div className="center-overlay">
            <ErrorBox title="SURVEY LINK DOWN" message={`Could not load listings: ${listingsErr}`} onRetry={() => loadListings(selRecall)} />
          </div>
        )}
        {!listingsErr && listings == null && (
          <div className="center-overlay passive">
            <Scanning label="SURVEYING LISTINGS" />
          </div>
        )}
        {listings && listings.length === 0 && !huntBusy && (
          <div className="center-overlay passive">
            <div className="empty-map">
              <div className="serif">No listings surveyed.</div>
              <div className="micro">PRESS HUNT ON A RECALL TO DISPATCH THE SURVEY.</div>
            </div>
          </div>
        )}
        {huntBusy && (
          <div className="hunt-banner micro">
            <span className="blink">●</span> HUNT IN PROGRESS · {hunt.live.candidates} CANDIDATES · {hunt.live.confirmed} CONFIRMED
          </div>
        )}
        {FIXTURE_MODE && <div className="dev-banner micro">DEV FIXTURE · SYNTHETIC DATA · NOT REAL</div>}

        <EvidenceCard listing={selListing} recall={evRecall} onClose={closeEvidence} />
      </main>

      <RightPanel
        stats={stats}
        statsError={statsErr}
        onRetryStats={() => loadStats(selRecall)}
        events={hunt.events}
        status={hunt.status}
        runId={hunt.runId}
        huntError={hunt.error}
        live={hunt.live}
        runActive={runActive}
        reduced={reduced}
      />

      {hover && !selListing && (
        <div className="tooltip" style={{ left: hover.x + 16, top: hover.y + 14 }}>
          <div className="micro dim">
            {platformLabel(hover.l.platform).toUpperCase()} · {hover.l.final}
          </div>
          <div className="tt-title">{hover.l.title ?? 'Untitled listing'}</div>
          <div className="mono tt-meta">
            {hover.l.price == null ? '—' : `$${hover.l.price.toLocaleString('en-US')}`} · {hover.l.location ?? 'online'}
          </div>
        </div>
      )}

      <ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} />
    </div>
  );
}
