import { RackPhysics } from '../web/src/physics';
import { quatFromEuler } from '../web/src/transform';
import { MACHINE, basketParts } from '../web/src/machine';

const phys = await RackPhysics.create();
const b = MACHINE.basket;
const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
const rim = 9 + 0.3 + b.height;
console.log(`basket: ${basketParts().length} plates, rim at y ${rim.toFixed(1)}`);

// A mug dropped mouth-down onto the basket's open top is too wide for the 3 cm slots, so it rests on the dividers:
// the basket is hollow, not a solid block, and dishes do not sink through the floor.
phys.addDish(0, 'mug', { x: cx, y: rim + 14, z: cz, q: quatFromEuler(180, 0, 0) });
phys.settle(4);
const p = phys.pose(0)!;
console.log(`mug at x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)} (floor ${(9.3).toFixed(1)}, rim ${rim.toFixed(1)})`);
console.log(p.y > 9.3 + 0.4 ? 'rests above the basket floor: OK' : 'ended on the floor');
