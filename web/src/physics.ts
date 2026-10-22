import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildDishLocal, type DishKind } from './geometry';
import { basketHandleRods, basketParts, lowerRackRods, MACHINE, tubBoxes, upperRackRods, type Box, type Rod } from './machine';
import { dishFriction, dishMass } from './materials';
import type { Pose, Quat } from './transform';

/** Rapier works best in metres; the rest of the app uses centimetres. */
const S = 0.01;
const SUBSTEPS = 2;
const FIXED_DT = 1 / 60;
const SUB_DT = FIXED_DT / SUBSTEPS;

/** Seconds for the door to swing, and for a rack to slide. Slow enough that friction carries the dishes. */
const DOOR_SECONDS = 1.4;
const RACK_SECONDS = 1.8;

export type Part = 'door' | 'lower' | 'upper';

/** A 0..1 position that eases toward a target over a fixed time (smoothstep). */
class Channel {
  value = 0;
  private from = 0;
  private to = 0;
  private t = 1;
  constructor(private duration: number) {}

  get target(): number {
    return this.to;
  }
  get moving(): boolean {
    return this.t < 1;
  }
  setTarget(to: number) {
    if (to === this.to) return;
    this.from = this.value;
    this.to = to;
    this.t = 0;
  }
  advance(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    const e = this.t * this.t * (3 - 2 * this.t);
    this.value = this.from + (this.to - this.from) * e;
    if (this.t >= 1) this.value = this.to;
  }
}

interface Entry {
  kind: DishKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  held: boolean;
  quietFrames: number;
}

let initialised: Promise<void> | null = null;

/**
 * Rigid-body world for the whole machine. Fixed: tub walls, base and floor. Moving (kinematic): the door and
 * the two racks, whose wires and tines are the colliders; dishes resting on a rack are carried by friction.
 * Dishes are dynamic bodies with convex-hull colliders, so they rest on the wires and tines and can't overlap.
 */
export class RackPhysics {
  private world: RAPIER.World;
  private dishes = new Map<number, Entry>();
  private acc = 0;
  private doorBody!: RAPIER.RigidBody;
  private rackBody = {} as Record<'lower' | 'upper', RAPIER.RigidBody>;

