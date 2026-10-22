import * as THREE from 'three';
import { buildDishGeometry, buildDishLocal, type DishKind } from './geometry';
import { MACHINE } from './machine';
import { dishColor } from './materials';
import { quatFromEuler } from './transform';
import { isUtensil } from './utensils';

/** What a catalog item is, so a click can spawn the matching dish. */
export interface CatalogItem {
  kind: DishKind;
}

export interface CatalogView {
  group: THREE.Group;
  /** The display dishes: each mesh carries `userData.catalog`. */
  items: THREE.Mesh[];
}

const WALL_Z = -95;

/** Two shelves: utensils, then a plate, bowl and mug. */
const SHELVES: { y: number; width: number; items: { kind: DishKind; x: number }[] }[] = [
  { y: 60, width: 80, items: [{ kind: 'fork', x: -22 }, { kind: 'spoon', x: 0 }, { kind: 'knife', x: 22 }] },
  { y: 95, width: 100, items: [{ kind: 'plate', x: -34 }, { kind: 'bowl', x: 0 }, { kind: 'mug', x: 30 }] },
];

/** The room: floor, a wall behind the machine, and shelves of dishes to choose from. */
export function buildCatalog(): CatalogView {
  const group = new THREE.Group();
  const items: THREE.Mesh[] = [];

  const floorY = MACHINE.cabinet.yMin;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = floorY - 0.02;
  group.add(floor);

  const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x232a36, roughness: 0.95 }));
  wall.position.set(0, floorY + 100, WALL_Z);
  group.add(wall);

  const wood = new THREE.MeshStandardMaterial({ color: 0x6a5a47, roughness: 0.8 });
  for (const shelf of SHELVES) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(shelf.width, 2, 16), wood);
    board.position.set(0, shelf.y - 1, WALL_Z + 8);
    group.add(board);

    for (const it of shelf.items) {
      const local = buildDishLocal(it.kind);
      const geo = buildDishGeometry(local);
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      const c = new THREE.Color(dishColor(it.kind) ?? local.color);
      for (let v = 0; v < col.count; v++) col.setXYZ(v, c.r, c.g, c.b);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: isUtensil(it.kind) ? 0.6 : 0.05 }),
      );
      // Plates stand on edge facing the room; bowls and mugs stand upright; utensils lie flat.
      let y = shelf.y + 0.1;
      if (it.kind === 'plate') {
        y = shelf.y + 13.3;
        mesh.quaternion.set(...quatFromEuler(90, 0, 0));
      } else if (isUtensil(it.kind)) {
        let minY = Infinity;
        for (let v = 0; v < local.nVerts; v++) minY = Math.min(minY, local.pos[3 * v + 1]);
        y = shelf.y - minY + 0.05;
      }
      mesh.position.set(it.x, y, WALL_Z + 9);
      mesh.userData.catalog = { kind: it.kind } satisfies CatalogItem;
      group.add(mesh);
      items.push(mesh);
    }
  }
  return { group, items };
}
