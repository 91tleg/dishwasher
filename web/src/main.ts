import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildCatalog, type CatalogItem } from './catalog';
import { DEFAULT_CYCLE, PROGRAMS, type Cycle, type ProgramId } from './cycle';
import { buildDishGeometry, buildDishLocal, type DishKind } from './geometry';
import { buildMachine, type MachineAction } from './machine3d';
import { dishColor } from './materials';
import { RackPhysics } from './physics';
import { ARM_RPM, buildNozzles, TUB } from './rack';
import { evaluateLayout, initSim, setCycle, Wash, type DishState, type EvalResult } from './sim';
import { mulQuat, quatFromEuler, type Pose, type Quat } from './transform';
import { WaterFX } from './water';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- scene ----
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12161c);
// A soft environment gives the stainless steel something to reflect.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
camera.position.set(120, 150, 260);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 40, 10);
controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x303844, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(60, 160, 120);
scene.add(sun);

const nozzleSet = buildNozzles();
const machine = buildMachine(nozzleSet);
scene.add(machine.root);
const catalog = buildCatalog();
scene.add(catalog.group);
const fx = new WaterFX(nozzleSet);
scene.add(fx.points, fx.sump);
let visTheta = 0;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // On a tall (phone) screen widen the vertical field of view, so the machine and the wall still fit across.
  const base = 40, wide = 1.4;
  const half = THREE.MathUtils.degToRad(base / 2);
  camera.fov = camera.aspect >= wide ? base : Math.min(80, THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(half) * wide) / camera.aspect)));
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
// The view also changes size when the layout stacks or the phone rotates.
new ResizeObserver(resize).observe(view);
resize();
// No long-press menu on the 3D view.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- state ----
let dishes: DishState[] = [];
let nextId = 100;
let selected: number | null = null;
let result: EvalResult | null = null;
/**
 * Is `result` the live wash (what has actually been cleaned so far), or the pre-wash forecast of a finished
 * wash? Before the wash every dish is dirty, whatever the forecast says.
 */
let resultIsWash = false;
/** Last full-revolution score (has per-dish spray forces); the live wash result doesn't. */
let batch: EvalResult | null = null;
/** Dishes inside the tub that the last score covers, in result order. */
let scored: DishState[] = [];
let wash: Wash | null = null;
let phys: RackPhysics;
/** The load changed and needs re-scoring once everything has come to rest. */
let needsEval = false;
/** Start a wash as soon as the machine has closed itself. */
let washQueued = false;
/** How long, in seconds, we have been waiting for the dishes to come to rest. */
let settleWait = 0;
/** Wait at most this long for a jittering dish (say, one pinched by the door); then go ahead anyway. */
const SETTLE_TIMEOUT = 2.5;
/** Where each dish was when the load was last scored; moving past this invalidates the prediction. */
let scoredPoses = new Map<number, Pose>();

function refreshWashButton() {
  $('wash').textContent = wash ? '■ Stop wash' : washQueued ? '… closing (click to cancel)' : '▶ Start wash';
}
function setWashQueued(v: boolean) {
  washQueued = v;
  refreshWashButton();
}

const rememberLoad = () => (scoredPoses = new Map(dishes.map((d) => [d.id, d.pose])));
/** Has any dish moved noticeably (0.4 cm, 2 degrees) since the load was scored? Tiny jitter doesn't count. */
function loadMoved(): boolean {
  if (scoredPoses.size !== dishes.length) return true;
  for (const d of dishes) {
    const a = scoredPoses.get(d.id);
    if (!a) return true;
    const b = d.pose;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.4) return true;
    const dot = Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]);
    if (dot < 0.9998) return true;
  }
  return false;
}
const meshes = new Map<number, THREE.Mesh>();
/** Translucent water layer per dish, driven by the film model. */
const films = new Map<number, THREE.Mesh>();

