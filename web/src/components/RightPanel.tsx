import { useEffect, useRef } from 'react';
import type { Stats } from '../api';
import { platformLabel } from '../hazard';
import type { HuntEvent, HuntStatus, LiveCounts } from '../useHunt';
import { Num } from './Num';
import { ErrorBox, Scanning } from './States';

function fmtTs(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const short = (s: unknown, n = 48) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function describe(ev: HuntEvent): { tag: string; text: string; tone?: string } {
  const d = ev.data || {};
  switch (ev.type) {
    case 'start':
      return { tag: 'START', text: `run ${short(d.run_id, 14)} · recall #${d.recall_id ?? '?'}` };
    case 'query':
      return { tag: 'QUERY', text: `${platformLabel(d.platform)} “${short(d.query, 40)}”` };
    case 'source_done':
      return { tag: 'SOURCE', text: `${platformLabel(d.platform)} ${d.count ?? 0} hits · ${d.status ?? ''} · ${d.ms ?? '?'}ms`, tone: String(d.status).startsWith('2') || d.status === 'ok' ? undefined : 'warn' };
    case 'candidate':
      return { tag: 'CAND', text: `${platformLabel(d.platform)} ${short(d.title, 44)}` };
    case 'screened':
      return { tag: 'SCREEN', text: `T1 batch ${d.batch ?? '?'} → ${d.survivors ?? '?'} pass, ${d.rejected ?? 0} drop · ${d.ms ?? '?'}ms${d.error ? ' · ERR' : ''}`, tone: d.error ? 'warn' : undefined };
    case 'vision':
      return { tag: 'VISION', text: `T2 ${short(d.listing_id, 22)} ${d.category ?? ''} ${d.confidence != null ? `c=${Number(d.confidence).toFixed(2)}` : ''}` };
    case 'escalated':
      return { tag: 'ESCAL', text: `T3 ${short(d.listing_id, 22)} → 3.1 Pro${d.t2_confidence != null ? ` (t2 c=${Number(d.t2_confidence).toFixed(2)})` : ''}`, tone: 'amber' };
    case 'verdict':
      return { tag: 'VERDICT', text: `${d.final ?? '?'} ${short(d.listing_id, 22)} s=${d.match_score ?? '?'} T${d.tier_reached ?? '?'}`, tone: d.final === 'CONFIRMED' ? 'hot' : d.final === 'LIKELY' ? 'amber' : 'dim' };
    case 'evidence':
      return { tag: 'EVID', text: short(d.url ?? d.evidence_url ?? d.listing_id, 48) };
    case 'done':
      return { tag: 'DONE', text: Object.entries(d).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 5).map(([k, v]) => `${k}=${v}`).join(' ') || 'complete', tone: 'ok' };
    case 'error':
      return { tag: 'ERROR', text: short(d.message, 120), tone: 'hot' };
    default:
      return { tag: ev.type.toUpperCase().slice(0, 7), text: short(JSON.stringify(d), 60) };
  }
}

function HuntLog({ events, status, runId, error }: { events: HuntEvent[]; status: HuntStatus; runId: string | null; error: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const b = box.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [events.length]);
  return (
    <section className="panel-sec log-sec">
      <header className="sec-head">
        <span className="micro">01 · LIVE HUNT</span>
        <span className={`status-pill st-${status}`}>
          <i />
          {status === 'idle' ? 'STANDBY' : status === 'starting' ? 'DISPATCH' : status.toUpperCase()}
        </span>
      </header>
      <div className="log" ref={box} aria-live="polite">
        {events.length === 0 ? (
          <div className="log-empty">
            {status === 'starting' ? 'Dispatching hunt…' : status === 'error' ? error : '> awaiting dispatch. select a recall, press HUNT.'}
            <span className="blink">▌</span>
          </div>
        ) : (
          events.map((ev, i) => {
            const x = describe(ev);
            return (
              <div key={i} className={`log-line ${x.tone ? `t-${x.tone}` : ''}`}>
                <span className="log-ts">{fmtTs(ev.ts)}</span>
                <span className="log-tag">{x.tag}</span>
                <span className="log-txt">{x.text}</span>
              </div>
            );
          })
        )}
      </div>
      {runId && <div className="micro dim log-run">RUN {runId}</div>}
    </section>
  );
}

