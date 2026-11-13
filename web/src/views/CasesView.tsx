import { useCallback, useEffect, useMemo, useState } from 'react';
import { b2b, errMsg, type Case, type SLA } from '../b2b';
import { Num } from '../components/Num';
import { HazardChip } from '../components/RecallRail';
import { ErrorBox, Scanning } from '../components/States';
import { hazardColor, platformLabel } from '../hazard';

const COLS = ['open', 'notified', 'removed', 'verified'] as const;
const COL_LABEL: Record<string, string> = { open: 'OPEN', notified: 'NOTIFIED', removed: 'REMOVED', verified: 'VERIFIED', dismissed: 'DISMISSED' };
const ALL_STATUS = ['open', 'notified', 'removed', 'verified', 'dismissed'];

interface Props {
  platform: string | null;
  reduced: boolean;
  openCaseId: string | number | null;
  onCaseOpened: () => void;
  recallUrl: (id: number | null) => string | null;
}

const norm = (s: string | null | undefined) => (s ?? 'open').toLowerCase();

function fmtTime(t: string | null | undefined) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t);
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function sevClass(s: Case['severity']) {
  const t = String(s ?? '').toLowerCase();
  if (['confirmed', 'critical', 'high', '3', '4', '5'].includes(t)) return 'sev-hi';
  if (['likely', 'medium', 'med', '2'].includes(t)) return 'sev-md';
  return 'sev-lo';
}

