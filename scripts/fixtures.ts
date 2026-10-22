import { LOWER_TINES } from '../web/src/machine';
import { RackPhysics } from '../web/src/physics';
import { DECK } from '../web/src/rack';
import type { DishState } from '../web/src/sim';
import { quatFromEuler } from '../web/src/transform';

/** x of the gap between lower-rack tines k and k+1. */
const slotX = (k: number) => LOWER_TINES.x[0] + 3.6 * k + 1.8;

/**
 * A plausible hand-loaded start, as spawn points above the racks: plates on edge over the tine slots,
 * one bowl tipped at the back right and one upstairs, mugs mouth-down on the upper deck. Physics then settles them.
 */
export function spawnLayout(): DishState[] {
  const out: DishState[] = [];
  let id = 0;
  const add = (kind: DishState['kind'], x: number, y: number, z: number, tilt: number, yaw: number, roll: number) =>
    out.push({ id: id++, kind, pose: { x, y, z, q: quatFromEuler(tilt, yaw, roll) } });

  // Plate faces point along x (roll -90): they stand between tines like in a real rack.
  for (const k of [0, 2, 4, 6, 8]) add('plate', slotX(k), DECK.lower + 20, -4, 0, 0, -90);
  add('bowl', 18, DECK.lower + 12, -13, 150, 0, 0);
  add('bowl', 14, DECK.upper + 12, 14, 150, 90, 0);
  for (const x of [-12, -4, 4, 12]) add('mug', x, DECK.upper + 14, -14, 180, 0, 0);
  return out;
}

/** Drop the dishes into the physics world and let them come to rest; writes the settled poses back. */
export function settleLayout(phys: RackPhysics, dishes: DishState[], seconds = 4): DishState[] {
  for (const d of dishes) phys.addDish(d.id, d.kind, d.pose);
  phys.settle(seconds);
  for (const d of dishes) d.pose = phys.pose(d.id) ?? d.pose;
  return dishes;
}

/** The default load, settled in a throwaway physics world. */
export async function defaultLayout(): Promise<DishState[]> {
  const phys = await RackPhysics.create();
  const dishes = settleLayout(phys, spawnLayout());
  phys.dispose();
  return dishes;
}
