import { useCallback, useEffect, useRef, useState } from 'react';

export interface HuntEvent {
  type: string;
  ts: number | string;
  data: Record<string, any>;
}

export interface LiveCounts {
  candidates: number;
  screened: number;
  vision: number;
  escalated: number;
  confirmed: number;
  likely: number;
  rejected: number;
}

export type HuntStatus = 'idle' | 'starting' | 'running' | 'done' | 'error';

const ZERO: LiveCounts = { candidates: 0, screened: 0, vision: 0, escalated: 0, confirmed: 0, likely: 0, rejected: 0 };
const TYPES = ['start', 'query', 'source_done', 'candidate', 'screened', 'vision', 'escalated', 'verdict', 'evidence', 'done', 'error'];

export function useHunt(onDone: (recallId: number | null) => void) {
  const [runId, setRunId] = useState<string | null>(null);
  const [recallId, setRecallId] = useState<number | null>(null);
  const [status, setStatus] = useState<HuntStatus>('idle');
  const [events, setEvents] = useState<HuntEvent[]>([]);
  const [live, setLive] = useState<LiveCounts>(ZERO);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const recallRef = useRef<number | null>(null);

  const close = () => {
    esRef.current?.close();
    esRef.current = null;
  };

  useEffect(() => close, []);

  const handle = useCallback((ev: HuntEvent) => {
    setEvents((xs) => (xs.length > 600 ? [...xs.slice(-500), ev] : [...xs, ev]));
    const d = ev.data || {};
    setLive((c) => {
      const n = { ...c };
      switch (ev.type) {
        case 'candidate':
          n.candidates += 1;
          break;
        case 'screened':
          n.screened += Number(d.batch ?? d.screened ?? d.count ?? 0) || 0;
          break;
        case 'vision':
          n.vision += 1;
          break;
        case 'escalated':
          n.escalated += 1;
          break;
        case 'verdict':
          if (d.final === 'CONFIRMED') n.confirmed += 1;
          else if (d.final === 'LIKELY') n.likely += 1;
          else if (d.final === 'REJECTED') n.rejected += 1;
          break;
      }
      return n;
    });
    if (ev.type === 'done') {
      setStatus('done');
      close();
      doneRef.current(recallRef.current);
    } else if (ev.type === 'error') {
      setStatus('error');
      setError(String(d.message ?? 'hunt failed'));
      close();
      doneRef.current(recallRef.current);
    } else {
      setStatus('running');
    }
  }, []);

  const start = useCallback(
    (rid: string, recall: number) => {
      close();
      recallRef.current = recall;
      setRunId(rid);
      setRecallId(recall);
      setEvents([]);
      setLive(ZERO);
      setError(null);
      setStatus('running');
      const es = new EventSource(`/api/hunt/${encodeURIComponent(rid)}/events`);
      esRef.current = es;
      const parse = (m: MessageEvent, fallbackType: string) => {
        try {
          const j = JSON.parse(m.data);
          handle({ type: j.type ?? fallbackType, ts: j.ts ?? Date.now() / 1000, data: j.data ?? {} });
        } catch {
          handle({ type: fallbackType, ts: Date.now() / 1000, data: { raw: String(m.data).slice(0, 200) } });
        }
      };
      es.onmessage = (m) => parse(m, 'message');
      for (const t of TYPES) es.addEventListener(t, (m) => parse(m as MessageEvent, t));
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setStatus((s) => (s === 'done' ? s : 'error'));
          setError((e) => e ?? 'Event stream closed by server.');
        }
      };
    },
    [handle],
  );

  const fail = useCallback((recall: number, msg: string) => {
    close();
    setRecallId(recall);
    setRunId(null);
    setStatus('error');
    setError(msg);
    setEvents([{ type: 'error', ts: Date.now() / 1000, data: { message: msg } }]);
  }, []);

  const begin = useCallback((recall: number) => {
    setRecallId(recall);
    setStatus('starting');
  }, []);

  return { runId, recallId, status, events, live, error, start, fail, begin };
}
