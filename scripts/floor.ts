import { RackPhysics } from '../web/src/physics';
import { quatFromEuler } from '../web/src/transform';
import type { DishKind } from '../web/src/geometry';

const phys = await RackPhysics.create();
phys.openDoor(); phys.settle(2);
const drop = (id: number, kind: DishKind, x: number, z: number, roll = 0) => {
  const pose = { x, y: 40, z, q: quatFromEuler(kind === 'plate' ? 0 : 180, 0, kind === 'plate' ? roll : 0) };
  phys.addDish(id, kind, pose);
};
drop(0, 'plate', 70, 0, -90);   // beside the machine, onto the room floor
drop(1, 'mug', -60, 20);        // the other side, onto the room floor
drop(2, 'bowl', 0, 70);         // onto the open door
drop(3, 'mug', 0, 0);           // into the tub, onto the tub floor
for (const t of [1, 2.5, 4, 8]) {
  phys.settle(t === 1 ? 1 : t - (t === 2.5 ? 1 : t === 4 ? 2.5 : 4));
  const where = [0, 1, 2, 3].map((id) => `${['plate floor', 'mug floor', 'bowl door', 'mug tub'][id]}:${phys.ids.includes(id) ? (phys.dishesOnFloor().includes(id) ? 'REMOVE' : 'stays') : 'gone'}`);
  console.log(`t=${t}s  ${where.join('  ')}`);
}
