import { readFileSync } from 'node:fs';
import { initSim, evaluateLayout, setK } from '../web/src/sim';
import { defaultLayout } from './fixtures';
await initSim(readFileSync('web/public/sim_core.wasm'));
const d = await defaultLayout();
for (const k of [240, 500, 1000, 2000, 4000]) {
  setK(k);
  const r = evaluateLayout(d);
  const kinds = ['plate', 'bowl', 'mug'].map((kk) => {
    const v = r.perDish.filter((_, i) => d[i].kind === kk).map((x) => x.mean);
    return kk[0] + (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
  });
  console.log(String(k).padEnd(5), 'mean', r.mean.toFixed(3), 'worst10', r.worst10.toFixed(3), 'score', r.score.toFixed(3), kinds.join(' '));
}
