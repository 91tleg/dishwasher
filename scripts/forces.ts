import { readFileSync } from 'node:fs';
import { dishMass } from '../web/src/materials';
import { evaluateLayout, initSim } from '../web/src/sim';
import { defaultLayout } from './fixtures';

await initSim(readFileSync('web/public/sim_core.wasm'));
for (const k of ['plate', 'bowl', 'mug', 'fork', 'spoon', 'knife'] as const) console.log(k.padEnd(6), `${(dishMass(k) * 1000).toFixed(0)} g`);
const d = await defaultLayout();
const r = evaluateLayout(d);
d.forEach((x, i) => {
  const f = r.forces![i];
  console.log(`${x.kind.padEnd(5)} peak ${f.peak.toFixed(3)}N up ${f.up.toFixed(3)}N weight ${f.weight.toFixed(2)}N ratio ${f.ratio.toFixed(2)}`);
});
