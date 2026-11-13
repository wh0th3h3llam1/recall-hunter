import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Listing } from '../api';
import { platformLabel } from '../hazard';
import { buildBorderGeometry, buildStateGeometries } from './geo';
import { ellipse, layoutListings, RING, type Placed, type Segment } from './layout';

export interface HoverInfo {
  l: Listing;
  x: number;
  y: number;
}

interface Props {
  listings: Listing[];
  selectedId: string | null;
  reduced: boolean;
  onHover: (h: HoverInfo | null) => void;
  onSelect: (l: Listing) => void;
}

const FOV = 36;
const TARGET = new THREE.Vector3(0, 0, 7);
const POLAR = 0.98;

/* ------------------------------------------------------------------ map */

const USMap = memo(function USMap() {
  const states = useMemo(() => buildStateGeometries(), []);
  const borders = useMemo(() => buildBorderGeometry(), []);
  const paper = useMemo(() => new THREE.MeshStandardMaterial({ color: '#E8E3D6', roughness: 0.93, metalness: 0 }), []);
  return (
    <group>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        {states.map((g, i) => (
          <mesh key={i} geometry={g} material={paper} castShadow receiveShadow />
        ))}
      </group>
      <lineSegments geometry={borders}>
        <lineBasicMaterial color="#3A3C3E" transparent opacity={0.6} />
      </lineSegments>
    </group>
  );
});

function Table() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <shadowMaterial transparent opacity={0.42} />
      </mesh>
      <gridHelper args={[180, 36, '#25282B', '#191B1D']} position={[0, -0.02, 0]} />
    </group>
  );
}

/* ---------------------------------------------------------- online ring */

