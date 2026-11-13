import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import type { Seller } from '../b2b';
import GLBoundary from '../components/GLBoundary';
import { hazardColor } from '../hazard';
import { markWebGLBroken } from '../webgl';

export interface CNode {
  id: string;
  kind: 'seller' | 'recall';
  x: number;
  y: number;
  r: number;
  color: string;
  label: string;
  seller?: Seller;
  repeat?: boolean;
}
export interface CEdge {
  s: string;
  r: string;
  w: number;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function dominantHazard(s: Seller): string | null {
  let best: { h: string | null; c: number } = { h: null, c: -1 };
  for (const r of s.recalls ?? []) if (r.count > best.c) best = { h: r.hazard_class, c: r.count };
  return best.h;
}

export const sellerKey = (s: Seller) => `s:${s.seller_id}`;

/** Deterministic layout: recalls on an inner ring, sellers pulled toward their recalls, then relaxed. */
export function layoutConstellation(sellers: Seller[], recallNumber: (id: number) => string) {
  const recallIds = [...new Set(sellers.flatMap((s) => (s.recalls ?? []).map((r) => r.recall_id)))];
  const recallHaz = new Map<number, string | null>();
  sellers.forEach((s) => (s.recalls ?? []).forEach((r) => recallHaz.set(r.recall_id, r.hazard_class)));
  const nodes: CNode[] = [];
  const R = recallIds.length > 1 ? 9 + recallIds.length * 1.2 : 0;
  recallIds.forEach((id, i) => {
    const a = (i / Math.max(1, recallIds.length)) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ id: `r:${id}`, kind: 'recall', x: Math.cos(a) * R, y: Math.sin(a) * R, r: 1.6, color: hazardColor(recallHaz.get(id)), label: recallNumber(id) });
  });
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const edges: CEdge[] = [];
  for (const s of sellers) {
    const rs = s.recalls ?? [];
    let x = 0,
      y = 0;
    rs.forEach((r) => {
      const p = pos.get(`r:${r.recall_id}`);
      if (p) {
        x += p.x;
        y += p.y;
      }
      edges.push({ s: sellerKey(s), r: `r:${r.recall_id}`, w: r.count });
    });
    if (rs.length) {
      x /= rs.length;
      y /= rs.length;
    }
    const a = hash(String(s.seller_id)) * Math.PI * 2;
    const d = 5 + hash(String(s.seller_id) + 'd') * 7;
    const weight = (s.confirmed_count ?? 0) + (s.likely_count ?? 0);
    nodes.push({
      id: sellerKey(s),
      kind: 'seller',
      x: x + Math.cos(a) * d,
      y: y + Math.sin(a) * d,
      r: 0.55 + Math.sqrt(Math.max(1, weight)) * 0.32,
      color: hazardColor(dominantHazard(s)),
      label: s.name || String(s.seller_id),
      seller: s,
      repeat: rs.length >= 2 || (s.confirmed_count ?? 0) >= 3,
    });
  }
  // relax: pairwise repulsion between sellers, weak spring toward origin
  const ss = nodes.filter((n) => n.kind === 'seller');
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i],
          b = nodes[j];
        if (a.kind === 'recall' && b.kind === 'recall') continue;
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const min = a.r + b.r + 1.2;
        if (dist < min) {
          const push = (min - dist) / 2;
          const ux = dx / dist,
            uy = dy / dist;
          if (a.kind === 'seller') {
            a.x -= ux * push;
            a.y -= uy * push;
          }
          if (b.kind === 'seller') {
            b.x += ux * push;
            b.y += uy * push;
          }
        }
      }
  }
  // recentre on the bounding box so the camera frames the whole cluster
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  nodes.forEach((n) => {
    x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r);
    y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r);
  });
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  nodes.forEach((n) => { n.x -= cx; n.y -= cy; });
  let ext = 1;
  nodes.forEach((n) => (ext = Math.max(ext, Math.abs(n.x) + n.r, Math.abs(n.y) + n.r)));
  void ss;
  return { nodes, edges, ext };
}

interface Props {
  sellers: Seller[];
  recallNumber: (id: number) => string;
  hovered: string | null;
  selected: string | null;
  onHover: (key: string | null) => void;
  onSelect: (s: Seller) => void;
  webgl: boolean;
  reduced: boolean;
  onGLFail: () => void;
}

export default function Constellation(p: Props) {
  const lay = useMemo(() => layoutConstellation(p.sellers, p.recallNumber), [p.sellers, p.recallNumber]);
  const focus = p.hovered ?? p.selected;
  const linked = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    lay.edges.forEach((e) => {
      if (e.s === focus || e.r === focus) {
        set.add(e.s);
        set.add(e.r);
      }
    });
    return set;
  }, [focus, lay]);
  if (!p.sellers.length) return null;
  const fallback = <Constellation2D {...p} lay={lay} linked={linked} />;
  if (!p.webgl) return fallback;
  return (
    <GLBoundary
      fallback={fallback}
      onError={() => {
        markWebGLBroken();
        p.onGLFail();
      }}
    >
      <Canvas className="const-canvas" flat dpr={[1, 2]} gl={{ antialias: true, alpha: true }} camera={{ fov: 40, position: [0, -lay.ext * 1.25, lay.ext * 2.75], near: 0.5, far: 2000 }}>
        <Constellation3D {...p} lay={lay} linked={linked} />
      </Canvas>
    </GLBoundary>
  );
}

