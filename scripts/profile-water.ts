import { readFileSync } from 'node:fs';
import { initSim, setCycle, Wash } from '../web/src/sim';
import { DEFAULT_CYCLE } from '../web/src/cycle';
import { buildNozzles } from '../web/src/rack';
import { defaultLayout } from './fixtures';

// Minimal canvas stand-in so the droplet texture can be built outside a browser.
const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_v: unknown) {} };
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { WaterFX } = await import('../web/src/water');

await initSim(readFileSync('web/public/sim_core.wasm'));
setCycle(DEFAULT_CYCLE);
const d = await defaultLayout();
const w = new Wash(d);
const fx = new WaterFX(buildNozzles());
fx.setObstacles(w.cellPos, w.cellNrm);
fx.start();
for (let i = 0; i < 120; i++) fx.update(1 / 60, i * 0.04); // let it reach steady state
let live = 0;
const t = performance.now();
const frames = 300;
for (let i = 0; i < frames; i++) fx.update(1 / 60, (120 + i) * 0.04);
const ms = (performance.now() - t) / frames;
live = (fx.points.geometry.drawRange.count as number) ?? 0;
console.log(`droplets: ~${live} live, ${ms.toFixed(2)} ms per frame`);
