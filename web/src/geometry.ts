import * as THREE from 'three';
import { buildUtensilLocal, isUtensil, utensilLength, type UtensilKind } from './utensils';

export type RevolveKind = 'plate' | 'bowl' | 'mug';
export type DishKind = RevolveKind | UtensilKind;

interface Spec {
  /** Inner (soiled-side) profile as (r, y) from the axis outward. */
  profile: [number, number][];
  thickness: number;
  nPhi: number;
  /** Higher = harder to clean (baked-on). */
  adhesion: number;
  innerSoil: number;
  /** Food only lands on the inner (serving) surface, so this is 0 for every dish. */
  outerSoil: number;
  color: number;
}

export const SPECS: Record<RevolveKind, Spec> = {
  plate: {
    profile: [[0.5, 0.4], [7, 0.4], [9.5, 1.3], [12, 2.4], [13, 2.9]],
    thickness: 0.5,
    nPhi: 96,
    adhesion: 1.0,
    innerSoil: 1.0,
    outerSoil: 0,
    color: 0xf2efe6,
  },
  bowl: {
    profile: [[0.5, 0.5], [3, 0.6], [5.5, 1.6], [7.2, 3.6], [7.9, 6.5]],
    thickness: 0.5,
    nPhi: 64,
    adhesion: 1.5,
    innerSoil: 1.0,
    outerSoil: 0,
    color: 0xdfe8ee,
  },
  mug: {
    profile: [[0.5, 0.5], [3.4, 0.5], [3.9, 1.0], [4.0, 2.0], [4.0, 9.5]],
    thickness: 0.5,
    nPhi: 40,
    adhesion: 1.2,
    innerSoil: 1.0,
    outerSoil: 0,
    color: 0xe9d7c3,
  },
};

/** Approx horizontal radius, for placement bounds. */
export function dishRadius(kind: DishKind): number {
  if (isUtensil(kind)) return utensilLength(kind) / 2;
  return Math.max(...SPECS[kind].profile.map(([r]) => r));
}

export interface DishLocal {
  kind: DishKind;
  nVerts: number;
  nRings: number;
  nPhi: number;
  /** Cells wrap around across the width (dishes of revolution), or run edge to edge (utensils). */
  closed: boolean;
  /** Four surface neighbours per cell (local cell index, -1 if none). */
  nbr: Int32Array;
  /** Inner block first, then outer block. Local frame: origin at base centre, +y = open side. */
  pos: Float32Array;
  nrm: Float32Array;
  weight: Float32Array;
  /** Surface area of each cell, cm^2 (inner and outer faces both listed). */
  area: Float32Array;
  /** Area of one face, cm^2: with a wall thickness it gives the dish's volume and mass. */
  faceArea: number;
  adhesion: Float32Array;
  index: Uint32Array;
  color: number;
}

const RING_SPACING = 0.8;

const cache = new Map<DishKind, DishLocal>();

export function buildDishLocal(kind: DishKind): DishLocal {
  const hit = cache.get(kind);
  if (hit) return hit;
  if (isUtensil(kind)) {
    const u = buildUtensilLocal(kind);
    cache.set(kind, u);
    return u;
  }
  const spec = SPECS[kind];

  // Resample the profile to uniform arc-length rings.
  const src = spec.profile;
  const seg = src.slice(1).map((p, i) => Math.hypot(p[0] - src[i][0], p[1] - src[i][1]));
  const total = seg.reduce((a, b) => a + b, 0);
  const nRings = Math.ceil(total / RING_SPACING) + 1;
  const ds = total / (nRings - 1);
  const ring: [number, number][] = [];
  for (let i = 0; i < nRings; i++) {
    let s = i * ds;
    let k = 0;
    while (k < seg.length - 1 && s > seg[k]) {
      s -= seg[k];
      k++;
    }
    const f = Math.min(1, s / seg[k]);
    ring.push([src[k][0] + (src[k + 1][0] - src[k][0]) * f, src[k][1] + (src[k + 1][1] - src[k][1]) * f]);
  }

  // Inner-side normal in the (r, y) plane: (-dy, dr).
  const inN: [number, number][] = ring.map((_, i) => {
    const a = ring[Math.max(0, i - 1)];
    const b = ring[Math.min(nRings - 1, i + 1)];
    const tr = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tr, ty) || 1;
    return [-ty / len, tr / len];
  });

  const nPhi = spec.nPhi;
  const perSide = nRings * nPhi;
  const nVerts = perSide * 2;
  const pos = new Float32Array(nVerts * 3);
  const nrm = new Float32Array(nVerts * 3);
  const weight = new Float32Array(nVerts);
  const cellArea = new Float32Array(nVerts);
  let faceArea = 0;
  const adhesion = new Float32Array(nVerts).fill(spec.adhesion);

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let i = 0; i < nRings; i++) {
      // Outer surface is the inner one offset against the inner normal.
      const off = side === 1 ? spec.thickness : 0;
      const rr = Math.max(ring[i][0] - inN[i][0] * off, 0);
      const y = ring[i][1] - inN[i][1] * off;
      const area = ds * ((2 * Math.PI * Math.max(rr, 0.05)) / nPhi);
      const soil = side === 0 ? spec.innerSoil : spec.outerSoil;
      for (let j = 0; j < nPhi; j++) {
        const phi = (2 * Math.PI * j) / nPhi;
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        const v = side * perSide + i * nPhi + j;
        pos[3 * v] = rr * c;
        pos[3 * v + 1] = y;
        pos[3 * v + 2] = rr * s;
        nrm[3 * v] = sign * inN[i][0] * c;
        nrm[3 * v + 1] = sign * inN[i][1];
        nrm[3 * v + 2] = sign * inN[i][0] * s;
        weight[v] = area * soil;
        cellArea[v] = area;
        if (side === 0) faceArea += area;
      }
    }
  }

  const idx: number[] = [];
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < nRings - 1; i++) {
      for (let j = 0; j < nPhi; j++) {
        const j2 = (j + 1) % nPhi;
        const a = side * perSide + i * nPhi + j;
        const b = side * perSide + i * nPhi + j2;
        const c = side * perSide + (i + 1) * nPhi + j;
        const d = side * perSide + (i + 1) * nPhi + j2;
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  const nbr = new Int32Array(nVerts * 4).fill(-1);
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < nRings; i++) {
      for (let j = 0; j < nPhi; j++) {
        const v = side * perSide + i * nPhi + j;
        const at = (ii: number, jj: number) => side * perSide + ii * nPhi + ((jj + nPhi) % nPhi);
        nbr[4 * v] = at(i, j + 1);
        nbr[4 * v + 1] = at(i, j - 1);
        if (i > 0) nbr[4 * v + 2] = at(i - 1, j);
        if (i < nRings - 1) nbr[4 * v + 3] = at(i + 1, j);
      }
    }
  }

  const local: DishLocal = {
    kind,
    nVerts,
    nRings,
    nPhi,
    closed: true,
    nbr,
    pos,
    nrm,
    weight,
    area: cellArea,
    faceArea,
    adhesion,
    index: new Uint32Array(idx),
    color: spec.color,
  };
  cache.set(kind, local);
  return local;
}

export function buildDishGeometry(local: DishLocal): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(local.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(local.nrm, 3));
  const col = new Float32Array(local.nVerts * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(local.index, 1));
  return g;
}
