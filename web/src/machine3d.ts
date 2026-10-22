import * as THREE from 'three';
import { basketHandleRods, basketParts, lowerRackRods, MACHINE, upperRackRods, type Rod } from './machine';
import { DECK, TUB, type NozzleSet } from './rack';

/** Anything the user can click to work the machine. */
export type MachineAction = 'door' | 'lower' | 'upper';

export interface MachineView {
  root: THREE.Group;
  arms: THREE.Group[];
  door: THREE.Group;
  racks: { lower: THREE.Group; upper: THREE.Group };
  /** Handles to click: each carries `userData.action`. */
  handles: THREE.Object3D[];
  /** Jet lines on the spray arms: shown only while the wash runs. */
  setJetsVisible(on: boolean): void;
  /** Pose the moving parts. All values 0..1. */
  update(s: { door: number; lower: number; upper: number }): void;
}

const STEEL = 0xb4bac2;

/** Every rod as one instanced cylinder mesh, so a few hundred wires cost a single draw call. */
function rodMesh(rods: Rod[], color: number): THREE.InstancedMesh {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.35 }), rods.length);
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  rods.forEach((r, i) => {
    const a = new THREE.Vector3(...r.a), b = new THREE.Vector3(...r.b);
    const dir = b.clone().sub(a);
    const len = dir.length();
    m.compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()), new THREE.Vector3(r.r, len, r.r));
    mesh.setMatrixAt(i, m);
  });
  return mesh;
}

/** Slotted-plastic texture like the basket's grid panels: light grey with rectangular holes. */
function slotTexture(cols: number, rows: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9ccd1';
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'destination-out';
  const cw = 128 / cols, rh = 128 / rows;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) g.fillRect(i * cw + cw * 0.18, j * rh + rh * 0.2, cw * 0.64, rh * 0.6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The cutlery basket: hollow slotted plastic with upright-slot dividers and an arched carry handle. */
function buildBasket(): THREE.Group {
  const g = new THREE.Group();
  const plastic = 0xc9ccd1;
  const plain = new THREE.MeshStandardMaterial({ color: plastic, roughness: 0.6 });
  for (const part of basketParts()) {
    const size = part.half.map((h) => h * 2) as [number, number, number];
    let mat: THREE.Material = plain;
    if (part.kind === 'wall') {
      // Grid-of-holes walls, as in the photo. The long axis of the wall sets the hole count.
      const along = Math.max(size[0], size[2]);
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.6,
        side: THREE.DoubleSide,
        alphaTest: 0.5,
        map: slotTexture(Math.round(along / 3), Math.round(size[1] / 2.5)),
      });
    }
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...part.center);
    g.add(m);
  }
  g.add(rodMesh(basketHandleRods(), 0xdadee4));
  return g;
}

function handleBar(length: number, radius: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 16), new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: 0.3 }));
  m.rotation.z = Math.PI / 2;
  return m;
}

