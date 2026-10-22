import { RackPhysics } from '../web/src/physics';
import { settleLayout, spawnLayout } from './fixtures';
import { mulQuat, quatFromEuler, rotationMatrix } from '../web/src/transform';

const phys = await RackPhysics.create();
const dishes = settleLayout(phys, spawnLayout());
const show = (label: string, id: number) => {
  const p = phys.pose(id)!;
  const R = rotationMatrix(p.q);
  console.log(`${label}: x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}  axis ${(Math.acos(R[4]) * 180 / Math.PI).toFixed(0)} deg from up`);
};
show('plate 0 settled   ', 0);

// 1) Rotate in place (what the turn buttons do): tilt it 45 deg, then let go.
const d = dishes[0];
phys.hold(0, { ...d.pose, q: mulQuat(quatFromEuler(45, 0, 0), d.pose.q) });
phys.release(0);
phys.settle(4);
show('plate 0 after turn', 0);

// 2) Drop a plate straight onto another plate's spot: release should lift it clear, not explode.
phys.hold(1, { ...phys.pose(0)!, y: phys.pose(0)!.y });
phys.release(1);
phys.settle(4);
const a = phys.pose(0)!, b = phys.pose(1)!;
console.log(`overlap drop -> plate 0 at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}), plate 1 at (${b.x.toFixed(1)}, ${b.y.toFixed(1)}); settled=${phys.settled}`);
const fastest = Math.max(...phys.ids.map((i) => Math.hypot(phys.pose(i)!.x, phys.pose(i)!.z)));
console.log('nothing ejected from the tub:', fastest < 40);
