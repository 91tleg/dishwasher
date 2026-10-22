import { RackPhysics } from '../web/src/physics';
import { settleLayout, spawnLayout } from './fixtures';

// A normally loaded machine must not lose any dish to the floor check, even after sliding the racks out and in.
const phys = await RackPhysics.create();
const dishes = settleLayout(phys, spawnLayout());
phys.openDoor(); phys.settle(2);
phys.setRackOut('lower', true); phys.setRackOut('upper', true); phys.settle(4);
phys.closeAll(); phys.settle(6);
console.log(`${dishes.length} dishes loaded; flagged as dropped after open/slide/close: ${phys.dishesOnFloor().length}`);
