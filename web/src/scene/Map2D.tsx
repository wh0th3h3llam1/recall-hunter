import { useMemo } from 'react';
import type { Listing } from '../api';
import { platformLabel } from '../hazard';
import { svgMapPaths } from './geo';
import { ellipse, layoutListings, RING } from './layout';
import type { HoverInfo } from './MapScene';

interface Props {
  listings: Listing[];
  selectedId: string | null;
  reduced: boolean;
  onHover: (h: HoverInfo | null) => void;
  onSelect: (l: Listing) => void;
}

function arcPath(t0: number, t1: number, n = 40) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const [x, z] = ellipse(t0 + ((t1 - t0) * i) / n);
    d += `${i ? 'L' : 'M'}${x.toFixed(2)},${z.toFixed(2)}`;
  }
  return d;
}

/** 2D survey fallback when WebGL is unavailable. Same projection + layout as the 3D scene. */
export default function Map2D({ listings, selectedId, reduced, onHover, onSelect }: Props) {
  const paths = useMemo(() => svgMapPaths(), []);
  const { placed, segments } = useMemo(() => layoutListings(listings), [listings]);
  // draw back-to-front so nearer (southern) pins overlap farther ones
  const ordered = useMemo(() => [...placed].sort((a, b) => a.z - b.z), [placed]);
  const K = 0.85; // height scale (world units -> svg units, upward)

  return (
    <div className="map2d">
      <svg viewBox="-74 -56 148 112" preserveAspectRatio="xMidYMid meet" role="img" aria-label="2D survey map of listings">
        <defs>
          <filter id="paperShadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow dx="1.2" dy="1.6" stdDeviation="0.9" floodColor="#000" floodOpacity="0.55" />
          </filter>
        </defs>
        {/* ONLINE ring */}
        <g className="m2-ring">
          {segments.map((s, i) => (
            <path key={s.platform} d={arcPath(s.t0, s.t1)} stroke={i % 2 ? '#CFC9BB' : '#E8E3D6'} strokeWidth={RING.width} fill="none" />
          ))}
          {segments.map((s) => {
            const [x, z] = ellipse((s.t0 + s.t1) / 2, -4.2);
            return (
              <text key={s.platform} x={x} y={z} className="m2-label" textAnchor="middle" dominantBaseline="middle">
                ONLINE · {platformLabel(s.platform).toUpperCase()} {String(s.count).padStart(2, '0')}
              </text>
            );
          })}
        </g>
        {/* paper map */}
        <g filter="url(#paperShadow)">
          {paths.states.map((d, i) => (
            <path key={i} d={d} fill="#E8E3D6" />
          ))}
        </g>
        <path d={paths.borders} fill="none" stroke="#3A3C3E" strokeOpacity={0.6} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        {/* pins */}
        {ordered.map((p) => {
          const kind = p.l.final ?? 'LIKELY';
          const h = p.h * K;
          const sel = p.l.listing_id === selectedId;
          const enter = (e: React.PointerEvent) => onHover({ l: p.l, x: e.clientX, y: e.clientY });
          return (
            <g
              key={p.l.listing_id}
              className={`m2-pin ${sel ? 'is-sel' : ''}`}
              transform={`translate(${p.x.toFixed(2)},${p.z.toFixed(2)})`}
              onPointerEnter={enter}
              onPointerMove={enter}
              onPointerLeave={() => onHover(null)}
              onClick={() => onSelect(p.l)}
              role="button"
              aria-label={`${kind} listing: ${p.l.title ?? p.l.listing_id}`}
            >
              {kind === 'CONFIRMED' && !reduced && <circle r={1} fill="none" stroke={p.color} strokeWidth={0.3} className="m2-pulse" />}
              <ellipse rx={0.9} ry={0.5} fill={kind === 'CONFIRMED' ? p.color : 'none'} stroke={p.color} strokeWidth={0.25} />
              <line x1={0} y1={0} x2={0} y2={-h} stroke={kind === 'REJECTED' ? '#6E6E6E' : p.color} strokeWidth={kind === 'CONFIRMED' ? 0.55 : 0.35} strokeDasharray={kind === 'LIKELY' ? '0.8 0.4' : undefined} />
              <rect
                x={-0.8}
                y={-h - 0.8}
                width={1.6}
                height={1.6}
                fill={kind === 'CONFIRMED' ? p.color : '#0E0F10'}
                stroke={kind === 'REJECTED' ? '#6E6E6E' : p.color}
                strokeWidth={0.3}
              />
              {/* generous hit area */}
              <rect x={-1.6} y={-h - 1.6} width={3.2} height={h + 2.6} fill="transparent" />
            </g>
          );
        })}
      </svg>
      <div className="m2-note micro">3D UNAVAILABLE IN THIS BROWSER (WEBGL OFF) · SHOWING 2D SURVEY</div>
    </div>
  );
}
