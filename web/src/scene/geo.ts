import * as THREE from 'three';
import { geoAlbersUsa, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import us from 'us-atlas/states-10m.json';

export const MAP_DEPTH = 1.1;
export const HALF_W = 50;
export const HALF_H = 31;

export const topo = us as unknown as Topology<{ states: GeometryCollection; nation: GeometryCollection }>;
export const statesFC = feature(topo, topo.objects.states) as unknown as GeoJSON.FeatureCollection;

export const projection = geoAlbersUsa().fitExtent(
  [
    [-HALF_W, -HALF_H],
    [HALF_W, HALF_H],
  ],
  statesFC as GeoPermissibleObjects,
);

/** lon/lat -> world XZ on the map plane (x east, z south). Null if outside AlbersUSA. */
export function lonLatToWorld(lon: number, lat: number): [number, number] | null {
  const p = projection([lon, lat]);
  return p ? [p[0], p[1]] : null;
}

function shapePathFor(obj: GeoPermissibleObjects) {
  const sp = new THREE.ShapePath();
  const ctx = {
    beginPath() {},
    moveTo(x: number, y: number) {
      sp.moveTo(x, -y);
    },
    lineTo(x: number, y: number) {
      sp.lineTo(x, -y);
    },
    closePath() {},
    arc() {},
  };
  geoPath(projection, ctx as unknown as CanvasRenderingContext2D)(obj);
  return sp;
}

/** One extruded geometry per state (paper diorama blocks). Shape lies in XY; caller rotates -90deg about X. */
export function buildStateGeometries(): THREE.ExtrudeGeometry[] {
  const out: THREE.ExtrudeGeometry[] = [];
  for (const f of statesFC.features) {
    const shapes = shapePathFor(f as GeoPermissibleObjects).toShapes(true);
    if (!shapes.length) continue;
    const g = new THREE.ExtrudeGeometry(shapes, { depth: MAP_DEPTH, bevelEnabled: false, curveSegments: 1 });
    out.push(g);
  }
  return out;
}

/** Hairline borders as line segments, already in world XZ at the top surface height. */
export function buildBorderGeometry(): THREE.BufferGeometry {
  const m = mesh(topo, topo.objects.states as any);
  const pts: number[] = [];
  let last: [number, number] | null = null;
  const y = MAP_DEPTH + 0.015;
  const ctx = {
    beginPath() {},
    moveTo(x: number, z: number) {
      last = [x, z];
    },
    lineTo(x: number, z: number) {
      if (last) pts.push(last[0], y, last[1], x, y, z);
      last = [x, z];
    },
    closePath() {},
    arc() {},
  };
  geoPath(projection, ctx as unknown as CanvasRenderingContext2D)(m as GeoPermissibleObjects);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** SVG path strings for the 2D fallback (same projection, so coordinates match the 3D layout). */
export function svgMapPaths(): { states: string[]; borders: string } {
  const path = geoPath(projection);
  const states = statesFC.features.map((f) => path(f as GeoPermissibleObjects) ?? '').filter(Boolean);
  const borders = path(mesh(topo, topo.objects.states as any) as GeoPermissibleObjects) ?? '';
  return { states, borders };
}
