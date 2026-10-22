import { buildDishLocal, type DishKind, type DishLocal } from './geometry';
import { cycleFlags, DEFAULT_CYCLE, detergentConc, meanMultiplier, rateMultiplier, washSeconds, waterTemp, type Cycle } from './cycle';
import { dishMass } from './materials';
import { buildNozzles, type NozzleSet } from './rack';
import { rotationMatrix, type Pose } from './transform';

export type { Pose };

export interface DishState {
  id: number;
  kind: DishKind;
  pose: Pose;
}

export interface DishResult {
  mean: number;
  worst10: number;
}

/** Largest instantaneous spray force on a dish during the arm sweep. */
export interface DishForce {
  /** Newtons. */
  peak: number;
  /** Vertical part at the peak (positive = pushing up). */
  up: number;
  /** Weight in newtons. */
  weight: number;
  /** peak / weight: how hard the spray pushes relative to the dish's own weight. */
  ratio: number;
}

export interface EvalResult {
  mean: number;
  worst10: number;
  score: number;
  /** Final y of each dish (it rests on its rack deck). */
  y: number[];
  perDish: DishResult[];
  /** Present for batch scores (not the live wash). */
  forces?: DishForce[];
  /** Clean fraction per cell, concatenated in dish order. */
  clean: Float32Array;
  /** Wetness 0..1 per cell (live wash only), for drawing the water film. */
  film?: Float32Array;
  offsets: number[];
}

interface Wasm {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  evaluate_layout(...a: number[]): void;
  accumulate_step(...a: number[]): void;
  finalize_layout(...a: number[]): void;
}

let wasm: Wasm;
const nozzles: NozzleSet = buildNozzles();
export const STEPS = 36;
export let K = 1200;
export function setK(k: number) {
  K = k;
}
const MAX_SUBSTEPS = 2;

let cycle: Cycle = { ...DEFAULT_CYCLE };
export function setCycle(c: Cycle) {
  cycle = { ...c };
}
export function getCycle(): Cycle {
  return cycle;
}

export async function initSim(bytes: BufferSource): Promise<void> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  wasm = instance.exports as unknown as Wasm;
}

class Buf {
  ptr = 0;
  size = 0;
  get(n: number): number {
    if (n > this.size) {
      if (this.ptr) wasm.dealloc(this.ptr, this.size);
      this.size = Math.max(n, this.size * 2);
      this.ptr = wasm.alloc(this.size);
    }
    return this.ptr;
  }
  free() {
    if (this.ptr) wasm.dealloc(this.ptr, this.size);
    this.ptr = 0;
    this.size = 0;
  }
}

function put(b: Buf, data: Float32Array | Uint32Array | Int32Array): number {
  const ptr = b.get(data.byteLength);
  if (data instanceof Float32Array) new Float32Array(wasm.memory.buffer, ptr, data.length).set(data);
  else if (data instanceof Int32Array) new Int32Array(wasm.memory.buffer, ptr, data.length).set(data);
  else new Uint32Array(wasm.memory.buffer, ptr, data.length).set(data);
  return ptr;
}

interface World {
  n: number;
  locals: DishLocal[];
  offsets: number[];
  pos: Float32Array;
  nrm: Float32Array;
  weight: Float32Array;
  area: Float32Array;
  adh: Float32Array;
  id: Uint32Array;
  nbr: Int32Array;
  ys: number[];
}

