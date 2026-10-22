import { buildDishLocal } from '../web/src/geometry';
import { dishMass } from '../web/src/materials';
import { MACHINE } from '../web/src/machine';
import { RackPhysics } from '../web/src/physics';
import { quatFromEuler, rotationMatrix } from '../web/src/transform';
import { UTENSIL_KINDS, utensilLength } from '../web/src/utensils';

for (const k of UTENSIL_KINDS) {
  const l = buildDishLocal(k);
  let soil = 0, bad = 0;
  for (let v = 0; v < l.nVerts; v++) {
    soil += l.weight[v];
    const n = Math.hypot(l.nrm[3 * v], l.nrm[3 * v + 1], l.nrm[3 * v + 2]);
    if (!(n > 0.99 && n < 1.01)) bad++;
  }
  console.log(`${k.padEnd(6)} ${l.nVerts} cells, face area ${l.faceArea.toFixed(1)} cm2, soil area ${soil.toFixed(1)}, bad normals ${bad}, tris ${l.index.length / 3}, ` + `${(dishMass(k) * 1000).toFixed(0)} g`);
}

// Drop each utensil, handle-down, over a basket slot and see whether it ends up standing in the basket.
const phys = await RackPhysics.create();
const b = MACHINE.basket;
const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
const floorY = MACHINE.decks.lower + 0.3 + b.wall;
UTENSIL_KINDS.forEach((k, i) => {
  const col = i % 3, row = [0, 1, 3][i]; // row 2 sits under the carry handle
  const x = b.minX + (w * (col + 0.5)) / 3;
  const z = b.minZ + (d * (row + 0.5)) / 5;
  const roll = k === 'knife' ? -90 : 90;
  phys.addDish(i, k, { x, y: floorY + b.height + utensilLength(k) / 2 + 3, z, q: quatFromEuler(0, 0, roll) });
});
phys.settle(4);
UTENSIL_KINDS.forEach((k, i) => {
  const p = phys.pose(i)!;
  const R = rotationMatrix(p.q);
  // Angle of the length axis (local x) from vertical.
  const lean = (Math.acos(Math.min(1, Math.abs(R[3]))) * 180) / Math.PI;
  const inside = p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ;
  console.log(`${k.padEnd(6)} in basket: ${inside}  centre y ${p.y.toFixed(1)} (floor ${floorY.toFixed(1)}, half length ${(utensilLength(k) / 2).toFixed(1)})  lean ${lean.toFixed(0)} deg from vertical`);
});
