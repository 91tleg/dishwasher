import { RackPhysics } from '../web/src/physics';
import { quatFromEuler } from '../web/src/transform';
import { MACHINE } from '../web/src/machine';
import type { DishKind } from '../web/src/geometry';

const TAKE: Record<string, [number, number, number]> = {
  plate: [0, 0, -90], bowl: [150, 0, 0], mug: [180, 0, 0], fork: [0, 0, 90],
};
const HOLD = 66;

async function trial(label: string, upperOut: boolean, lowerOut: boolean, spots: [DishKind, number, number][]) {
  const phys = await RackPhysics.create();
  phys.openDoor(); phys.settle(2);
  if (upperOut) phys.setRackOut('upper', true);
  if (lowerOut) phys.setRackOut('lower', true);
  phys.settle(3);
  console.log(`\n${label}`);
  spots.forEach(([kind, x, z], i) => {
    const [t, y, r] = TAKE[kind];
    phys.addDish(i, kind, { x, y: HOLD, z, q: quatFromEuler(t, y, r) });
    phys.hold(i, { x, y: HOLD, z, q: quatFromEuler(t, y, r) });
    const landing = phys.dropY(i);
    phys.release(i);
    phys.settle(3);
    const p = phys.pose(i)!;
    console.log(`${kind.padEnd(5)} aimed (${x}, ${z}) guide says lands at y ${landing?.toFixed(1)}  ->  ended x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}`);
  });
  phys.dispose();
}

const up = MACHINE.rackTravel.upper;
await trial('upper rack pulled out: drop from the default carry height (deck at 41)', true, false, [
  ['plate', -8, up + 0], ['bowl', 10, up + 12], ['mug', -12, up - 14], ['mug', 12, up - 14],
]);
const low = MACHINE.rackTravel.lower;
await trial('lower rack pulled out, upper in (deck at 9)', false, true, [
  ['plate', -14, low - 4], ['bowl', 18, low - 13], ['fork', 18, low + 15],
]);