function makeMesh(d: DishState): THREE.Mesh {
  const local = buildDishLocal(d.kind);
  const mesh = new THREE.Mesh(
    buildDishGeometry(local),
    new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05 }),
  );
  mesh.userData.id = d.id;
  scene.add(mesh);

  // Water layer: same surface pushed 0.08 cm out along the normals, alpha = film wetness.
  const fg = mesh.geometry.clone();
  const p = fg.getAttribute('position') as THREE.BufferAttribute;
  const nn = fg.getAttribute('normal') as THREE.BufferAttribute;
  for (let v = 0; v < p.count; v++) p.setXYZ(v, p.getX(v) + nn.getX(v) * 0.08, p.getY(v) + nn.getY(v) * 0.08, p.getZ(v) + nn.getZ(v) * 0.08);
  fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.count * 4).fill(0), 4));
  const film = new THREE.Mesh(
    fg,
    new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.05, metalness: 0.1 }),
  );
  film.visible = false;
  scene.add(film);
  films.set(d.id, film);
  return mesh;
}

function heat(c: number, out: THREE.Color) {
  const lo = [214, 69, 61], mid = [232, 184, 58], hi = [63, 191, 106];
  const [a, b, t] = c < 0.5 ? [lo, mid, c * 2] : [mid, hi, (c - 0.5) * 2];
  out.setRGB((a[0] + (b[0] - a[0]) * t) / 255, (a[1] + (b[1] - a[1]) * t) / 255, (a[2] + (b[2] - a[2]) * t) / 255, THREE.SRGBColorSpace);
}

/** Index of a dish in the last score, or -1 if it wasn't part of it (outside the tub). */
const scoreIndex = (id: number) => scored.findIndex((d) => d.id === id);

const tmpColor = new THREE.Color();
function paint() {
  for (const d of dishes) {
    const mesh = meshes.get(d.id);
    if (!mesh) continue;
    const local = buildDishLocal(d.kind);
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const i = result && resultIsWash ? scoreIndex(d.id) : -1;
    for (let v = 0; v < local.nVerts; v++) {
      // Only soiled (inner) cells show cleanliness: red (dirty) until the wash cleans them. Outer surfaces stay china-coloured.
      if (local.weight[v] > 1e-6) heat(i >= 0 ? result!.clean[result!.offsets[i] + v] : 0, tmpColor);
      else tmpColor.set(dishColor(d.kind) ?? local.color);
      col.setXYZ(v, tmpColor.r, tmpColor.g, tmpColor.b);
    }
    col.needsUpdate = true;
  }
}

function paintFilm(r: EvalResult | null) {
  const show = !!r?.film;
  for (const d of dishes) {
    const f = films.get(d.id);
    if (!f) continue;
    const i = r ? scoreIndex(d.id) : -1;
    f.visible = show && i >= 0;
    if (!f.visible) continue;
    const col = f.geometry.getAttribute('color') as THREE.BufferAttribute;
    const base = r!.offsets[i];
    for (let v = 0; v < col.count; v++) col.setXYZW(v, 0.55, 0.8, 1.0, Math.min(0.5, r!.film![base + v] * 0.6));
    col.needsUpdate = true;
  }
}

/** Add / remove meshes to match the dish list, and pose them from each dish's current transform. */
function syncMeshes() {
  for (const [id, m] of meshes) {
    if (!dishes.some((d) => d.id === id)) {
      scene.remove(m);
      m.geometry.dispose();
      meshes.delete(id);
      const f = films.get(id);
      if (f) {
        scene.remove(f);
        f.geometry.dispose();
        films.delete(id);
      }
    }
  }
  for (const d of dishes) {
    let m = meshes.get(d.id);
    if (!m) {
      m = makeMesh(d);
      meshes.set(d.id, m);
      paint();
    }
    const p = d.pose;
    m.position.set(p.x, p.y, p.z);
    m.quaternion.set(...p.q);
    (m.material as THREE.MeshStandardMaterial).emissive.set(d.id === selected ? 0x1a2f55 : 0x000000);
    const f = films.get(d.id)!;
    f.position.copy(m.position);
    f.quaternion.copy(m.quaternion);
  }
}

