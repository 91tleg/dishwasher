import * as THREE from 'three';

/** Orientation as a unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

/** Where a dish is: its local origin (centre of its base) and orientation. Units: cm. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  q: Quat;
}

const e = new THREE.Euler();
const q = new THREE.Quaternion();

/** Tilt about x (0 = open side up, 90 = on edge, 180 = upside down), yaw about vertical, roll about the dish's own x... applied as Ry * Rx * Rz. */
export function quatFromEuler(tiltDeg: number, yawDeg: number, rollDeg = 0): Quat {
  const d = Math.PI / 180;
  e.set(tiltDeg * d, yawDeg * d, rollDeg * d, 'YXZ');
  q.setFromEuler(e);
  return [q.x, q.y, q.z, q.w];
}

/** `a` applied after `b` (world-frame rotation `a` of a body already oriented by `b`). */
export function mulQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Row-major 3x3 rotation matrix. */
export function rotationMatrix([x, y, z, w]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export const IDENTITY: Quat = [0, 0, 0, 1];
