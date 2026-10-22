import type { DishLocal } from './geometry';

export type UtensilKind = 'fork' | 'spoon' | 'knife';
export const UTENSIL_KINDS: UtensilKind[] = ['fork', 'spoon', 'knife'];
export const isUtensil = (k: string): k is UtensilKind => (UTENSIL_KINDS as string[]).includes(k);

/**
 * Utensils are thin ribbons: a grid of cells along the length (u) and across the width (v), on a top and a
 * bottom face. Local frame: length along x (head toward +x), width along z, faces toward +/-y, origin at the
 * middle of the length. A fork's gaps between tines are real holes: the tine columns come in pairs and the
 * quads between pairs are simply left out of the mesh.
 */
interface Shape {
  length: number;
  nU: number;
  nV: number;
  /** Full width at u (cm). */
  width(u: number): number;
  /** Half thickness at u (cm). */
  half(u: number): number;
  /** How far the surface dips below the rim at the centreline (spoon bowl). */
  cup(u: number): number;
  tines?: { count: number; gapStart: number; gapEnd: number };
  adhesion: number;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Rounds off the end of a handle over its first `r` of u. */
const roundEnd = (u: number, r: number) => (u < r ? Math.sqrt(Math.max(0, 1 - ((r - u) / r) ** 2)) : 1);

const SHAPES: Record<UtensilKind, Shape> = {
  fork: {
    length: 19.5,
    nU: 40,
    nV: 8,
    width: (u) =>
      u < 0.62
        ? lerp(1.5, 0.9, smooth(u / 0.62)) * roundEnd(u, 0.05)
        : u < 0.76
          ? lerp(0.9, 2.8, smooth((u - 0.62) / 0.14))
          : 2.8,
    half: (u) => (u < 0.62 ? 0.15 : 0.12),
    cup: () => 0,
    tines: { count: 4, gapStart: 0.7, gapEnd: 0.8 },
    adhesion: 1.3,
  },
  spoon: {
    length: 18.5,
    nU: 38,
    nV: 9,
    width: (u) => {
      const handle = lerp(1.6, 0.9, smooth(u / 0.6)) * roundEnd(u, 0.05);
      const uc = 0.83, a = 0.17;
      const bowl = 3.4 * Math.sqrt(Math.max(0, 1 - ((u - uc) / a) ** 2));
      return u < 0.6 ? handle : Math.max(u < uc + a ? 0.9 : 0, bowl);
    },
    half: () => 0.12,
    cup: (u) => {
      const uc = 0.83, a = 0.17;
      return u > 0.66 ? 0.9 * Math.max(0, 1 - ((u - uc) / a) ** 2) : 0;
    },
    adhesion: 1.0,
  },
  knife: {
    length: 22,
    nU: 46,
    nV: 7,
    width: (u) => (u < 0.5 ? 1.5 * roundEnd(u, 0.04) : u < 0.8 ? 1.9 : 1.9 * Math.sqrt(Math.max(0, 1 - ((u - 0.8) / 0.2) ** 2))),
    half: (u) => lerp(0.45, 0.05, smooth((u - 0.5) / 0.05)),
    cup: () => 0,
    adhesion: 0.9,
  },
};

export function buildUtensilLocal(kind: UtensilKind): DishLocal {
  const sh = SHAPES[kind];
  const nU = sh.nU, nV = sh.nV;
  const perSide = nU * nV;
  const nVerts = perSide * 2;
  const us = Array.from({ length: nU }, (_, i) => i / (nU - 1));

  /** Is the strip between column j and j+1 at row i connected (solid), or a gap between tines? */
  const connected = (i: number, j: number) => !sh.tines || j % 2 === 0 || us[i] < sh.tines.gapStart;

  /** Across-width coordinate of column j at row i, in [-1, 1]. */
  const vAt = (i: number, j: number) => {
    const even = -1 + (2 * j) / (nV - 1);
    if (!sh.tines) return even;
    const { count, gapStart, gapEnd } = sh.tines;
    const strip = 2 / (count + 0.55 * (count - 1));
    const k = j >> 1;
    const tine = -1 + k * strip * 1.55 + (j & 1) * strip;
    return lerp(even, tine, smooth((us[i] - gapStart) / (gapEnd - gapStart)));
  };

  const pos = new Float32Array(nVerts * 3);
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let i = 0; i < nU; i++) {
      const u = us[i];
      for (let j = 0; j < nV; j++) {
        const v = vAt(i, j);
        const c = (side * nU + i) * nV + j;
        pos[3 * c] = (u - 0.5) * sh.length;
        pos[3 * c + 1] = sign * sh.half(u) - sh.cup(u) * (1 - v * v);
        pos[3 * c + 2] = (v * sh.width(u)) / 2;
      }
    }
  }

  const at = (side: number, i: number, j: number) => (side * nU + i) * nV + j;
  const P = (c: number): [number, number, number] => [pos[3 * c], pos[3 * c + 1], pos[3 * c + 2]];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

  const nrm = new Float32Array(nVerts * 3);
  const area = new Float32Array(nVerts);
  const weight = new Float32Array(nVerts);
  let faceArea = 0;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const c = at(side, i, j);
        // Steps along the length and across the width, one-sided at edges and across gaps.
        const i0 = Math.max(0, i - 1), i1 = Math.min(nU - 1, i + 1);
        const j0 = j > 0 && connected(i, j - 1) ? j - 1 : j;
        const j1 = j < nV - 1 && connected(i, j) ? j + 1 : j;
        const du = sub(P(at(side, i1, j)), P(at(side, i0, j))).map((x) => x / Math.max(1, i1 - i0));
        const dv = sub(P(at(side, i, j1)), P(at(side, i, j0))).map((x) => x / Math.max(1, j1 - j0));
        const n = cross(dv, du);
        const l = len(n);
        // Face normal: out of the face, so toward +y on the top face and -y on the bottom.
        let nx = 0, ny = sign, nz = 0;
        if (l > 1e-8) {
          nx = n[0] / l;
          ny = n[1] / l;
          nz = n[2] / l;
          if (ny * sign < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
        }
        nrm[3 * c] = nx;
        nrm[3 * c + 1] = ny;
        nrm[3 * c + 2] = nz;
        const a = l; // |dv x du| is the area of one grid cell
        area[c] = a;
        weight[c] = a; // food and residue cling to both faces of a utensil
        if (side === 0) faceArea += a;
      }
    }
  }

  const idx: number[] = [];
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < nU - 1; i++) {
      for (let j = 0; j < nV - 1; j++) {
        if (!connected(i, j)) continue;
        const a = at(side, i, j), b = at(side, i, j + 1), c = at(side, i + 1, j), d = at(side, i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  const nbr = new Int32Array(nVerts * 4).fill(-1);
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const c = at(side, i, j);
        if (j < nV - 1 && connected(i, j)) nbr[4 * c] = at(side, i, j + 1);
        if (j > 0 && connected(i, j - 1)) nbr[4 * c + 1] = at(side, i, j - 1);
        if (i > 0) nbr[4 * c + 2] = at(side, i - 1, j);
        if (i < nU - 1) nbr[4 * c + 3] = at(side, i + 1, j);
      }
    }
  }

  return {
    kind: kind,
    nVerts,
    nRings: nU,
    nPhi: nV,
    closed: false,
    nbr,
    pos,
    nrm,
    weight,
    area,
    faceArea,
    adhesion: new Float32Array(nVerts).fill(sh.adhesion),
    index: new Uint32Array(idx),
    color: 0xcfd3d8,
  };
}

/** Overall length in cm. */
export const utensilLength = (k: UtensilKind) => SHAPES[k].length;