function p50(s: Stats | null, n: number): number | null | undefined {
  const m = s?.gemini?.p50_ms_by_tier ?? {};
  return m[`tier${n}`] ?? m[String(n)];
}

function Funnel({ stats, live, active, reduced }: { stats: Stats | null; live: LiveCounts; active: boolean; reduced: boolean }) {
  const f = stats?.funnel;
  const add = (k: keyof LiveCounts) => (active ? live[k] : 0);
  const stages = [
    { k: 'SCREENED', model: 'GEMINI 3.5 FLASH-LITE', tier: 'T1', v: (f?.screened ?? 0) + add('screened'), run: live.screened, ms: p50(stats, 1) },
    { k: 'PHOTO-CHECKED', model: 'GEMINI 3.5 FLASH', tier: 'T2', v: (f?.vision ?? 0) + add('vision'), run: live.vision, ms: p50(stats, 2) },
    { k: 'ESCALATED', model: 'GEMINI 3.1 PRO', tier: 'T3', v: (f?.escalated ?? 0) + add('escalated'), run: live.escalated, ms: p50(stats, 3) },
    { k: 'CONFIRMED', model: 'RECALLED UNIT FOR SALE', tier: '✓', v: (f?.confirmed ?? 0) + add('confirmed'), run: live.confirmed, ms: null },
  ];
  const max = Math.max(1, stages[0].v);
  return (
    <section className="panel-sec funnel-sec">
      <header className="sec-head">
        <span className="micro">02 · GEMINI FUNNEL</span>
        <span className="micro dim">{stats ? `${stats.gemini?.calls ?? 0} CALLS · $${(stats.gemini?.cost_usd ?? 0).toFixed(3)}` : ''}</span>
      </header>
      <ol className="funnel">
        {stages.map((s, i) => (
          <li key={s.k} className={`stage stage-${i}`}>
            <div className="stage-bar" style={{ width: `${Math.max(2, (s.v / max) * 100)}%` }} />
            <div className="stage-row">
              <span className="stage-tier mono">{s.tier}</span>
              <div className="stage-label">
                <span className="micro">{s.k}</span>
                <span className="micro dim">{s.model}{s.ms ? ` · p50 ${Math.round(s.ms)}ms` : ''}</span>
              </div>
              <span className="stage-num serif">
                <Num value={stats ? s.v : null} reduced={reduced} />
              </span>
            </div>
            {s.run > 0 && <span className="stage-run micro">+{s.run} THIS RUN</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function RightPanel(p: {
  stats: Stats | null;
  statsError: string | null;
  onRetryStats: () => void;
  events: HuntEvent[];
  status: HuntStatus;
  runId: string | null;
  huntError: string | null;
  live: LiveCounts;
  runActive: boolean;
  reduced: boolean;
}) {
  const s = p.stats;
  return (
    <aside className="right" aria-label="Hunt telemetry">
      <HuntLog events={p.events} status={p.status} runId={p.runId} error={p.huntError} />
      {p.statsError && !s ? (
        <section className="panel-sec">
          <ErrorBox title="STATS UNAVAILABLE" message={p.statsError} onRetry={p.onRetryStats} />
        </section>
      ) : !s ? (
        <section className="panel-sec">
          <Scanning label="LOADING FUNNEL" compact />
        </section>
      ) : (
        <>
          <Funnel stats={s} live={p.live} active={p.runActive} reduced={p.reduced} />
          <section className="panel-sec stats-sec">
            <div className="stat">
              <span className="serif stat-n">
                <Num value={s.listings_scanned + (p.runActive ? p.live.candidates : 0)} reduced={p.reduced} />
              </span>
              <span className="micro dim">LISTINGS SCANNED</span>
            </div>
            <div className="stat">
              <span className="serif stat-n c-conf">
                <Num value={s.confirmed + (p.runActive ? p.live.confirmed : 0)} reduced={p.reduced} />
              </span>
              <span className="micro dim">CONFIRMED</span>
            </div>
            <div className="stat">
              <span className="serif stat-n">{s.median_days_live == null ? '—' : <Num value={Math.round(s.median_days_live)} reduced={p.reduced} />}</span>
              <span className="micro dim">MEDIAN DAYS STILL FOR SALE</span>
            </div>
          </section>
        </>
      )}
    </aside>
  );
}
