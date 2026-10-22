import { RackPhysics } from '../web/src/physics';
import { quatFromEuler, rotationMatrix, type Pose } from '../web/src/transform';
import { DECK } from '../web/src/rack';
import { LOWER_TINES } from '../web/src/machine';

const phys = await RackPhysics.create();
const items: { id: number; kind: 'plate' | 'bowl' | 'mug'; pose: Pose }[] = [];
let id = 0;
const add = (kind: 'plate' | 'bowl' | 'mug', x: number, y: number, z: number, tilt: number, yaw: number, roll: number) => {
  const pose: Pose = { x, y, z, q: quatFromEuler(tilt, yaw, roll) };
  items.push({ id, kind, pose });
  phys.addDish(id++, kind, pose);
};
const mid = (k: number) => LOWER_TINES.x[0] + 3.6 * k + 1.8;
// Plates on edge, faces along x, dropped over the tine slots.
for (const k of [0, 2, 4, 6, 8]) add('plate', mid(k), DECK.lower + 20, -4, 0, 0, -90);
// Bowls open-up tipped, in the back right; mugs mouth-down on the upper rack.
add('bowl', 18, DECK.lower + 12, -14, 150, 0, 0);
for (const x of [-12, -4, 4, 12]) add('mug', x, DECK.upper + 14, -14, 180, 0, 0);

const t = performance.now();
phys.settle(4);
console.log(`settled=${phys.settled}  ${(performance.now() - t).toFixed(0)} ms for 4 s of simulation`);
for (const it of items) {
  const p = phys.pose(it.id)!;
  const R = rotationMatrix(p.q);
  // Angle between the dish's axis (local +y) and vertical.
  const up = Math.acos(Math.max(-1, Math.min(1, R[4]))) * 180 / Math.PI;
  console.log(`${it.kind.padEnd(5)} start y=${it.pose.y.toFixed(1)} -> x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}  axis ${up.toFixed(0)}deg from up`);
}