export default function CasesView(p: Props) {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sla, setSla] = useState<SLA | null>(null);
  const [slaErr, setSlaErr] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [selId, setSelId] = useState<string | number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    b2b.cases(p.platform).then(
      (c) => setCases(Array.isArray(c) ? c : []),
      (e) => setErr(errMsg(e)),
    );
    setSlaErr(null);
    b2b.sla(p.platform).then(setSla, (e) => setSlaErr(errMsg(e)));
  }, [p.platform]);
  useEffect(() => {
    setCases(null);
    setSla(null);
    load();
  }, [load]);

  useEffect(() => {
    if (p.openCaseId != null) {
      setSelId(p.openCaseId);
      p.onCaseOpened();
    }
  }, [p.openCaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = useCallback((c: Partial<Case> & { case_id: Case['case_id'] }) => {
    setCases((xs) => (xs ? xs.map((x) => (String(x.case_id) === String(c.case_id) ? { ...x, ...c } : x)) : xs));
  }, []);

  const cols = showDismissed ? [...COLS, 'dismissed'] : [...COLS];
  const byCol = useMemo(() => {
    const m: Record<string, Case[]> = {};
    cols.forEach((c) => (m[c] = []));
    (cases ?? []).forEach((c) => {
      const s = norm(c.status);
      if (m[s]) m[s].push(c);
    });
    const sev = (c: Case) => (String(c.severity).toUpperCase() === 'CONFIRMED' ? 0 : 1);
    Object.values(m).forEach((l) => l.sort((a, b) => sev(a) - sev(b) || (b.days_open ?? 0) - (a.days_open ?? 0)));
    return m;
  }, [cases, showDismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = cases?.find((c) => String(c.case_id) === String(selId)) ?? null;
  const repeat = sla ? (Array.isArray(sla.repeat_offenders) ? sla.repeat_offenders.length : sla.repeat_offenders) : null;

  const sync = () => {
    setSyncing(true);
    setSyncMsg(null);
    b2b.sync().then(
      (r) => {
        setSyncMsg(
          Object.entries(r ?? {})
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
            .join(' · ') || 'Synced.',
        );
        load();
      },
      (e) => setSyncMsg(`Sync failed: ${errMsg(e)}`),
    ).finally(() => setSyncing(false));
  };

  return (
    <div className="view-full cases-view">
      <section className="sla">
        <div className="sla-head">
          <div className="micro dim">TAKEDOWN SLA · {p.platform ? platformLabel(p.platform).toUpperCase() : 'ALL PLATFORMS'}</div>
          <h2 className="serif vh-title">Case queue</h2>
        </div>
        {slaErr && !sla ? (
          <div className="sla-err micro">SLA UNAVAILABLE · {slaErr}</div>
        ) : (
          <div className="sla-nums">
            <div className="sla-n">
              <span className="serif">{sla?.median_hours_to_notify == null ? '—' : sla.median_hours_to_notify.toFixed(1)}</span>
              <span className="micro dim">MEDIAN HOURS TO NOTIFY</span>
            </div>
            <div className="sla-n">
              <span className="serif">{sla?.median_hours_to_removal == null ? '—' : sla.median_hours_to_removal.toFixed(1)}</span>
              <span className="micro dim">MEDIAN HOURS TO REMOVAL</span>
            </div>
            <div className="sla-n">
              <span className="serif">
                {sla?.pct_removed_48h == null ? '—' : <Num value={Math.round(sla.pct_removed_48h)} reduced={p.reduced} />}
                {sla?.pct_removed_48h != null && <small>%</small>}
              </span>
              <span className="micro dim">REMOVED WITHIN 48 H</span>
            </div>
            <div className="sla-n">
              <span className="serif c-conf">{repeat == null ? '—' : <Num value={Number(repeat)} reduced={p.reduced} />}</span>
              <span className="micro dim">REPEAT OFFENDERS</span>
            </div>
          </div>
        )}
        <div className="sla-actions">
          <label className="toggle">
            <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
            <span className="toggle-box" aria-hidden />
            <span className="micro">SHOW DISMISSED</span>
          </label>
          <button className="btn-ghost" onClick={sync} disabled={syncing} title="Open a case for every CONFIRMED/LIKELY verdict without one">
            {syncing ? 'SYNCING…' : 'SYNC CASES ↻'}
          </button>
          <a className="btn-proof" href={b2b.reportUrl(p.platform)} download>
            EXPORT CSV FOR REGULATORS ↓
          </a>
        </div>
        {syncMsg && <div className="micro dim sync-msg">{syncMsg}</div>}
      </section>

      <section className="kanban" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {err ? (
          <div className="kanban-msg">
            <ErrorBox title="CASE QUEUE UNAVAILABLE" message={err} onRetry={load} />
          </div>
        ) : !cases ? (
          <div className="kanban-msg">
            <Scanning label="LOADING CASES" />
          </div>
        ) : cases.length === 0 ? (
          <div className="kanban-msg">
            <div className="empty-map">
              <div className="serif">No cases open.</div>
              <div className="micro">RUN A HUNT, THEN PRESS SYNC CASES.</div>
            </div>
          </div>
        ) : (
          cols.map((c) => (
            <div key={c} className={`kcol kcol-${c}`}>
              <header className="kcol-head">
                <span className="micro">{COL_LABEL[c]}</span>
                <span className="serif kcol-n">{byCol[c].length}</span>
              </header>
              <div className="kcol-list">
                {byCol[c].length === 0 && <div className="micro dim kcol-empty">—</div>}
                {byCol[c].map((k) => (
                  <button key={String(k.case_id)} className={`kcard ${String(selId) === String(k.case_id) ? 'is-sel' : ''}`} style={{ ['--hz' as string]: hazardColor(k.hazard_class) }} onClick={() => setSelId(k.case_id)}>
                    <span className="lrow-img kcard-img">{k.image_url ? <img src={k.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : null}</span>
                    <span className="kcard-main">
                      <span className="kcard-title">{k.listing_title ?? k.listing_id}</span>
                      <span className="micro dim kcard-seller">
                        {(k.seller_name ?? 'unknown seller').toUpperCase()} · {platformLabel(k.platform).toUpperCase()}
                      </span>
                      <span className="kcard-foot">
                        <HazardChip h={k.hazard_class} />
                        <span className="micro">{k.recall_number ? `R-${k.recall_number}` : ''}</span>
                      </span>
                      <span className="kcard-foot micro">
                        <span className={`sev ${sevClass(k.severity)}`}>{String(k.severity ?? '—').toUpperCase()}</span>
                        <span className="dim">{k.days_open == null ? '' : `${Math.round(k.days_open)}D OPEN`}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <CaseSheet c={sel} missingId={selId != null && cases && !sel ? selId : null} onClose={() => setSelId(null)} onUpdate={upsert} onReload={load} recallUrl={p.recallUrl} />
    </div>
  );
}

function CaseSheet({ c, missingId, onClose, onUpdate, onReload, recallUrl }: { c: Case | null; missingId: string | number | null; onClose: () => void; onUpdate: (c: Partial<Case> & { case_id: Case['case_id'] }) => void; onReload: () => void; recallUrl: (id: number | null) => string | null }) {
  const open = !!c || missingId != null;
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeModel, setNoticeModel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [copied, setCopied] = useState(false);
  const id = c?.case_id;
  const [detail, setDetail] = useState<Case | null>(null);
  const loadDetail = useCallback(() => {
    if (id == null) return;
    b2b.caseDetail(id).then(
      (d) => {
        setDetail(d);
        if (d?.notice_text) setNotice((n) => n ?? d.notice_text ?? null);
      },
      () => setDetail(null),
    );
  }, [id]);

  useEffect(() => {
    setDetail(null);
    loadDetail();
    setNotice(c?.notice_text ?? null);
    setNoticeModel(null);
    setMsg(null);
    setNotes(c?.notes ?? '');
    setCopied(false);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg({ tone: 'bad', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const patch = (body: { status?: string; notes?: string }) =>
    run(body.status ? 'status' : 'notes', async () => {
      const r = await b2b.patchCase(c!.case_id, body);
      onUpdate({ ...(r ?? {}), case_id: c!.case_id, ...(body.status && !r?.status ? { status: body.status } : {}) });
      setMsg({ tone: 'ok', text: body.status ? `Status set to ${body.status.toUpperCase()}.` : 'Notes saved.' });
      onReload();
      loadDetail();
    });

  const timeline = useMemo(() => {
    if (!c) return [];
    const evs = detail?.events ?? c.events;
    if (Array.isArray(evs) && evs.length)
      return evs.map((e) => {
        const pl = (e.payload ?? {}) as Record<string, unknown>;
        const extra = pl.http_status != null ? ` · HTTP ${pl.http_status}` : pl.model ? ` · ${pl.model}` : pl.to ? ` · ${pl.from} → ${pl.to}` : '';
        return { t: String(e.ts ?? e.at ?? e.created_at ?? ''), label: String(e.type ?? e.event ?? e.kind ?? 'event').replace(/_/g, ' ') + (e.actor ? ` (${e.actor})` : '') + extra };
      });
    return (
      [
        ['opened', c.opened_at],
        ['notified', c.notified_at],
        ['removed', c.removed_at],
        ['verified', c.verified_at],
      ] as [string, string | null][]
    )
      .filter(([, t]) => !!t)
      .map(([label, t]) => ({ t: t!, label }));
  }, [c, detail]);

  const cpsc = c ? recallUrl(c.recall_id) : null;

  return (
    <>
      <div className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer case-sheet ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-label="Case sheet">
        {!c && missingId != null && (
          <div className="drawer-body">
            <ErrorBox title="CASE NOT IN THIS VIEW" message={`Case ${missingId} is not in the current queue (check the platform filter or the dismissed toggle).`} />
            <button className="btn-ghost" onClick={onClose}>
              CLOSE
            </button>
          </div>
        )}
        {c && (
          <>
            <header className="drawer-head" style={{ ['--hz' as string]: hazardColor(c.hazard_class) }}>
              <div style={{ minWidth: 0 }}>
                <div className="micro dim">
                  CASE {String(c.case_id)} · {platformLabel(c.platform).toUpperCase()} · {(c.seller_name ?? 'unknown seller').toUpperCase()}
                </div>
                <h2 className="serif drawer-name">{c.listing_title ?? c.listing_id}</h2>
                <div className="cs-sub">
                  <HazardChip h={c.hazard_class} />
                  <span className="micro">RECALL {c.recall_number ?? `#${c.recall_id}`}</span>
                  <span className={`sev micro ${sevClass(c.severity)}`}>SEVERITY · {String(c.severity ?? '—').toUpperCase()}</span>
                  {c.price != null && <span className="micro">${c.price}</span>}
                </div>
              </div>
              <div className="drawer-actions">
                <select className="cs-status" value={norm(c.status)} disabled={busy != null} onChange={(e) => patch({ status: e.target.value })} aria-label="Case status">
                  {ALL_STATUS.map((s) => (
                    <option key={s} value={s}>
                      {s.toUpperCase()}
                    </option>
                  ))}
                </select>
                <button className="ev-close" onClick={onClose} aria-label="Close case sheet">
                  ×
                </button>
              </div>
            </header>
            <div className="drawer-body cs-body">
              <div className="cs-top">
                <span className="cs-img">{c.image_url ? <img src={c.image_url} alt="" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <span className="micro dim">NO IMAGE</span>}</span>
                <div className="cs-links micro">
                  {c.listing_url ? (
                    <a href={c.listing_url} target="_blank" rel="noreferrer noopener">
                      LISTING ↗
                    </a>
                  ) : (
                    <span className="dim">NO LISTING URL</span>
                  )}
                  {c.evidence_url ? (
                    <a href={c.evidence_url} target="_blank" rel="noreferrer noopener">
                      EVIDENCE ↗
                    </a>
                  ) : (
                    <span className="dim">NO EVIDENCE</span>
                  )}
                  {cpsc ? (
                    <a href={cpsc} target="_blank" rel="noreferrer noopener">
                      CPSC ↗
                    </a>
                  ) : (
                    <span className="dim">CPSC URL N/A</span>
                  )}
                </div>
                <div className="cs-actions">
                  <button
                    className="btn-hunt"
                    disabled={busy != null}
                    onClick={() =>
                      run('notice', async () => {
                        const r = await b2b.notice(c.case_id);
                        setNotice(r.notice_text ?? '');
                        setNoticeModel(r.model ?? null);
                        setMsg({ tone: 'info', text: 'Draft ready. Nothing has been sent.' });
                        loadDetail();
                      })
                    }
                  >
                    {busy === 'notice' ? 'DRAFTING…' : 'DRAFT NOTICE'}
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={busy != null}
                    onClick={() =>
                      run('verify', async () => {
                        const r = await b2b.verify(c.case_id);
                        if (r.status) onUpdate({ case_id: c.case_id, status: r.status });
                        setMsg(
                          r.is_live
                            ? { tone: 'bad', text: `STILL LIVE · HTTP ${r.http_status ?? '?'} · listing is still for sale.` }
                            : { tone: 'ok', text: `GONE · HTTP ${r.http_status ?? '?'} · case moved to ${String(r.status ?? 'removed').toUpperCase()}.` },
                        );
                        onReload();
                        loadDetail();
                      })
                    }
                  >
                    {busy === 'verify' ? 'CHECKING LISTING…' : 'VERIFY TAKEDOWN'}
                  </button>
                </div>
              </div>
              {msg && <div className={`cs-msg cs-${msg.tone} micro`}>{msg.text}</div>}

              {notice != null && (
                <div className="cs-notice">
                  <div className="cs-notice-head micro">
                    <span>NOTICE DRAFT</span>
                    <span className="dim">Drafted by DigitalOcean Serverless Inference · gpt-oss-120b{noticeModel && !/gpt-oss/i.test(noticeModel) ? ` (served by ${noticeModel})` : ''}</span>
                  </div>
                  <textarea value={notice} onChange={(e) => setNotice(e.target.value)} rows={12} spellCheck />
                  <div className="cs-notice-actions">
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        navigator.clipboard?.writeText(notice).then(
                          () => setCopied(true),
                          () => setMsg({ tone: 'bad', text: 'Clipboard blocked; select the text and copy manually.' }),
                        );
                      }}
                    >
                      {copied ? 'COPIED ✓' : 'COPY'}
                    </button>
                    <button className="btn-hunt" disabled={busy != null || norm(c.status) !== 'open'} onClick={() => patch({ status: 'notified' })} title="Records that you sent this notice yourself. The console never sends anything.">
                      MARK AS SENT
                    </button>
                  </div>
                </div>
              )}

              <div className="cs-notes">
                <div className="micro dim">NOTES</div>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Internal notes for this case" />
                <button className="btn-ghost" disabled={busy != null || notes === (c.notes ?? '')} onClick={() => patch({ notes })}>
                  {busy === 'notes' ? 'SAVING…' : 'SAVE NOTES'}
                </button>
              </div>

              <div className="cs-timeline">
                <div className="micro dim">TIMELINE</div>
                {timeline.length === 0 ? (
                  <div className="micro dim">No timestamps recorded.</div>
                ) : (
                  <ol>
                    {timeline.map((t, i) => (
                      <li key={i}>
                        <span className="mono dim">{fmtTime(t.t)}</span>
                        <span className="micro">{t.label.toUpperCase()}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
