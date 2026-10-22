import { readFileSync } from 'node:fs';
import { initSim, evaluateLayout, setCycle } from '../web/src/sim';
import { DEFAULT_CYCLE, meanMultiplier, type Cycle } from '../web/src/cycle';
import { defaultLayout } from './fixtures';
await initSim(readFileSync('web/public/sim_core.wasm'));
const d = await defaultLayout();
const base: Cycle = DEFAULT_CYCLE;
const show = (name: string, c: Cycle) => {
  setCycle(c);
  const t = performance.now();
  const r = evaluateLayout(d);
  const kinds = ['plate', 'bowl', 'mug'].map((k) => {
    const v = r.perDish.filter((_, i) => d[i].kind === k).map((x) => x.mean);
    return k[0] + (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
  });
  console.log(name.padEnd(22), 'mult', meanMultiplier(c).toFixed(2), 'mean', r.mean.toFixed(3), 'score', r.score.toFixed(3), kinds.join(' '), `${(performance.now() - t).toFixed(0)}ms`);
};
show('all on', base);
show('no splash', { ...base, splash: false });
show('no film', { ...base, film: false });
show('no splash, no film', { ...base, splash: false, film: false });
show('cold 40C', { ...base, tempC: 40 });
show('hot 65C', { ...base, tempC: 65 });
show('no detergent', { ...base, detergent: 0 });
show('1.5 doses', { ...base, detergent: 1.5 });
