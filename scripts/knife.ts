import { RackPhysics } from '../web/src/physics';
import { quatFromEuler } from '../web/src/transform';

// Thin utensils fall through the 3.4 cm wire gaps. Do they lie still on the tub floor?
for (const kind of ['knife', 'fork', 'spoon'] as const) {
  const phys = await RackPhysics.create();
  phys.openDoor(); phys.settle(2);
  const [tilt, yaw, roll] = [0, 0, kind === 'knife' ? -90 : 90];
  for (const [i, x] of [-10, 0, 10].entries()) {
    const pose = { x, y: 30, z: -8, q: quatFromEuler(tilt, yaw + 30 * i, roll) };
    phys.addDish(i, kind, pose);
  }
  const out: string[] = [];
  for (const secs of [2, 4, 8, 12]) {
    phys.settle(secs - (out.length ? [2, 4, 8, 12][out.length - 1] : 0));
    const e = (phys as any).dishes;
    const rows = [...e.keys()].map((id: number) => {
      const b = e.get(id).body, v = b.linvel(), w = b.angvel(), p = phys.pose(id)!;
      return `y ${p.y.toFixed(1)} |w| ${Math.hypot(w.x, w.y, w.z).toFixed(2)} ${b.isSleeping() ? 'zzz' : 'awake'}`;
    });
    out.push(`  t=${String(secs).padEnd(2)}s: ${rows.join(' | ')}`);
  }
  console.log(kind + '\n' + out.join('\n'));
  phys.dispose();
}
