import { readFileSync } from 'node:fs';
import { MACHINE } from '../web/src/machine';
import { RackPhysics } from '../web/src/physics';
import { evaluateLayout, initSim, type DishState } from '../web/src/sim';
import { quatFromEuler } from '../web/src/transform';
import { utensilLength } from '../web/src/utensils';

await initSim(readFileSync('web/public/sim_core.wasm'));
const phys = await RackPhysics.create();
const b = MACHINE.basket;
const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
const dishes: DishState[] = [];
let id = 0;
for (const [k, col, row] of [['fork', 0, 0], ['spoon', 1, 1], ['knife', 2, 3], ['fork', 1, 4], ['spoon', 2, 0]] as const) {
  const x = b.minX + (w * (col + 0.5)) / 3, z = b.minZ + (d * (row + 0.5)) / 5;
  const pose = { x, y: 9.7 + b.height + utensilLength(k) / 2 + 3, z, q: quatFromEuler(0, 0, k === 'knife' ? -90 : 90) };
  dishes.push({ id: id++, kind: k, pose });
  phys.addDish(id - 1, k, pose);
}
phys.settle(4);
for (const x of dishes) x.pose = phys.pose(x.id)!;
const t = performance.now();
const r = evaluateLayout(dishes);
console.log(`scored ${dishes.length} utensils in ${(performance.now() - t).toFixed(0)} ms: mean ${r.mean.toFixed(3)}, per item`, r.perDish.map((p, i) => `${dishes[i].kind[0]}${p.mean.toFixed(2)}`).join(' '));