  readonly door = new Channel(DOOR_SECONDS);
  readonly lower = new Channel(RACK_SECONDS);
  readonly upper = new Channel(RACK_SECONDS);
  /** After the racks are pushed in, close the door. */
  private closeDoorWhenRacksIn = false;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SUB_DT;
    this.world.integrationParameters.numSolverIterations = 8;
    this.addMachine();
  }

  static async create(): Promise<RackPhysics> {
    initialised ??= RAPIER.init();
    await initialised;
    return new RackPhysics();
  }

  private rodCollider(r: Rod): RAPIER.ColliderDesc | null {
    const a = new THREE.Vector3(...r.a).multiplyScalar(S);
    const b = new THREE.Vector3(...r.b).multiplyScalar(S);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-6) return null;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const qn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return RAPIER.ColliderDesc.capsule(len / 2, r.r * S)
      .setTranslation(mid.x, mid.y, mid.z)
      .setRotation({ x: qn.x, y: qn.y, z: qn.z, w: qn.w })
      .setFriction(0.4);
  }

  private boxCollider(bx: Box): RAPIER.ColliderDesc {
    return RAPIER.ColliderDesc.cuboid(bx.half[0] * S, bx.half[1] * S, bx.half[2] * S)
      .setTranslation(bx.center[0] * S, bx.center[1] * S, bx.center[2] * S)
      .setFriction(0.4);
  }

  private addMachine() {
    // Fixed shell: tub sides, back, ceiling, base block, room floor.
    for (const b of tubBoxes()) this.world.createCollider(this.boxCollider(b));

    // Racks: kinematic bodies at the origin; their colliders are in rack coordinates, so with the body at
    // z = 0 everything sits where the geometry says, and sliding is just translating the body along z.
    const makeRack = (rods: Rod[], extra: (body: RAPIER.RigidBody) => void) => {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      for (const r of rods) {
        const d = this.rodCollider(r);
        if (d) this.world.createCollider(d, body);
      }
      extra(body);
      return body;
    };
    this.rackBody.lower = makeRack([...lowerRackRods(), ...basketHandleRods()], (body) => {
      for (const part of basketParts()) this.world.createCollider(this.boxCollider(part), body);
    });
    this.rackBody.upper = makeRack(upperRackRods(), () => {});

    // Door: hinged at the bottom edge. Body origin is the hinge; the slab sits above and slightly in front of it.
    const d = MACHINE.door;
    this.doorBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, d.hingeY * S, d.hingeZ * S),
    );
    this.world.createCollider(
      this.boxCollider({ center: [0, d.height / 2, d.thickness / 2], half: [MACHINE.cabinet.halfX, d.height / 2, d.thickness / 2] }),
      this.doorBody,
    );
  }

  // ---- opening and closing ----

  /** Open the door (racks stay where they are). */
  openDoor() {
    this.closeDoorWhenRacksIn = false;
    this.door.setTarget(1);
  }

  /** Push the racks in, then close the door. */
  closeAll() {
    this.lower.setTarget(0);
    this.upper.setTarget(0);
    this.closeDoorWhenRacksIn = true;
  }

  /** Slide a rack out (needs the door open) or back in. Returns false if the door is in the way. */
  setRackOut(which: 'lower' | 'upper', out: boolean): boolean {
    if (out && this.door.target < 1) return false;
    this[which].setTarget(out ? 1 : 0);
    return true;
  }

  get racksIn(): boolean {
    return this.lower.value === 0 && this.upper.value === 0;
  }
  get doorClosed(): boolean {
    return this.door.value === 0 && this.door.target === 0;
  }
  /** Fully sealed and ready to wash. */
  get closed(): boolean {
    return this.doorClosed && this.racksIn && !this.door.moving;
  }
  get machineMoving(): boolean {
    return this.door.moving || this.lower.moving || this.upper.moving || this.closeDoorWhenRacksIn;
  }

  private advanceMachine(dt: number) {
    const moving = this.machineMoving;
    this.door.advance(dt);
    this.lower.advance(dt);
    this.upper.advance(dt);
    if (this.closeDoorWhenRacksIn && this.racksIn && !this.lower.moving && !this.upper.moving) {
      this.closeDoorWhenRacksIn = false;
      this.door.setTarget(0);
    }
    if (!moving && !this.machineMoving) return;
    this.doorBody.setNextKinematicRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (this.door.value * Math.PI) / 2));
    this.rackBody.lower.setNextKinematicTranslation({ x: 0, y: 0, z: this.lower.value * MACHINE.rackTravel.lower * S });
    this.rackBody.upper.setNextKinematicTranslation({ x: 0, y: 0, z: this.upper.value * MACHINE.rackTravel.upper * S });
    // Sleeping dishes resting on a moving rack must wake up and ride along.
    for (const e of this.dishes.values()) if (!e.held) e.body.wakeUp();
  }

  // ---- dishes ----

  /** Convex hull of a dish's shell, thinned to ~24 samples around so the hull stays small. */
  private hullPoints(kind: DishKind): Float32Array {
    const l = buildDishLocal(kind);
    const step = Math.max(1, Math.round(l.nPhi / 24));
    const pts: number[] = [];
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < l.nRings; i++) {
        for (let j = 0; j < l.nPhi; j += step) {
          const v = side * l.nRings * l.nPhi + i * l.nPhi + j;
          pts.push(l.pos[3 * v] * S, l.pos[3 * v + 1] * S, l.pos[3 * v + 2] * S);
        }
      }
    }
    return new Float32Array(pts);
  }

  /** Mass, centre of mass and inertia of a thin shell (not the solid hull), from the dish's surface samples. */
  private massProps(kind: DishKind, mass: number) {
    const l = buildDishLocal(kind);
    const perSide = l.nRings * l.nPhi;
    let a = 0, cx = 0, cy = 0, cz = 0;
    for (let v = 0; v < perSide; v++) {
      a += l.area[v];
      cx += l.area[v] * l.pos[3 * v];
      cy += l.area[v] * l.pos[3 * v + 1];
      cz += l.area[v] * l.pos[3 * v + 2];
    }
    cx /= a; cy /= a; cz /= a;
    let ixx = 0, iyy = 0, izz = 0;
    for (let v = 0; v < perSide; v++) {
      const m = (mass * l.area[v]) / a;
      const x = (l.pos[3 * v] - cx) * S, y = (l.pos[3 * v + 1] - cy) * S, z = (l.pos[3 * v + 2] - cz) * S;
      ixx += m * (y * y + z * z);
      iyy += m * (x * x + z * z);
      izz += m * (x * x + y * y);
    }
    return {
      com: { x: cx * S, y: cy * S, z: cz * S },
      inertia: { x: Math.max(ixx, 1e-7), y: Math.max(iyy, 1e-7), z: Math.max(izz, 1e-7) },
    };
  }

  addDish(id: number, kind: DishKind, pose: Pose) {
    this.removeDish(id);
    const mass = dishMass(kind);
    const props = this.massProps(kind, mass);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pose.x * S, pose.y * S, pose.z * S)
        .setRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] })
        .setCcdEnabled(true)
        .setLinearDamping(0.4)
        .setAngularDamping(1.0),
    );
    const hull = RAPIER.ColliderDesc.convexHull(this.hullPoints(kind));
    if (!hull) throw new Error(`could not build collider for ${kind}`);
    const collider = this.world.createCollider(
      hull
        .setMassProperties(mass, props.com, props.inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(dishFriction(kind))
        .setRestitution(0.05),
      body,
    );
    this.dishes.set(id, { kind, body, collider, held: false, quietFrames: 0 });
  }

  removeDish(id: number) {
    const e = this.dishes.get(id);
    if (!e) return;
    this.world.removeRigidBody(e.body);
    this.dishes.delete(id);
  }

  /** Teleport a dish (no velocity). */
  setPose(id: number, pose: Pose) {
    const e = this.dishes.get(id);
    if (!e) return;
    e.body.setTranslation({ x: pose.x * S, y: pose.y * S, z: pose.z * S }, true);
    e.body.setRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] }, true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Pick a dish up: it follows the pointer and ignores collisions until released. */
  hold(id: number, pose: Pose) {
    const e = this.dishes.get(id);
    if (!e) return;
    if (!e.held) {
      e.held = true;
      e.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      e.collider.setCollisionGroups(0);
    }
    const t = { x: pose.x * S, y: pose.y * S, z: pose.z * S };
    const r = { x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] };
    // Set the pose now (so release() sees it) and as the next kinematic target.
    e.body.setTranslation(t, true);
    e.body.setRotation(r, true);
    e.body.setNextKinematicTranslation(t);
    e.body.setNextKinematicRotation(r);
  }

  /**
   * Height of the first surface under a held dish: what it would land on. A small flat plate is cast straight
   * down rather than a ray, because a ray slips between the rack wires.
   */
  dropY(id: number): number | null {
    const e = this.dishes.get(id);
    if (!e) return null;
    const t = e.body.translation();
    const hit = this.world.castShape(
      t,
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: -1, z: 0 },
      new RAPIER.Cuboid(0.04, 0.001, 0.04),
      0,
      5,
      true,
      undefined,
      undefined,
      e.collider,
    );
    return hit ? (t.y - hit.time_of_impact) / S : null;
  }

  /** How far the dish's lowest point is below its origin, in its current orientation (cm, >= 0). */
  private depthBelowOrigin(e: Entry): number {
    const r = e.body.rotation();
    const l = buildDishLocal(e.kind);
    // y row of the rotation matrix for quaternion (x, y, z, w).
    const ry = [2 * (r.x * r.y + r.z * r.w), 1 - 2 * (r.x * r.x + r.z * r.z), 2 * (r.y * r.z - r.x * r.w)];
    let minY = 0;
    for (let v = 0; v < l.nVerts; v++) {
      const y = ry[0] * l.pos[3 * v] + ry[1] * l.pos[3 * v + 1] + ry[2] * l.pos[3 * v + 2];
      if (y < minY) minY = y;
    }
    return -minY;
  }

  /**
   * Let go. The dish is first lowered to just above whatever is under it (so it does not drop from carry height
   * and tumble off the rack), then lifted clear of anything it overlaps, then falls the last bit.
   */
  release(id: number) {
    const e = this.dishes.get(id);
    if (!e || !e.held) return;
    const t = e.body.translation();
    const landing = this.dropY(id);
    e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    e.collider.setCollisionGroups(0xffffffff);
    let y = t.y;
    if (landing !== null) y = Math.min(y, (landing + this.depthBelowOrigin(e) + 1) * S);
    for (let i = 0; i < 120; i++) {
      const hit = this.world.intersectionWithShape({ x: t.x, y, z: t.z }, e.body.rotation(), e.collider.shape, undefined, undefined, e.collider);
      if (!hit) break;
      y += 0.005;
    }
    e.body.setTranslation({ x: t.x, y, z: t.z }, true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    e.held = false;
    e.quietFrames = 0;
  }

  /** Advance by `dt` real seconds in fixed steps. */
  update(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= FIXED_DT) {
      for (let i = 0; i < SUBSTEPS; i++) {
        this.advanceMachine(SUB_DT);
        this.world.step();
      }
      this.acc -= FIXED_DT;
      for (const e of this.dishes.values()) {
        if (e.held) continue;
        const v = e.body.linvel(), w = e.body.angvel();
        const quiet = v.x * v.x + v.y * v.y + v.z * v.z < 1e-4 && w.x * w.x + w.y * w.y + w.z * w.z < 4e-2;
        e.quietFrames = quiet ? e.quietFrames + 1 : 0;
      }
    }
  }

  /** Run the simulation for `seconds` of simulated time (used in tests). */
  settle(seconds: number) {
    const n = Math.ceil(seconds / FIXED_DT);
    for (let i = 0; i < n; i++) this.update(FIXED_DT);
  }

  /** True when no dish is held, the machine isn't moving, and every dish has been nearly still for a moment. */
  get settled(): boolean {
    if (this.machineMoving) return false;
    for (const e of this.dishes.values()) if (e.held || e.quietFrames < 20) return false;
    return true;
  }

  pose(id: number): Pose | null {
    const e = this.dishes.get(id);
    if (!e) return null;
    const t = e.body.translation(), r = e.body.rotation();
    return { x: t.x / S, y: t.y / S, z: t.z / S, q: [r.x, r.y, r.z, r.w] as Quat };
  }

  get ids(): number[] {
    return [...this.dishes.keys()];
  }

  /** Remove every dish. */
  clear() {
    for (const id of this.ids) this.removeDish(id);
  }

  dispose() {
    this.world.free();
  }
}