function controlStrip(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#15181d';
  g.fillRect(0, 0, 512, 64);
  g.font = '12px system-ui, sans-serif';
  g.fillStyle = '#8b94a1';
  ['heavy', 'auto', 'normal', 'speed 60', 'favorite'].forEach((t, i) => {
    g.fillText(t, 110 + i * 62, 24);
    g.fillStyle = i === 2 ? '#e8e6e0' : '#454b55';
    g.fillRect(116 + i * 62, 36, 14, 4);
    g.fillStyle = '#8b94a1';
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(2 * MACHINE.cabinet.halfX - 8, 7), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
}

export function buildMachine(nozzles: NozzleSet): MachineView {
  const root = new THREE.Group();
  const c = MACHINE.cabinet;
  const d = MACHINE.door;
  const w = TUB.maxX - TUB.minX;
  const depth = TUB.maxZ - TUB.minZ;

  // Materials that go see-through in x-ray mode.
  const shellMats: THREE.MeshStandardMaterial[] = [];
  const steel = () => {
    const m = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.85, roughness: 0.38, side: THREE.DoubleSide });
    shellMats.push(m);
    return m;
  };

  // Tub interior: floor and walls (translucent stainless) plus an outline.
  const tubMat = new THREE.MeshStandardMaterial({ color: 0x8a919b, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, depth), new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);
  const wall = (width: number, height: number, pos: [number, number, number], rotY: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), tubMat);
    m.position.set(...pos);
    m.rotation.y = rotY;
    root.add(m);
  };
  wall(w, TUB.height, [0, TUB.height / 2, TUB.minZ], 0);
  wall(depth, TUB.height, [TUB.minX, TUB.height / 2, 0], Math.PI / 2);
  wall(depth, TUB.height, [TUB.maxX, TUB.height / 2, 0], Math.PI / 2);

  // Cabinet shell: sides, back, top, base block and the black toe kick.
  const panel = (size: [number, number, number], pos: [number, number, number], mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set(...pos);
    root.add(m);
  };
  const side = c.halfX - w / 2;
  const zLen = c.zFront - c.zBack;
  const zMid = (c.zFront + c.zBack) / 2;
  const shellH = c.yMax - c.yMin;
  panel([side, shellH, zLen], [-(c.halfX - side / 2), (c.yMax + c.yMin) / 2, zMid], steel());
  panel([side, shellH, zLen], [c.halfX - side / 2, (c.yMax + c.yMin) / 2, zMid], steel());
  const backT = TUB.minZ - c.zBack;
  panel([2 * c.halfX, shellH, backT], [0, (c.yMax + c.yMin) / 2, c.zBack + backT / 2], steel());
  panel([2 * c.halfX, c.yMax - TUB.height, zLen], [0, (c.yMax + TUB.height) / 2, zMid], steel());
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.7 });
  panel([2 * c.halfX, -c.yMin, zLen], [0, c.yMin / 2, zMid], baseMat);

  // Door: pivots at the hinge, so rotating it about x swings it forward and down.
  const door = new THREE.Group();
  door.position.set(0, d.hingeY, d.hingeZ);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * c.halfX, d.height, d.thickness), steel());
  slab.position.set(0, d.height / 2, d.thickness / 2);
  door.add(slab);
  const linerMat = new THREE.MeshStandardMaterial({ color: 0x9aa1ab, metalness: 0.5, roughness: 0.5 });
  const liner = new THREE.Mesh(new THREE.BoxGeometry(2 * c.halfX - 3, d.height - 3, 0.5), linerMat);
  liner.position.set(0, d.height / 2, 0.05);
  door.add(liner);
  const strip = controlStrip();
  strip.position.set(0, d.height - 4.2, d.thickness + 0.05);
  door.add(strip);
  const handle = handleBar(2 * c.halfX - 14, 1.1, 0xdadee4);
  handle.position.set(0, d.height - 11, d.thickness + 3);
  handle.userData.action = 'door' satisfies MachineAction;
  door.add(handle);
  for (const x of [-(c.halfX - 8), c.halfX - 8]) {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 3, 10), handle.material);
    stand.rotation.x = Math.PI / 2;
    stand.position.set(x, d.height - 11, d.thickness + 1.5);
    door.add(stand);
  }
  root.add(door);

  // Racks: wire meshes grouped so each slides as one piece.
  const lower = new THREE.Group();
  lower.add(rodMesh(lowerRackRods(), 0x3a3f47), buildBasket());
  const lowerHandle = handleBar(40, 0.7, 0xd0d4da);
  lowerHandle.position.set(-2, DECK.lower + 7, 24.5);
  lowerHandle.userData.action = 'lower' satisfies MachineAction;
  lower.add(lowerHandle);
  root.add(lower);

  const upper = new THREE.Group();
  upper.add(rodMesh(upperRackRods(), 0x3a3f47));
  const upperHandle = handleBar(36, 0.7, 0xd0d4da);
  upperHandle.position.set(0, DECK.upper + 8, 22.5);
  upperHandle.userData.action = 'upper' satisfies MachineAction;
  upper.add(upperHandle);
  root.add(upper);

  // Spray arms (fixed to the tub): a bar plus jet lines.
  const arms: THREE.Group[] = [];
  const jets: THREE.LineSegments[] = [];
  let first = 0;
  MACHINE.arms.forEach((arm) => {
    const count = arm.radii.length * 2;
    const g = new THREE.Group();
    g.position.set(0, arm.y, 0);
    const half = arm.radii[arm.radii.length - 1] + 2;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.8, 2.4), new THREE.MeshStandardMaterial({ color: 0x4f8cff })));
    const jet: number[] = [];
    for (let j = first; j < first + count; j++) {
      const p = nozzles.localPos.subarray(3 * j, 3 * j + 3);
      const dir = nozzles.localDir.subarray(3 * j, 3 * j + 3);
      jet.push(p[0], 0.4, p[2], p[0] + dir[0] * 22, 0.4 + dir[1] * 22, p[2] + dir[2] * 22);
    }
    first += count;
    const jg = new THREE.BufferGeometry();
    jg.setAttribute('position', new THREE.Float32BufferAttribute(jet, 3));
    const lines = new THREE.LineSegments(jg, new THREE.LineBasicMaterial({ color: 0x6cc4ff, transparent: true, opacity: 0.5 }));
    lines.visible = false;
    jets.push(lines);
    g.add(lines);
    root.add(g);
    arms.push(g);
  });

  // The cabinet and door are always see-through, so the inside stays visible.
  for (const m of shellMats) {
    m.transparent = true;
    m.opacity = 0.13;
    m.depthWrite = false;
  }
  // The inner door liner stays faintly visible so an open door still reads as a surface.
  linerMat.transparent = true;
  linerMat.opacity = 0.3;
  linerMat.depthWrite = false;

  return {
    root,
    arms,
    door,
    racks: { lower, upper },
    handles: [handle, lowerHandle, upperHandle],
    setJetsVisible(on) {
      for (const l of jets) l.visible = on;
    },
    update(s) {
      door.rotation.x = (s.door * Math.PI) / 2;
      lower.position.z = s.lower * MACHINE.rackTravel.lower;
      upper.position.z = s.upper * MACHINE.rackTravel.upper;
    },
  };
}
