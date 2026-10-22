import { readFileSync } from 'node:fs';
import { buildDishLocal } from '../web/src/geometry';
import { evaluateLayout, initSim, setCycle, Wash } from '../web/src/sim';
import { DEFAULT_CYCLE } from '../web/src/cycle';
import { defaultLayout } from './fixtures';

// Wrap the wasm exports so the time spent inside Rust can be told apart from the TypeScript around it.
let wasmMs = 0;
const real = WebAssembly.instantiate;
(WebAssembly as any).instantiate = async (...a: any[]) => {
  const r: any = await (real as any)(...a);
  const wrapped: Record<string, unknown> = { ...r.instance.exports };
  for (const k of Object.keys(wrapped)) {
    const v = wrapped[k] as (...x: any[]) => unknown;
    if (typeof v === 'function' && /evaluate_layout|accumulate_step|finalize_layout/.test(k)) {
      wrapped[k] = (...args: any[]) => { const s = performance.now(); const out = v(...args); wasmMs += performance.now() - s; return out; };
    }
  }
  return { ...r, instance: { exports: wrapped } };
};
await initSim(readFileSync('web/public/sim_core.wasm'));
setCycle(DEFAULT_CYCLE);
const d = await defaultLayout();
for (const k of ['plate', 'bowl', 'mug']) buildDishLocal(k as any);
evaluateLayout(d); // warm

const N = 5;
wasmMs = 0;
let t = performance.now();
for (let i = 0; i < N; i++) evaluateLayout(d);
let total = (performance.now() - t) / N;
console.log(`batch score, ${d.length} dishes: ${total.toFixed(0)} ms total, ${(wasmMs / N).toFixed(0)} ms in Rust, ${(total - wasmMs / N).toFixed(0)} ms TypeScript (${((1 - wasmMs / N / total) * 100).toFixed(0)}%)`);

const w = new Wash(d);
wasmMs = 0;
t = performance.now();
const frames = 60;
for (let i = 0; i < frames; i++) w.advance((1 / 60) * 30, 2.5);
const adv = (performance.now() - t) / frames;
console.log(`wash step @30x: ${adv.toFixed(1)} ms/frame, ${(wasmMs / frames).toFixed(1)} ms in Rust`);
wasmMs = 0;
t = performance.now();
for (let i = 0; i < 10; i++) w.snapshot();
const snap = (performance.now() - t) / 10;
console.log(`wash snapshot (every 6th frame): ${snap.toFixed(0)} ms total, ${(wasmMs / 10).toFixed(0)} ms in Rust, ${(snap - wasmMs / 10).toFixed(0)} ms TypeScript`);
