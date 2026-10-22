import { readFileSync } from 'node:fs';
import { RackPhysics } from '../web/src/physics';
import { evaluateLayout, initSim, setCycle, setK, type DishState } from '../web/src/sim';
import { DEFAULT_CYCLE } from '../web/src/cycle';
import { quatFromEuler } from '../web/src/transform';
import { defaultLayout } from './fixtures';

await initSim(readFileSync('web/public/sim_core.wasm'));
setCycle(DEFAULT_CYCLE);
const phys = await RackPhysics.create();
phys.openDoor(); phys.settle(2);
const bowls: DishState[][] = [];
for (const [x, z, tilt] of [[0, -6, 180], [18, -13, 180], [0, -6, 150]] as const) {
  phys.clear();
  phys.addDish(0, 'bowl', { x, y: 40, z, q: quatFromEuler(tilt, 0, 0) });
  phys.settle(3);
  bowls.push([{ id: 0, kind: 'bowl', pose: phys.pose(0)! }]);
}
const full = await defaultLayout();
for (const k of [1200, 2400, 4000, 6000]) {
  setK(k);
  const b = bowls.map((d) => (evaluateLayout(d).mean * 100).toFixed(1) + '%');
  const f = evaluateLayout(full);
  console.log(`K ${String(k).padEnd(5)} single bowl mouth-down: centre ${b[0]}, back-right ${b[1]}, tipped ${b[2]} | full load mean ${(f.mean * 100).toFixed(0)}% (plates ${(f.perDish.slice(0, 5).reduce((a, p) => a + p.mean, 0) / 5 * 100).toFixed(0)}%, mugs ${(f.perDish.slice(7).reduce((a, p) => a + p.mean, 0) / 4 * 100).toFixed(0)}%)`);
}
