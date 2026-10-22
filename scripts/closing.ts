import { RackPhysics } from '../web/src/physics';
import { quatFromEuler } from '../web/src/transform';
import { MACHINE } from '../web/src/machine';
import type { DishKind } from '../web/src/geometry';

// Load random dishes onto the racks, close the machine, and see how long until it counts as "settled".
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const kinds: DishKind[] = ['plate', 'bowl', 'mug', 'fork', 'spoon', 'knife'];
const TAKE: Record<string, [number, number, number]> = { plate: [0, 0, -90], bowl: [150, 0, 0], mug: [180, 0, 0], fork: [0, 0, 90], spoon: [0, 0, 90], knife: [0, 0, -90] };

let stuck = 0;
const trials = 12;
for (let t = 0; t < trials; t++) {
  const phys = await RackPhysics.create();
  phys.openDoor(); phys.settle(2);
  phys.setRackOut('lower', true); phys.setRackOut('upper', true); phys.settle(3);
  const n = 5 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const upper = rnd() < 0.5;
    const [tilt, yaw, roll] = TAKE[kind];
    const rot = quatFromEuler(tilt, yaw + rnd() * 360 * (rnd() < 0.5 ? 1 : 0), roll);
    const z = (upper ? MACHINE.rackTravel.upper : MACHINE.rackTravel.lower) + (rnd() - 0.5) * 36;
    const x = (rnd() - 0.5) * 44;
    const pose = { x, y: 66, z, q: rot };
    phys.addDish(i, kind, pose); phys.hold(i, pose); phys.release(i);
    phys.settle(1.2);
  }
  phys.settle(2);
  phys.closeAll();
  let sim = 0, closedAt = -1, settledAt = -1;
  while (sim < 25 && settledAt < 0) {
    phys.update(1 / 60); sim += 1 / 60;
    if (closedAt < 0 && phys.closed) closedAt = sim;
    if (phys.closed && phys.settled) settledAt = sim;
  }
  const loose = phys.ids.filter((id) => {
    const e = (phys as any).dishes.get(id);
    return e.quietFrames < 20;
  });
  const info = loose.map((id) => {
    const e = (phys as any).dishes.get(id);
    const v = e.body.linvel(), w = e.body.angvel(), p = phys.pose(id)!;
    return `${e.kind}#${id} |v|=${Math.hypot(v.x, v.y, v.z).toFixed(3)} |w|=${Math.hypot(w.x, w.y, w.z).toFixed(2)} at (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`;
  });
  const ok = settledAt >= 0;
  if (!ok) stuck++;
  console.log(`trial ${t}: ${n} dishes, closed at ${closedAt.toFixed(1)}s, ${ok ? `settled at ${settledAt.toFixed(1)}s` : 'NEVER SETTLED: ' + info.join('; ')}`);
  phys.dispose();
}
console.log(`${stuck}/${trials} trials never settled within 25 s`);
