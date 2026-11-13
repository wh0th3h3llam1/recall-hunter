import { useEffect, useRef, useState } from 'react';

/** Number that counts up/down to its value. Instant when reduced motion. */
export function Num({ value, reduced, format }: { value: number | null | undefined; reduced: boolean; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value == null) return;
    if (reduced || document.hidden) {
      setShown(value);
      from.current = value;
      return;
    }
    const a = from.current;
    const b = value;
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (b - a) * e;
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // rAF is paused in background tabs; guarantee the final value lands anyway
    const settle = setTimeout(() => {
      cancelAnimationFrame(raf);
      setShown(b);
      from.current = b;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [value, reduced]);
  if (value == null) return <>—</>;
  const r = Math.round(shown);
  return <>{format ? format(r) : r.toLocaleString('en-US')}</>;
}
