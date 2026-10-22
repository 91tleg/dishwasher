import { readFileSync } from 'node:fs';
import { buildDishLocal } from '../web/src/geometry';
import { RackPhysics } from '../web/src/physics';
import { evaluateLayout, initSim, setCycle } from '../web/src/sim';
import { DEFAULT_CYCLE } from '../web/src/cycle';
import { quatFromEuler, rotationMatrix } from '../web/src/transform';

await initSim(readFileSync('web/public/sim_core.wasm'));
setCycle(DEFAULT_CYCLE);
const phys = await RackPhysics.create();
phys.openDoor(); phys.settle(2);
phys.addDish(0, 'bowl', { x: 0, y: 40, z: -6, q: quatFromEuler(180, 0, 0) });
phys.settle(3);
const pose = phys.pose(0)!;
const r = evaluateLayout([{ id: 0, kind: 'bowl', pose }]);
const l = buildDishLocal('bowl');
const R = rotationMatrix(pose.q);
console.log('bowl pose', pose.x.toFixed(1), pose.y.toFixed(1), pose.z.toFixed(1), 'axis y-dot', R[4].toFixed(2));
const rows: { clean: number; rad: number; y: number; az: number; ny: number; ring: number }[] = [];
for (let i = 0; i < l.nRings; i++) for (let j = 0; j < l.nPhi; j++) {
  const v = i * l.nPhi + j;
  if (l.weight[v] < 1e-6) continue;
  const px = l.pos[3 * v], py = l.pos[3 * v + 1], pz = l.pos[3 * v + 2];
  const wx = R[0] * px + R[1] * py + R[2] * pz + pose.x, wy = R[3] * px + R[4] * py + R[5] * pz + pose.y, wz = R[6] * px + R[7] * py + R[8] * pz + pose.z;
  const nny = R[3] * l.nrm[3 * v] + R[4] * l.nrm[3 * v + 1] + R[5] * l.nrm[3 * v + 2];
  rows.push({ clean: r.clean[v], rad: Math.hypot(wx, wz), y: wy, az: (Math.atan2(wz, wx) * 180) / Math.PI, ny: nny, ring: i });
}
const dirty = rows.filter((c) => c.clean < 0.5);
console.log(`dirty (<50%) inner cells: ${dirty.length} of ${rows.length}`);
const by = (f: (c: (typeof rows)[0]) => number, w: number) => {
  const m = new Map<number, number>();
  for (const c of dirty) m.set(Math.round(f(c) / w) * w, (m.get(Math.round(f(c) / w) * w) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(' ');
};
console.log('by distance from arm axis (cm):', by((c) => c.rad, 2));
console.log('by height (cm):               ', by((c) => c.y, 1));
console.log('by azimuth (deg):             ', by((c) => c.az, 30));
console.log('by normal.y (down<0):         ', by((c) => c.ny * 10, 2).replace(/(-?\d+):/g, (_, k) => `${(Number(k) / 10).toFixed(1)}:`));
