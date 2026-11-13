import { useCallback, useEffect, useState } from 'react';
import { api, type Proof } from '../api';
import { ErrorBox, Scanning } from './States';

const SPONSORS = ['brightdata', 'gemini', 'tiger', 'digitalocean', 'sentry', 'snowflake', 'cpsc'];

function fmtTime(t: string | number | null) {
  if (t == null) return '—';
  const d = typeof t === 'number' ? new Date(t > 1e12 ? t : t * 1000) : new Date(t);
  if (isNaN(d.getTime())) return String(t);
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function okStatus(s: unknown) {
  const t = String(s ?? '').toLowerCase();
  return t === 'ok' || t === 'success' || /^2\d\d$/.test(t);
}

export default function ProofDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<Proof | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    setData(null);
    api.proof().then(setData, (e) => setErr(String(e.message || e)));
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);

  const rows = data?.rows ?? [];
  const seen = new Set(rows.map((r) => r.sponsor));
  const missing = SPONSORS.filter((s) => !seen.has(s));

  return (
    <>
      <div className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-label="Proof of real API calls">
        <header className="drawer-head">
          <div>
            <div className="micro dim">PROOF LOG · LAST REAL CALL PER SPONSOR PRODUCT</div>
            <h2 className="serif">Proof of work</h2>
          </div>
          <div className="drawer-actions">
            <button className="btn-ghost" onClick={load}>
              REFRESH ↻
            </button>
            <button className="ev-close" onClick={onClose} aria-label="Close proof drawer">
              ×
            </button>
          </div>
        </header>
        <div className="drawer-body">
          {err ? (
            <ErrorBox title="PROOF LOG UNREACHABLE" message={err} onRetry={load} />
          ) : !data ? (
            <Scanning label="READING PROOF LOG" />
          ) : (
            <table className="proof">
              <thead>
                <tr>
                  <th>SPONSOR</th>
                  <th>PRODUCT</th>
                  <th>ENDPOINT</th>
                  <th>STATUS</th>
                  <th className="r">MS</th>
                  <th className="r">REC</th>
                  <th>TIME</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="sp">{r.sponsor}</td>
                    <td>{r.product}</td>
                    <td className="ep" title={r.endpoint}>
                      {r.endpoint}
                    </td>
                    <td>
                      <span className={`pst ${okStatus(r.status) ? 'ok' : 'bad'}`}>{String(r.status ?? '—')}</span>
                    </td>
                    <td className="r">{r.latency_ms == null ? '—' : Math.round(r.latency_ms)}</td>
                    <td className="r">{r.records ?? '—'}</td>
                    <td className="dim">{fmtTime(r.called_at)}</td>
                  </tr>
                ))}
                {missing.map((s) => {
                  const notConf = data.configured && data.configured[s] === false;
                  return (
                    <tr key={s} className="row-missing">
                      <td className="sp">{s}</td>
                      <td colSpan={6}>
                        <span className={`pst ${notConf ? 'nc' : 'none'}`}>{notConf ? 'NOT CONFIGURED' : 'NO CALLS LOGGED YET'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data?.configured && (
            <div className="configured micro">
              {Object.entries(data.configured).map(([k, v]) => (
                <span key={k} className={v ? 'ok' : 'nc'}>
                  {k.toUpperCase()}: {v ? 'CONFIGURED' : 'NOT CONFIGURED'}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