// ---- evaluation ----
/** Something moved: heatmaps are stale, and the load needs re-scoring once it has settled. */
function markChanged() {
  stopWash();
  if (result || batch) {
    result = null;
    batch = null;
    resultIsWash = false;
    scored = [];
    paint();
    renderStats();
  }
  needsEval = true;
}

/** Only dishes that are actually inside the tub get sprayed and scored. */
const insideTub = (d: DishState) =>
  d.pose.x > TUB.minX - 1 && d.pose.x < TUB.maxX + 1 && d.pose.z > TUB.minZ - 1 && d.pose.z < TUB.maxZ + 1 && d.pose.y > -1 && d.pose.y < TUB.height + 1;

function runEval() {
  needsEval = false;
  scored = dishes.filter(insideTub);
  if (!scored.length) {
    result = null;
    batch = null;
    renderStats();
    setStatus(dishes.length ? 'No dishes are inside the machine.' : 'Pick dishes from the catalog and load the racks.');
    return;
  }
  const t = performance.now();
  result = evaluateLayout(scored);
  resultIsWash = false;
  batch = result;
  rememberLoad();
  setStatus(`scored ${scored.length} dishes (${result.clean.length.toLocaleString()} surface cells) in ${(performance.now() - t).toFixed(0)} ms`);
  paint();
  renderStats();
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function renderStats() {
  const live = resultIsWash;
  const score = $('score');
  score.textContent = result ? result.score.toFixed(3) : '–';
  score.style.color = result && !live ? 'var(--dim)' : '';
  $('resultnote').textContent = !result ? '' : !live ? 'Predicted after a full wash. Everything is dirty until you run it.' : wash ? 'Cleaned so far.' : 'After the wash.';
  $('mean').textContent = result ? pct(result.mean) : '–';
  const worst = result ? [...result.perDish].map((p) => p.mean).sort((a, b) => a - b)[0] : 0;
  $('worst').textContent = result ? pct(worst) : '–';

  const list = $('dishes');
  list.innerHTML = '';
  if (!dishes.length) list.innerHTML = '<span style="color:var(--dim)">Nothing loaded yet.</span>';
  for (const d of dishes) {
    const i = result ? scoreIndex(d.id) : -1;
    const m = i >= 0 ? result!.perDish[i].mean : 0;
    const row = document.createElement('div');
    row.className = 'dish' + (d.id === selected ? ' sel' : '');
    const c = new THREE.Color();
    heat(m, c);
    const bar = live ? `#${c.getHexString(THREE.SRGBColorSpace)}` : '#4b5666';
    row.innerHTML = `<span>${d.kind}</span>
      <div class="bar"><i style="width:${m * 100}%;background:${bar}"></i></div>
      <span style="text-align:right;${live ? '' : 'color:var(--dim)'}">${i >= 0 ? (live ? '' : '~') + pct(m) : insideTub(d) ? '' : 'out'}</span>`;
    row.onclick = () => select(d.id);
    list.appendChild(row);
  }
  renderSelected();
}

function setStatus(s: string) {
  $('status').textContent = s;
}

// ---- selection UI ----
function select(id: number | null) {
  selected = id;
  syncMeshes();
  renderStats();
}

const STEP = 15;
const rotations: Record<string, Quat> = {
  'tilt-': quatFromEuler(-STEP, 0, 0),
  'tilt+': quatFromEuler(STEP, 0, 0),
  'yaw-': quatFromEuler(0, -STEP, 0),
  'yaw+': quatFromEuler(0, STEP, 0),
  'roll-': quatFromEuler(0, 0, -STEP),
  'roll+': quatFromEuler(0, 0, STEP),
  flip: quatFromEuler(180, 0, 0),
};

/** Pick a dish up, turn it in place, and let go: it lifts clear of the wires and drops again. */
function rotateSelected(rot: Quat) {
  const d = dishes.find((x) => x.id === selected);
  if (!d) return;
  markChanged();
  d.pose = { ...d.pose, q: mulQuat(rot, d.pose.q) };
  phys.hold(d.id, d.pose);
  phys.release(d.id);
}

function removeDish(id: number) {
  phys.removeDish(id);
  dishes = dishes.filter((x) => x.id !== id);
  if (selected === id) selected = null;
  syncMeshes();
  markChanged();
  renderStats();
}

function renderSelected() {
  const box = $('sel');
  const d = dishes.find((x) => x.id === selected);
  if (!d) {
    box.innerHTML = '<span style="color:var(--dim)">Click a dish.</span>';
    return;
  }
  const i = scoreIndex(d.id);
  const btn = (k: string, label: string) => `<button data-rot="${k}">${label}</button>`;
  box.innerHTML = `
    <div class="row">
      <span style="color:var(--dim)">${d.kind}</span>
      <button data-act="del">Remove</button>
    </div>
    <div class="row">tilt ${btn('tilt-', '−')}${btn('tilt+', '+')} yaw ${btn('yaw-', '−')}${btn('yaw+', '+')} roll ${btn('roll-', '−')}${btn('roll+', '+')} ${btn('flip', 'flip')}</div>
    ${batch?.forces && i >= 0 ? `<div class="stat"><span>Peak spray force</span><b>${batch.forces[i].peak.toFixed(2)} N</b></div>` : ''}
`;
  box.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => (b.onclick = () => rotateSelected(rotations[b.dataset.rot!])));
  box.querySelector<HTMLButtonElement>('[data-act=del]')!.onclick = () => removeDish(d.id);
}

