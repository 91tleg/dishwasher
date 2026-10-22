import * as THREE from 'three';
import { MACHINE } from './machine';

/** Units: cm. Tub interior, from the machine profile. */
export const TUB = {
  minX: -MACHINE.tub.width / 2,
  maxX: MACHINE.tub.width / 2,
  minZ: -MACHINE.tub.depth / 2,
  maxZ: MACHINE.tub.depth / 2,
  height: MACHINE.tub.height,
};
/** Voxel grid shared with sim-core (must match its constants). It is larger than the tub. */
export const GRID = { minX: -30, minY: 0, minZ: -27.5, nx: 60, ny: 80, nz: 55 };

export const DECK = MACHINE.decks;
export const ARM_RPM = 24;

const TANGENT_TILT = 0.35;

export interface NozzleSet {
  center: Float32Array;
  localPos: Float32Array;
  localDir: Float32Array;
  flow: Float32Array;
  count: number;
}

export function buildNozzles(): NozzleSet {
  const center: number[] = [];
  const lp: number[] = [];
  const ld: number[] = [];
  const flow: number[] = [];
  for (const arm of MACHINE.arms) {
    for (const side of [1, -1]) {
      arm.radii.forEach((r, i) => {
        center.push(0, arm.y, 0);
        lp.push(side * r, 0, 0);
        // Opposite tangential tilt on each side is what spins the arm.
        const d = new THREE.Vector3(side * arm.radialTilt[i], 1, side * TANGENT_TILT).normalize();
        ld.push(d.x, d.y, d.z);
        flow.push(1);
      });
    }
  }
  return {
    center: new Float32Array(center),
    localPos: new Float32Array(lp),
    localDir: new Float32Array(ld),
    flow: new Float32Array(flow),
    count: flow.length,
  };
}
