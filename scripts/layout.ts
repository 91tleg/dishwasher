import { defaultLayout } from './fixtures';
import { rotationMatrix } from '../web/src/transform';
import { TUB } from '../web/src/rack';
const d = await defaultLayout();
for (const x of d) {
  const R = rotationMatrix(x.pose.q);
  const inside = x.pose.x > TUB.minX && x.pose.x < TUB.maxX && x.pose.z > TUB.minZ && x.pose.z < TUB.maxZ && x.pose.y > 0 && x.pose.y < TUB.height;
  console.log(`${x.kind.padEnd(5)} x ${x.pose.x.toFixed(1).padStart(6)} y ${x.pose.y.toFixed(1).padStart(5)} z ${x.pose.z.toFixed(1).padStart(6)}  axis ${(Math.acos(Math.max(-1, Math.min(1, R[4]))) * 180 / Math.PI).toFixed(0).padStart(3)} deg  ${inside ? '' : 'OUTSIDE TUB'}`);
}