// ---- machine controls ----
function toggleDoor() {
  stopWash();
  setWashQueued(false);
  if (phys.door.target === 1) phys.closeAll();
  else phys.openDoor();
  needsEval = true;
  updateMachineButtons();
}

function toggleRack(which: 'lower' | 'upper') {
  stopWash();
  setWashQueued(false);
  const out = phys.setRackOut(which, phys[which].target === 0);
  if (!out && phys[which].target === 0) setStatus('Open the door first.');
  needsEval = true;
  updateMachineButtons();
}

function updateMachineButtons() {
  const open = phys.door.target === 1;
  $('door-btn').textContent = open ? 'Close door' : 'Open door';
  const rack = (id: string, which: 'lower' | 'upper', name: string) => {
    const b = $(id) as HTMLButtonElement;
    b.textContent = phys[which].target === 1 ? `Push ${name} rack in` : `Pull ${name} rack out`;
    b.disabled = !open && phys[which].target === 0;
  };
  rack('lower-btn', 'lower', 'lower');
  rack('upper-btn', 'upper', 'upper');
}
$('door-btn').onclick = toggleDoor;
$('lower-btn').onclick = () => toggleRack('lower');
$('upper-btn').onclick = () => toggleRack('upper');

// ---- pick up, move, drop ----
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
interface Held {
  id: number;
  plane: THREE.Plane;
  dx: number;
  dz: number;
  y: number;
  q: Quat;
}
let held: Held | null = null;
const HOLD_MIN_Y = 2;
const HOLD_MAX_Y = TUB.height - 4;
/**
 * Dishes are carried high, above both racks' tines and cup shelves, so wherever you let go it falls onto
 * the rack below the pointer instead of starting under it.
 */
const HOLD_DEFAULT_Y = 66;

/** Shows where a carried dish will land: a line straight down to the first surface, and a ring there. */
const guideLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]),
  new THREE.LineBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.85, depthTest: false }),
);
const guideRing = new THREE.Mesh(
  new THREE.RingGeometry(3, 4, 32),
  new THREE.MeshBasicMaterial({ color: 0xf2c14e, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false }),
);
guideRing.rotation.x = -Math.PI / 2;
const guide = new THREE.Group();
guide.add(guideLine, guideRing);
guide.renderOrder = 10;
guideLine.renderOrder = 10;
guideRing.renderOrder = 10;
guide.visible = false;
scene.add(guide);

