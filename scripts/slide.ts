import { RackPhysics } from '../web/src/physics';
import { rotationMatrix } from '../web/src/transform';
import { settleLayout, spawnLayout } from './fixtures';

const phys = await RackPhysics.create();
const dishes = settleLayout(phys, spawnLayout());
const snapshot = (label: string) => {
  const rows = dishes.map((d) => {
    const p = phys.pose(d.id)!;
    const R = rotationMatrix(p.q);
    return { kind: d.kind, y: p.y, z: p.z, axis: (Math.acos(Math.max(-1, Math.min(1, R[4]))) * 180) / Math.PI };
  });
  const z = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.z.toFixed(1)).join(' ');
  console.log(`${label.padEnd(26)} plates z: ${z('plate')} | bowls z: ${z('bowl')} | mugs z: ${z('mug')}`);
  return rows;
};
const run = (s: number) => phys.settle(s);

const start = snapshot('loaded, door closed');
phys.openDoor(); run(2);
console.log('door open:', phys.door.value, ' door target', phys.door.target);
phys.setRackOut('lower', true); run(3);
const lowerOut = snapshot('lower rack pulled out');
phys.setRackOut('upper', true); run(3);
const bothOut = snapshot('upper rack pulled out');

const carried = (a: typeof start, b: typeof start, kinds: string[], travel: number) =>
  a.every((r, i) => !kinds.includes(r.kind) || Math.abs(b[i].z - r.z - travel) < 6);
console.log('lower-rack dishes rode out ~40 cm:', carried(start, lowerOut, ['plate'], 40));
console.log('upper-rack dishes rode out ~32 cm:', carried(lowerOut, bothOut, ['mug'], 32));
console.log('plates still upright:', bothOut.filter((r) => r.kind === 'plate').every((r) => Math.abs(r.axis - 90) < 12));

phys.closeAll(); run(6);
snapshot('racks in, door closing');
console.log('closed:', phys.closed, 'door', phys.door.value.toFixed(3));
