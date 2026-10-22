import { readFileSync } from 'node:fs';
import { initSim, evaluateLayout, Wash } from '../web/src/sim';
import { defaultLayout } from './fixtures';
await initSim(readFileSync('web/public/sim_core.wasm'));
const d = await defaultLayout();
const batch = evaluateLayout(d);
const w = new Wash(d);
const omega = (24 * 2 * Math.PI) / 60;
let t = performance.now(), frames = 0;
while (!w.done) { w.advance((1 / 60) * 60, omega); frames++; }
const ms = performance.now() - t;
const end = w.snapshot();
console.log(`wash: ${frames} frames, ${(ms / frames).toFixed(1)} ms/frame at 60x`);
console.log('batch  mean', batch.mean.toFixed(3), 'score', batch.score.toFixed(3));
console.log('wash   mean', end.mean.toFixed(3), 'score', end.score.toFixed(3));