function updateGuide() {
  const d = held ? dishes.find((x) => x.id === held!.id) : null;
  if (!held || !d) {
    guide.visible = false;
    return;
  }
  const landing = phys.dropY(held.id);
  if (landing === null) {
    guide.visible = false;
    return;
  }
  guideLine.geometry.setFromPoints([new THREE.Vector3(d.pose.x, d.pose.y, d.pose.z), new THREE.Vector3(d.pose.x, landing, d.pose.z)]);
  guideRing.position.set(d.pose.x, landing + 0.2, d.pose.z);
  guide.visible = true;
}
/** Where a dish can be carried: the room around the machine. */
const REACH = { minX: -105, maxX: 105, minZ: -60, maxZ: 125 };

/** A carried dish rides this far above a finger, in pixels, so the finger doesn't hide it. */
const TOUCH_LIFT = 64;

function pointer(e: PointerEvent, lift = 0) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - lift - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}

/** Move the held dish to the pointer (on the hold-height plane) and tell the physics world. */
function updateHeld(e?: PointerEvent) {
  if (!held) return;
  const d = dishes.find((x) => x.id === held!.id)!;
  let { x, z } = d.pose;
  if (e) {
    pointer(e, e.pointerType === 'touch' ? TOUCH_LIFT : 0);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(held.plane, p)) {
      x = Math.min(REACH.maxX, Math.max(REACH.minX, p.x + held.dx));
      z = Math.min(REACH.maxZ, Math.max(REACH.minZ, p.z + held.dz));
    }
  }
  d.pose = { x, y: held.y, z, q: held.q };
  phys.hold(d.id, d.pose);
  updateGuide();
}

/** Natural orientations for a freshly taken dish: plates on edge, bowls tipped, mugs mouth-down. */
const TAKE: Record<DishKind, Quat> = {
  plate: quatFromEuler(0, 0, -90),
  bowl: quatFromEuler(150, 0, 0),
  mug: quatFromEuler(180, 0, 0),
  // Utensils go in the basket standing up: forks and spoons handle-down, knives blade-down.
  fork: quatFromEuler(0, 0, 90),
  spoon: quatFromEuler(0, 0, 90),
  knife: quatFromEuler(0, 0, -90),
};

function startHold(d: DishState, e: PointerEvent, y: number, grabOffset: boolean) {
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const p = new THREE.Vector3();
  pointer(e);
  ray.ray.intersectPlane(plane, p);
  held = { id: d.id, plane, dx: grabOffset ? d.pose.x - p.x : 0, dz: grabOffset ? d.pose.z - p.z : 0, y, q: d.pose.q };
  updateHeld(e);
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointer(e);
  const targets = [...meshes.values(), ...catalog.items, ...machine.handles];
  const hit = ray.intersectObjects(targets)[0];
  if (!hit) return;
  const o = hit.object;

  // Door and rack handles.
  const action = o.userData.action as MachineAction | undefined;
  if (action) {
    if (action === 'door') toggleDoor();
    else toggleRack(action);
    return;
  }

  // A catalog dish: take a copy and carry it.
  const item = o.userData.catalog as CatalogItem | undefined;
  if (item) {
    stopWash();
    const d: DishState = { id: nextId++, kind: item.kind, pose: { x: 0, y: HOLD_DEFAULT_Y, z: 0, q: TAKE[item.kind] } };
    dishes.push(d);
    phys.addDish(d.id, d.kind, d.pose);
    selected = d.id;
    syncMeshes();
    markChanged();
    startHold(d, e, HOLD_DEFAULT_Y, false);
    renderStats();
    return;
  }

  // A dish already out: pick it up.
  const id = o.userData.id as number;
  const d = dishes.find((x) => x.id === id)!;
  select(id);
  markChanged();
  startHold(d, e, HOLD_DEFAULT_Y, true);
});

