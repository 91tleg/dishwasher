import { readFileSync } from 'node:fs';
import { buildDishLocal } from '../web/src/geometry';
import { RackPhysics } from '../web/src/physics';
import { evaluateLayout, initSim, setCycle, Wash, type DishState } from '../web/src/sim';
import { DEFAULT_CYCLE } from '../web/src/cycle';
import { quatFromEuler } from '../web/src/transform';

await initSim(readFileSync('web/public/sim_core.wasm'));
setCycle(DEFAULT_CYCLE);
const phys = await RackPhysics.create();
phys.openDoor(); phys.settle(2);
// One bowl, mouth down, dropped on the lower rack (rack pushed in so it can be scored).
const spots: [string, number, number, number][] = [['over arm centre', 0, -6, 180], ['back right', 18, -13, 180], ['tipped 150', 0, -6, 150]];
for (const [label, x, z, tilt] of spots) {
  phys.clear();
  const pose = { x, y: 40, z, q: quatFromEuler(tilt, 0, 0) };
  phys.addDish(0, 'bowl', pose);
  phys.settle(3);
  const d: DishState = { id: 0, kind: 'bowl', pose: phys.pose(0)! };
  const r = evaluateLayout([d]);
  const l = buildDishLocal('bowl');
  // Cleanliness by ring (radius from the bowl axis): inner cells only.
  const perRing = Array.from({ length: l.nRings }, (_, i) => {
    let ws = 0, cs = 0;
    for (let j = 0; j < l.nPhi; j++) { const v = i * l.nPhi + j; ws += l.weight[v]; cs += l.weight[v] * r.clean[v]; }
    return ws ? cs / ws : 0;
  });
  const worstRing = perRing.indexOf(Math.min(...perRing));
  const sorted = Array.from(r.clean.slice(0, l.nRings * l.nPhi)).sort((a, b) => a - b);
  console.log(`${label.padEnd(16)} predicted mean ${(r.mean * 100).toFixed(1)}%  worst10 ${(r.worst10 * 100).toFixed(1)}%  p10 ${(sorted[Math.floor(sorted.length * 0.1)] * 100).toFixed(0)}% median ${(sorted[Math.floor(sorted.length * 0.5)] * 100).toFixed(0)}%  worst ring ${worstRing}/${l.nRings - 1} (${(perRing[worstRing] * 100).toFixed(0)}%)  ring means: ${perRing.filter((_, i) => i % 3 === 0).map((c) => (c * 100).toFixed(0)).join(' ')}`);
}