function arcStrip(t0: number, t1: number, w: number, n = 48): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const [ix, iz] = ellipse(t, -w / 2);
    const [ox, oz] = ellipse(t, w / 2);
    pos.push(ix, 0, iz, ox, 0, oz);
    if (i < n) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ringTicks(): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < 144; i++) {
    const t = (i / 144) * Math.PI * 2;
    const major = i % 12 === 0;
    const [ax, az] = ellipse(t, RING.width / 2 + 0.2);
    const [bx, bz] = ellipse(t, RING.width / 2 + (major ? 1.6 : 0.7));
    pts.push(ax, 0, az, bx, 0, bz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

const OnlineRing = memo(function OnlineRing({ segments }: { segments: Segment[] }) {
  const geos = useMemo(() => segments.map((s) => arcStrip(s.t0, s.t1, RING.width)), [segments]);
  const ticks = useMemo(() => ringTicks(), []);
  return (
    <group position={[0, RING.y, 0]}>
      {geos.map((g, i) => (
        <mesh key={segments[i].platform} geometry={g} castShadow receiveShadow>
          <meshStandardMaterial color={i % 2 ? '#CFC9BB' : '#E8E3D6'} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <lineSegments geometry={ticks}>
        <lineBasicMaterial color="#6B6A64" transparent opacity={0.55} />
      </lineSegments>
      {segments.map((s) => {
        const tm = (s.t0 + s.t1) / 2;
        const [x, z] = ellipse(tm, 0);
        return (
          <Html key={s.platform} position={[x, 3.2, z]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
            <div className="ring-label">
              <span className="ring-label-k">ONLINE</span>
              <span>{platformLabel(s.platform).toUpperCase()}</span>
              <span className="ring-label-n">{String(s.count).padStart(2, '0')}</span>
            </div>
          </Html>
        );
      })}
    </group>
  );
});

/* -------------------------------------------------------------- pillars */

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface PillarProps {
  p: Placed;
  born: number;
  reduced: boolean;
  selected: boolean;
  onHover: Props['onHover'];
  onSelect: Props['onSelect'];
}

function Pillar({ p, born, reduced, selected, onHover, onSelect }: PillarProps) {
  const grp = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const hovered = useRef(false);
  const kind = p.l.final ?? 'LIKELY';
  const w = 0.75;
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, p.h, w)), [p.h]);
  const phase = useMemo(() => Math.random() * 3, []);

  useFrame((state) => {
    const now = performance.now();
    const g = Math.max(0.001, reduced ? 1 : easeOut(THREE.MathUtils.clamp((now - born) / 900, 0, 1)));
    if (body.current) body.current.scale.y = g;
    if (grp.current) {
      const goal = hovered.current || selected ? 0.9 : 0;
      const y = grp.current.position.y;
      grp.current.position.y = reduced ? goal : y + (goal - y) * 0.18;
    }
    if (pulse.current) {
      const mat = pulse.current.material as THREE.MeshBasicMaterial;
      if (reduced) {
        pulse.current.scale.setScalar(1.6);
        mat.opacity = 0.5;
      } else {
        const t = ((state.clock.elapsedTime + phase) % 2.6) / 2.6;
        pulse.current.scale.setScalar(1 + t * 3.2);
        mat.opacity = 0.75 * (1 - t) * g;
      }
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hovered.current = true;
    document.body.style.cursor = 'pointer';
    onHover({ l: p.l, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover({ l: p.l, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const out = () => {
    hovered.current = false;
    document.body.style.cursor = '';
    onHover(null);
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(p.l);
  };

  return (
    <group position={[p.x, p.y, p.z]}>
      {kind === 'CONFIRMED' && (
        <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.8, 1.0, 40]} />
          <meshBasicMaterial color={p.color} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      )}
      <group ref={grp}>
        <group ref={body}>
          {kind === 'CONFIRMED' && (
            <>
              <mesh position={[0, p.h / 2, 0]} castShadow>
                <boxGeometry args={[w, p.h, w]} />
                <meshStandardMaterial color={p.color} emissive={p.color} emissiveIntensity={selected ? 0.6 : 0.22} roughness={0.55} />
              </mesh>
              <mesh position={[0, p.h, 0]} castShadow>
                <boxGeometry args={[1.4, 0.22, 1.4]} />
                <meshStandardMaterial color={p.color} emissive={p.color} emissiveIntensity={0.3} roughness={0.5} />
              </mesh>
            </>
          )}
          {kind === 'LIKELY' && (
            <>
              <lineSegments geometry={edges} position={[0, p.h / 2, 0]}>
                <lineBasicMaterial color={p.color} />
              </lineSegments>
              <mesh position={[0, p.h / 2, 0]}>
                <boxGeometry args={[w, p.h, w]} />
                <meshBasicMaterial color={p.color} transparent opacity={selected ? 0.45 : 0.14} depthWrite={false} />
              </mesh>
            </>
          )}
          {kind === 'REJECTED' && (
            <mesh position={[0, p.h / 2, 0]}>
              <boxGeometry args={[0.16, p.h, 0.16]} />
              <meshBasicMaterial color="#6E6E6E" transparent opacity={0.55} />
            </mesh>
          )}
          {/* generous invisible hit target */}
          <mesh position={[0, p.h / 2, 0]} onPointerOver={over} onPointerMove={move} onPointerOut={out} onClick={click}>
            <cylinderGeometry args={[1.25, 1.25, p.h + 1.5, 10]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** Used above 200 pillars: one draw call, same hover/select behaviour, no outlines/pulses. */
function InstancedPillars({ items, borns, reduced, onHover, onSelect }: { items: Placed[]; borns: Map<string, number>; reduced: boolean } & Pick<Props, 'onHover' | 'onSelect'>) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(0.75, 1, 0.75);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    const graphite = new THREE.Color('#2A2C2E');
    items.forEach((p, i) => {
      c.set(p.color);
      if (p.l.final === 'LIKELY') c.lerp(graphite, 0.55);
      if (p.l.final === 'REJECTED') c.set('#6E6E6E');
      m.setColorAt(i, c);
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [items]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const now = performance.now();
    items.forEach((p, i) => {
      const g = reduced ? 1 : easeOut(THREE.MathUtils.clamp((now - (borns.get(p.l.listing_id) ?? 0)) / 900, 0, 1));
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(1, Math.max(0.001, p.h * g), 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={ref}
      args={[geo, undefined, items.length]}
      castShadow
      onPointerMove={(e) => {
        e.stopPropagation();
        const p = e.instanceId != null ? items[e.instanceId] : null;
        document.body.style.cursor = p ? 'pointer' : '';
        onHover(p ? { l: p.l, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } : null);
      }}
      onPointerOut={() => {
        document.body.style.cursor = '';
        onHover(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        const p = e.instanceId != null ? items[e.instanceId] : null;
        if (p) onSelect(p.l);
      }}
    >
      <meshStandardMaterial roughness={0.6} />
    </instancedMesh>
  );
}

/* --------------------------------------------------------------- camera */

function fitDistance(aspect: number) {
  const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const byW = 86 / (t * Math.max(0.3, aspect));
  const byH = 38 / t;
  return Math.max(byW, byH);
}

function camPos(dist: number, polar: number, out = new THREE.Vector3()) {
  return out.set(TARGET.x, TARGET.y + dist * Math.cos(polar), TARGET.z + dist * Math.sin(polar));
}

function CameraRig({ reduced, focus }: { reduced: boolean; focus: THREE.Vector3 | null }) {
  const { camera, size, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; size: { width: number; height: number }; controls: OrbitControlsImpl | null };
  const intro = useRef({ t0: -1, done: reduced });
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const aspect = size.height > 0 ? size.width / size.height : 1.2;
  const dist = useMemo(() => fitDistance(aspect), [Math.round(aspect * 50)]); // eslint-disable-line react-hooks/exhaustive-deps
  // when the canvas size settles or changes after the intro, snap back to the rest framing
  const lastDist = useRef(dist);
  useEffect(() => {
    if (!controls || Math.abs(lastDist.current - dist) < 0.5) return;
    lastDist.current = dist;
    if (!intro.current.done || goal.current) return;
    camPos(dist, POLAR, camera.position);
    controls.target.copy(TARGET);
    controls.update();
  }, [dist]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!controls) return;
    controls.minDistance = dist * 0.32;
    controls.maxDistance = dist * 1.35;
    if (reduced) {
      camPos(dist, POLAR, camera.position);
      controls.target.copy(TARGET);
      controls.update();
    }
    const cancel = () => (goal.current = null);
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls, dist, reduced, camera]);

  useEffect(() => {
    if (!focus || !controls) return;
    const dir = camera.position.clone().sub(controls.target).normalize();
    const target = focus.clone();
    const pos = target.clone().add(dir.multiplyScalar(dist * 0.62));
    if (reduced) {
      camera.position.copy(pos);
      controls.target.copy(target);
      controls.update();
    } else goal.current = { pos, target };
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state) => {
    if (!controls) return;
    const it = intro.current;
    if (!it.done) {
      if (it.t0 < 0) it.t0 = state.clock.elapsedTime;
      const k = THREE.MathUtils.clamp((state.clock.elapsedTime - it.t0) / 2.6, 0, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const d = THREE.MathUtils.lerp(dist * 1.75, dist, e);
      const pol = THREE.MathUtils.lerp(0.22, POLAR, e);
      camPos(d, pol, camera.position);
      controls.enabled = false;
      controls.target.copy(TARGET);
      controls.update();
      if (k >= 1) {
        it.done = true;
        controls.enabled = true;
      }
      return;
    }
    const g = goal.current;
    if (g) {
      camera.position.lerp(g.pos, 0.06);
      controls.target.lerp(g.target, 0.08);
      controls.update();
      if (camera.position.distanceTo(g.pos) < 0.2) goal.current = null;
    }
  });
  return null;
}

/* ---------------------------------------------------------------- scene */

function Scene({ listings, selectedId, reduced, onHover, onSelect }: Props) {
  const { placed, segments } = useMemo(() => layoutListings(listings), [listings]);
  const borns = useRef(new Map<string, number>());
  // assign staggered birth times to pillars we have not seen yet
  const now = performance.now();
  const mounted = useRef(performance.now());
  let k = 0;
  const start = Math.max(now, mounted.current + 2300); // let the opening dolly land first
  for (const p of placed) {
    if (!borns.current.has(p.l.listing_id)) borns.current.set(p.l.listing_id, reduced ? 0 : start + k++ * 70);
  }
  const sel = placed.find((p) => p.l.listing_id === selectedId) ?? null;
  const focus = useMemo(() => (sel ? new THREE.Vector3(sel.x, sel.y + sel.h * 0.3, sel.z + 16) : null), [sel?.l.listing_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ambientLight intensity={0.95} color="#F4EFE4" />
      <hemisphereLight args={['#FFF8EA', '#0E0F10', 0.35]} />
      <directionalLight
        position={[-95, 38, -30]}
        intensity={2.7}
        color="#FFF3DD"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[60, 50, 80]} intensity={0.35} color="#C9D3DD" />
      <Table />
      <USMap />
      <OnlineRing segments={segments} />
      {placed.length > 200 ? (
        <InstancedPillars items={placed} borns={borns.current} reduced={reduced} onHover={onHover} onSelect={onSelect} />
      ) : (
        placed.map((p) => (
          <Pillar key={p.l.listing_id} p={p} born={borns.current.get(p.l.listing_id) ?? 0} reduced={reduced} selected={p.l.listing_id === selectedId} onHover={onHover} onSelect={onSelect} />
        ))
      )}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.25}
        maxPolarAngle={1.18}
        minAzimuthAngle={-0.75}
        maxAzimuthAngle={0.75}
        rotateSpeed={0.5}
        zoomSpeed={0.7}
      />
      <CameraRig reduced={reduced} focus={focus} />
    </>
  );
}

export default function MapScene(props: Props) {
  return (
    <Canvas
      className="map-canvas"
      shadows
      flat
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ fov: FOV, near: 1, far: 2000, position: [0, 600, 40] }}
      onPointerMissed={() => props.onHover(null)}
    >
      <Scene {...props} />
    </Canvas>
  );
}