renderer.domElement.addEventListener('pointermove', (e) => updateHeld(e));

const drop = () => {
  if (!held) return;
  phys.release(held.id);
  held = null;
  guide.visible = false;
  controls.enabled = true;
  needsEval = true;
};
renderer.domElement.addEventListener('pointerup', drop);
renderer.domElement.addEventListener('pointercancel', drop);

renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (!held) return;
    e.preventDefault();
    held.y = Math.min(HOLD_MAX_Y, Math.max(HOLD_MIN_Y, held.y - e.deltaY * 0.03));
    held.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -held.y);
    updateHeld();
  },
  { passive: false },
);

/** Throw away the carried dish, or the selected one if nothing is being carried. */
function deleteCarriedOrSelected() {
  if (held) {
    const id = held.id;
    held = null;
    guide.visible = false;
    controls.enabled = true;
    removeDish(id);
  } else if (selected !== null) {
    removeDish(selected);
  }
}

/**
 * Turn, raise or lower. Acts on the carried dish when there is one (a second finger can tap these while the
 * first carries), otherwise on the selected dish, which is turned in place and dropped again.
 */
function nudge(k: string) {
  if (k === 'delete') return deleteCarriedOrSelected();
  if (held) {
    if (k === 'up' || k === 'down') {
      held.y = Math.min(HOLD_MAX_Y, Math.max(HOLD_MIN_Y, held.y + (k === 'up' ? 3 : -3)));
      held.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -held.y);
    } else if (rotations[k]) {
      held.q = mulQuat(rotations[k], held.q);
    }
    updateHeld();
  } else if (selected !== null && rotations[k]) {
    rotateSelected(rotations[k]);
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach((b) => (b.onclick = () => nudge(b.dataset.nudge!)));

const KEYS: Record<string, string> = { q: 'yaw-', e: 'yaw+', w: 'tilt-', s: 'tilt+', a: 'roll-', d: 'roll+' };
addEventListener('keydown', (e) => {
  if (!held || e.repeat) return;
  if (e.key.toLowerCase() === 'x') return deleteCarriedOrSelected();
  const k = KEYS[e.key.toLowerCase()];
  if (k) nudge(k);
});

$('clear').onclick = () => {
  stopWash();
  setWashQueued(false);
  phys.clear();
  dishes = [];
  selected = null;
  syncMeshes();
  markChanged();
  renderStats();
};

// ---- cycle settings ----
function readCycle(): Cycle {
  const program = ($('program') as HTMLSelectElement).value as ProgramId;
  return {
    program,
    minutes: PROGRAMS[program].minutes,
    tempC: Number(($('temp') as HTMLSelectElement).value),
    detergent: Number(($('det') as HTMLSelectElement).value),
    splash: true,
    film: true,
  };
}
// Picking a program loads its temperature; the temperature can still be overridden afterwards.
$('program').addEventListener('change', () => {
  const p = PROGRAMS[($('program') as HTMLSelectElement).value as ProgramId];
  ($('temp') as HTMLSelectElement).value = String(p.tempC);
});
for (const id of ['program', 'temp', 'det']) {
  $(id).addEventListener('change', () => {
    setCycle(readCycle());
    markChanged();
  });
}

// ---- live wash ----
function stopWash() {
  if (!wash) return;
  wash.dispose();
  wash = null;
  fx.stop();
  paintFilm(null);
  refreshWashButton();
  ($('washbar') as HTMLElement).style.width = '0';
}

function beginWash() {
  setWashQueued(false);
  scored = dishes.filter(insideTub);
  if (!scored.length) {
    setStatus('Load some dishes into the racks first.');
    return;
  }
  needsEval = false;
  rememberLoad();
  wash = new Wash(scored);
  fx.setObstacles(wash.cellPos, wash.cellNrm);
  fx.start();
  result = wash.snapshot();
  resultIsWash = true;
  paint();
  renderStats();
  refreshWashButton();
}

$('wash').onclick = () => {
  if (wash) {
    // Stop keeps the current heatmap so you can inspect it.
    const snap = wash.snapshot();
    stopWash();
    result = snap;
    resultIsWash = true;
    paint();
    renderStats();
    return;
  }
  if (washQueued) {
    setWashQueued(false);
    return;
  }
  if (!dishes.length) {
    setStatus('Load some dishes into the racks first.');
    return;
  }
  // Seal the machine first: racks in, door shut.
  setWashQueued(true);
  phys.closeAll();
  updateMachineButtons();
  setStatus('Closing the machine…');
};

// ---- loop ----
let last = performance.now();
let washFrame = 0;
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const omega = (ARM_RPM * 2 * Math.PI) / 60;

  if (!wash) {
    // Dishes obey physics, and ride the racks, until the wash starts.
    phys.update(dt);
    for (const d of dishes) {
      if (held?.id === d.id) continue;
      const p = phys.pose(d.id);
      if (p) d.pose = p;
    }
    syncMeshes();

    // A finished wash stays on screen until the load itself is changed: opening the door or sliding a rack
    // moves the dishes, but doesn't un-wash them.
    if ((result || batch) && !resultIsWash && loadMoved()) markChanged();

    // Wait for the dishes to come to rest, but not forever: a dish pinched by the door can jitter indefinitely.
    const waiting = (needsEval || washQueued) && !phys.machineMoving;
    settleWait = waiting && !phys.settled ? settleWait + dt : 0;
    const ready = phys.settled || settleWait > SETTLE_TIMEOUT;
    if (needsEval && ready) {
      if (resultIsWash) needsEval = false;
      else if (phys.racksIn) runEval();
      else if (dishes.length) setStatus('Push the racks in to see the predicted result.');
    }
    if (washQueued && phys.closed && ready) beginWash();
  }
  machine.update({ door: phys.door.value, lower: phys.lower.value, upper: phys.upper.value });
  if (phys.machineMoving) updateMachineButtons();

  // The arms only turn, and only show their jets, while the wash runs. They turn at real speed even
  // when the wash is played faster, so droplets don't strobe.
  if (wash) visTheta += dt * omega;
  for (const a of machine.arms) a.rotation.y = visTheta;
  machine.setJetsVisible(!!wash);
  if (wash) {
    fx.update(dt, visTheta);
    wash.advance(dt * Number(($('speed') as HTMLSelectElement).value), omega);
    ($('washbar') as HTMLElement).style.width = `${(wash.elapsed / wash.duration) * 100}%`;
    $('gt').textContent = `${wash.waterTemp.toFixed(0)} °C`;
    $('gd').textContent = `${wash.detergent.toFixed(2)} dose`;
    if (++washFrame % 6 === 0 || wash.done) {
      result = wash.snapshot();
      resultIsWash = true;
      paint();
      paintFilm(result);
      renderStats();
      setStatus(`washing… ${clock(wash.elapsed)} / ${clock(wash.duration)}`);
    }
    if (wash.done) {
      stopWash();
      setStatus(`wash complete — ${pct(result!.mean)} of soil removed (score ${result!.score.toFixed(3)})`);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function boot() {
  const bytes = await (await fetch(import.meta.env.BASE_URL + 'sim_core.wasm')).arrayBuffer();
  await initSim(bytes);
  setCycle(DEFAULT_CYCLE);
  phys = await RackPhysics.create();
  // Start with the door open and the lower rack pulled out, ready to load.
  phys.openDoor();
  phys.setRackOut('lower', true);
  updateMachineButtons();
  renderStats();
  setStatus('Pick dishes from the catalog on the wall and load the racks.');
  requestAnimationFrame(frame);
}
boot().catch((e) => setStatus(`failed to start: ${e}`));