type Inner = Props & { lay: ReturnType<typeof layoutConstellation>; linked: Set<string> | null };

function Constellation3D({ lay, linked, onHover, onSelect, reduced, selected }: Inner) {
  const byId = useMemo(() => new Map(lay.nodes.map((n) => [n.id, n])), [lay]);
  const edgeGeo = useMemo(() => {
    const mk = (on: boolean) => {
      const pts: number[] = [];
      lay.edges.forEach((e) => {
        const a = byId.get(e.s),
          b = byId.get(e.r);
        if (!a || !b) return;
        const hit = !!linked && linked.has(e.s) && linked.has(e.r);
        if (hit !== on) return;
        pts.push(a.x, a.y, 0, b.x, b.y, 0);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return g;
    };
    return { dim: mk(false), hot: mk(true) };
  }, [lay, linked, byId]);
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[-30, -20, 40]} intensity={1.6} />
      <lineSegments geometry={edgeGeo.dim}>
        <lineBasicMaterial color="#6B6A64" transparent opacity={linked ? 0.15 : 0.45} />
      </lineSegments>
      <lineSegments geometry={edgeGeo.hot}>
        <lineBasicMaterial color="#E8E3D6" />
      </lineSegments>
      {lay.nodes.map((n) => {
        const dim = linked && !linked.has(n.id);
        if (n.kind === 'recall')
          return (
            <group key={n.id} position={[n.x, n.y, 0]}>
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[n.r, n.r, 0.35, 40]} />
                <meshStandardMaterial color="#E8E3D6" roughness={0.9} transparent opacity={dim ? 0.35 : 1} />
              </mesh>
              <mesh position={[0, 0, 0.19]}>
                <ringGeometry args={[n.r * 0.72, n.r * 0.86, 40]} />
                <meshBasicMaterial color={n.color} transparent opacity={dim ? 0.3 : 1} />
              </mesh>
              <Html position={[0, -n.r - 1.1, 0]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
                <div className={`const-rlabel ${dim ? 'dim' : ''}`}>{n.label}</div>
              </Html>
            </group>
          );
        const sel = selected === n.id;
        return (
          <group key={n.id} position={[n.x, n.y, 0]}>
            <mesh
              onPointerOver={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
                onHover(n.id);
              }}
              onPointerOut={() => {
                document.body.style.cursor = '';
                onHover(null);
              }}
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                if (n.seller) onSelect(n.seller);
              }}
            >
              <sphereGeometry args={[n.r, 28, 20]} />
              <meshStandardMaterial color={n.color} emissive={n.color} emissiveIntensity={n.repeat ? 0.55 : 0.15} roughness={0.5} transparent opacity={dim ? 0.25 : 1} />
            </mesh>
            {(n.repeat || sel) && (
              <mesh>
                <ringGeometry args={[n.r * 1.35, n.r * 1.5, 40]} />
                <meshBasicMaterial color={sel ? '#FFFFFF' : n.color} transparent opacity={dim ? 0.15 : 0.7} />
              </mesh>
            )}
          </group>
        );
      })}
      <OrbitControls enablePan={false} autoRotate={!reduced && !linked} autoRotateSpeed={0.4} minPolarAngle={0.2} maxPolarAngle={Math.PI - 0.2} />
    </>
  );
}

function Constellation2D({ lay, linked, onHover, onSelect, selected }: Inner) {
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  const e = lay.ext + 3;
  return (
    <svg className="const-svg" viewBox={`${-e} ${-e} ${e * 2} ${e * 2}`} preserveAspectRatio="xMidYMid meet">
      {lay.edges.map((ed, i) => {
        const a = byId.get(ed.s),
          b = byId.get(ed.r);
        if (!a || !b) return null;
        const hot = !!linked && linked.has(ed.s) && linked.has(ed.r);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? '#E8E3D6' : '#6B6A64'} strokeOpacity={hot ? 1 : linked ? 0.15 : 0.45} strokeWidth={0.15} />;
      })}
      {lay.nodes.map((n) => {
        const dim = linked && !linked.has(n.id);
        if (n.kind === 'recall')
          return (
            <g key={n.id} opacity={dim ? 0.35 : 1}>
              <circle cx={n.x} cy={n.y} r={n.r} fill="#E8E3D6" />
              <circle cx={n.x} cy={n.y} r={n.r * 0.78} fill="none" stroke={n.color} strokeWidth={0.25} />
              <text x={n.x} y={n.y + n.r + 1.4} className="const-svg-label" textAnchor="middle">
                {n.label}
              </text>
            </g>
          );
        return (
          <g
            key={n.id}
            opacity={dim ? 0.25 : 1}
            style={{ cursor: 'pointer' }}
            onPointerEnter={() => onHover(n.id)}
            onPointerLeave={() => onHover(null)}
            onClick={() => n.seller && onSelect(n.seller)}
          >
            {(n.repeat || selected === n.id) && <circle cx={n.x} cy={n.y} r={n.r * 1.45} fill="none" stroke={selected === n.id ? '#fff' : n.color} strokeWidth={0.2} />}
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} />
          </g>
        );
      })}
    </svg>
  );
}