function buildWorld(dishes: DishState[]): World {
  const locals: DishLocal[] = dishes.map((d) => buildDishLocal(d.kind));
  const offsets: number[] = [];
  let n = 0;
  for (const l of locals) {
    offsets.push(n);
    n += l.nVerts;
  }
  const w: World = {
    n,
    locals,
    offsets,
    pos: new Float32Array(3 * n),
    nrm: new Float32Array(3 * n),
    weight: new Float32Array(n),
    area: new Float32Array(n),
    adh: new Float32Array(n),
    id: new Uint32Array(n),
    nbr: new Int32Array(4 * n),
    ys: [],
  };

  dishes.forEach((d, di) => {
    const l = locals[di];
    const R = rotationMatrix(d.pose.q);
    const o = offsets[di];
    const y0 = d.pose.y;
    w.ys.push(y0);
    for (let v = 0; v < l.nVerts; v++) {
      const px = l.pos[3 * v], py = l.pos[3 * v + 1], pz = l.pos[3 * v + 2];
      const q = 3 * (o + v);
      const wy = R[3] * px + R[4] * py + R[5] * pz + y0;
      w.pos[q] = R[0] * px + R[1] * py + R[2] * pz + d.pose.x;
      w.pos[q + 1] = wy;
      w.pos[q + 2] = R[6] * px + R[7] * py + R[8] * pz + d.pose.z;
      const nx = l.nrm[3 * v], ny = l.nrm[3 * v + 1], nz = l.nrm[3 * v + 2];
      w.nrm[q] = R[0] * nx + R[1] * ny + R[2] * nz;
      w.nrm[q + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
      w.nrm[q + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
      w.weight[o + v] = l.weight[v];
      w.area[o + v] = l.area[v];
      w.adh[o + v] = l.adhesion[v];
      w.id[o + v] = di;
      for (let k = 0; k < 4; k++) {
        const nb = l.nbr[4 * v + k];
        w.nbr[4 * (o + v) + k] = nb < 0 ? -1 : o + nb;
      }
    }
  });
  return w;
}

function summarize(
  w: World,
  clean: Float32Array,
  mean: number,
  worst10: number,
): EvalResult {
  const perDish: DishResult[] = w.locals.map((l, di) => {
    const o = w.offsets[di];
    const cells: number[] = [];
    let ws = 0, cs = 0;
    for (let v = 0; v < l.nVerts; v++) {
      if (l.weight[v] <= 1e-6) continue;
      cells.push(v);
      ws += l.weight[v];
      cs += l.weight[v] * clean[o + v];
    }
    cells.sort((a, b) => clean[o + a] - clean[o + b]);
    let aw = 0, ac = 0;
    for (const v of cells) {
      if (aw >= ws * 0.1) break;
      aw += l.weight[v];
      ac += l.weight[v] * clean[o + v];
    }
    return { mean: ws ? cs / ws : 0, worst10: aw ? ac / aw : 0 };
  });

  // Blend overall soil removal with the dirtiest dishes so one bad bowl can't hide in the average.
  const dishMeans = perDish.map((p) => p.mean).sort((a, b) => a - b);
  const q = Math.max(1, Math.ceil(dishMeans.length / 4));
  const worstDishes = dishMeans.slice(0, q).reduce((a, b) => a + b, 0) / q;

  return {
    mean,
    worst10,
    score: 0.5 * mean + 0.5 * worstDishes,
    y: w.ys,
    perDish,
    clean,
    offsets: w.offsets,
  };
}

const evalBufs = Array.from({ length: 7 }, () => new Buf());
const evalPeaks = new Buf();
const evalNoz = Array.from({ length: 4 }, () => new Buf());
const evalOut = new Buf();
const evalStats = new Buf();

/** One full arm revolution, scored. Fast enough for search; use `Wash` for live playback. */
export function evaluateLayout(dishes: DishState[], steps = STEPS): EvalResult {
  const w = buildWorld(dishes);
  const pPos = put(evalBufs[0], w.pos);
  const pNrm = put(evalBufs[1], w.nrm);
  const pW = put(evalBufs[2], w.weight);
  const pA = put(evalBufs[3], w.adh);
  const pId = put(evalBufs[4], w.id);
  const pNbr = put(evalBufs[5], w.nbr);
  const pArea = put(evalBufs[6], w.area);
  const pNc = put(evalNoz[0], nozzles.center);
  const pNp = put(evalNoz[1], nozzles.localPos);
  const pNd = put(evalNoz[2], nozzles.localDir);
  const pNf = put(evalNoz[3], nozzles.flow);
  const pOut = evalOut.get(w.n * 4);
  const pStats = evalStats.get(16);

  const pPeaks = evalPeaks.get(8 * dishes.length);
  wasm.evaluate_layout(
    w.n, pPos, pNrm, pW, pArea, pA, pId, pNbr, nozzles.count, pNc, pNp, pNd, pNf,
    steps, K, meanMultiplier(cycle), cycleFlags(cycle), pOut, pStats, dishes.length, pPeaks,
  );

  const clean = new Float32Array(wasm.memory.buffer, pOut, w.n).slice();
  const st = new Float32Array(wasm.memory.buffer, pStats, 4);
  const peaks = new Float32Array(wasm.memory.buffer, pPeaks, 2 * dishes.length);
  const forces: DishForce[] = dishes.map((d, i) => {
    const weight = dishMass(d.kind) * 9.81;
    return { peak: peaks[2 * i], up: peaks[2 * i + 1], weight, ratio: peaks[2 * i] / weight };
  });
  return { ...summarize(w, clean, st[0], st[1]), forces };
}

/**
 * A wash in progress. Direct exposure accumulates in wasm memory as the arm turns, weighted by
 * the cycle's temperature/detergent multiplier at that moment; `snapshot` turns it into
 * cleanliness. Run to completion it matches `evaluateLayout`.
 */
export class Wash {
  private w: World;
  private bufs = Array.from({ length: 11 }, () => new Buf());
  private g = new Buf();
  private outClean = new Buf();
  private outFilm = new Buf();
  private outStats = new Buf();
  private ptrs: number[];
  private cycle: Cycle;
  private samples = 0;
  /** Simulated seconds elapsed. */
  elapsed = 0;
  theta = 0;
  /** Integral of the rate multiplier over elapsed time, as a fraction of the full wash. */
  private mint = 0;

  constructor(dishes: DishState[]) {
    this.w = buildWorld(dishes);
    this.cycle = { ...cycle };
    const { w, bufs } = this;
    this.ptrs = [
      put(bufs[0], w.pos), put(bufs[1], w.nrm), put(bufs[2], w.weight), put(bufs[3], w.adh), put(bufs[4], w.id), put(bufs[5], w.nbr),
      put(bufs[6], nozzles.center), put(bufs[7], nozzles.localPos), put(bufs[8], nozzles.localDir), put(bufs[9], nozzles.flow),
      put(bufs[10], w.area),
    ];
    // Allocate first: growing wasm memory detaches any earlier view of it.
    const gPtr = this.g.get(w.n * 4);
    new Float32Array(wasm.memory.buffer, gPtr, w.n).fill(0);
  }

  /** Length of the main wash, simulated seconds. */
  get duration(): number {
    return washSeconds(this.cycle);
  }

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  /** World-space cell positions / normals, for water-droplet collisions. */
  get cellPos(): Float32Array {
    return this.w.pos;
  }

  get cellNrm(): Float32Array {
    return this.w.nrm;
  }

  get waterTemp(): number {
    return waterTemp(this.elapsed, this.cycle);
  }

  get detergent(): number {
    return detergentConc(this.elapsed, this.cycle);
  }

  /** Advance the wash by `dt` simulated seconds. */
  advance(dt: number, omega: number) {
    const total = this.duration;
    dt = Math.min(dt, total - this.elapsed);
    if (dt <= 0) return;
    const dTheta = omega * dt;
    // Sub-steps under ~3 degrees keep the sweep smooth at low speed. At high speed the arm
    // makes many turns per frame, so cap the work and let the sampled angles drift: over
    // hundreds of frames they cover the whole revolution evenly.
    const sub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dTheta / 0.05)));
    const sparse = dTheta / sub > 0.05;
    const [a, b, c, d, e, f, nc, np, nd, nf, ar] = this.ptrs;
    const m = rateMultiplier(this.elapsed + dt / 2, this.cycle);
    const wt = (m * dt) / sub / total;
    for (let s = 0; s < sub; s++) {
      this.theta += dTheta / sub;
      // Sparse sampling uses a golden-ratio sequence so angles never repeat and fill in evenly.
      const angle = sparse ? ((++this.samples * 0.6180339887) % 1) * 2 * Math.PI : this.theta;
      wasm.accumulate_step(this.w.n, a, b, c, ar, d, e, f, nozzles.count, nc, np, nd, nf, angle, wt, this.g.ptr);
    }
    this.mint += (m * dt) / total;
    this.elapsed += dt;
  }

  snapshot(): EvalResult {
    const { w } = this;
    const [a, b, c, d, e, f, , , , , ar] = this.ptrs;
    const pOut = this.outClean.get(w.n * 4);
    const pFilm = this.outFilm.get(w.n * 4);
    const pSt = this.outStats.get(16);
    wasm.finalize_layout(w.n, a, b, c, ar, d, e, f, this.g.ptr, K, this.mint, cycleFlags(this.cycle), pOut, pFilm, pSt);
    const clean = new Float32Array(wasm.memory.buffer, pOut, w.n).slice();
    const film = new Float32Array(wasm.memory.buffer, pFilm, w.n).slice();
    const st = new Float32Array(wasm.memory.buffer, pSt, 4);
    return { ...summarize(w, clean, st[0], st[1]), film };
  }

  dispose() {
    this.bufs.forEach((x) => x.free());
    this.g.free();
    this.outClean.free();
    this.outFilm.free();
    this.outStats.free();
  }
}
