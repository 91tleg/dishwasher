import * as THREE from 'three';
import { GRID, TUB, type NozzleSet } from './rack';

/**
 * Droplet visuals for the live wash. Purely cosmetic: droplets leave the real nozzle
 * positions and directions, fly ballistically, and splash off the same dish surface
 * samples the evaluator uses. They don't feed back into the score.
 */

const DIM = [GRID.nx, GRID.ny, GRID.nz];
const G = 981; // cm/s^2
const JET_SPEED = 560;
const SPREAD = 0.09; // rad
const RATE = 1100; // droplets / s / nozzle
const MAX = 24000;
const SPLASH_PROB = 0.4;

function dropletTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class WaterFX {
  readonly points: THREE.Points;
  readonly sump: THREE.Mesh;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  /** 0 = jet droplet (can splash), 1 = splash droplet. */
  private kind = new Uint8Array(MAX);
  private n = 0;
  private grid = new Int32Array(DIM[0] * DIM[1] * DIM[2]).fill(-1);
  private normals: Float32Array = new Float32Array(0);
  private prevTheta: number | null = null;
  private carry = 0;

  constructor(private nozzles: NozzleSet) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.9,
        map: dropletTexture(),
        color: 0x9fd8ff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.points.visible = false;

    this.sump = new THREE.Mesh(
      new THREE.PlaneGeometry(TUB.maxX - TUB.minX - 1, TUB.maxZ - TUB.minZ - 1),
      new THREE.MeshStandardMaterial({ color: 0x4aa3e0, transparent: true, opacity: 0.55, roughness: 0.1, depthWrite: false }),
    );
    this.sump.rotation.x = -Math.PI / 2;
    this.sump.position.y = 1.2;
    this.sump.visible = false;
  }

  /** Index dish surface samples into a voxel grid for droplet collisions. */
  setObstacles(pos: Float32Array, nrm: Float32Array) {
    this.grid.fill(-1);
    this.normals = nrm;
    for (let i = 0; i < pos.length / 3; i++) {
      const v = this.voxel(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
      if (v >= 0) this.grid[v] = i;
    }
  }

  private voxel(x: number, y: number, z: number): number {
    if (x < TUB.minX || x > TUB.maxX || z < TUB.minZ || z > TUB.maxZ || y > TUB.height) return -2;
    const ix = Math.floor(x - GRID.minX), iy = Math.floor(y - GRID.minY), iz = Math.floor(z - GRID.minZ);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= DIM[0] || iy >= DIM[1] || iz >= DIM[2]) return -2;
    return (iz * DIM[1] + iy) * DIM[0] + ix;
  }

  start() {
    this.n = 0;
    this.prevTheta = null;
    this.points.visible = true;
    this.sump.visible = true;
  }

  stop() {
    this.n = 0;
    this.points.visible = false;
    this.sump.visible = false;
    this.points.geometry.setDrawRange(0, 0);
  }

  private kill(i: number) {
    const l = --this.n;
    if (i === l) return;
    for (let k = 0; k < 3; k++) {
      this.pos[3 * i + k] = this.pos[3 * l + k];
      this.vel[3 * i + k] = this.vel[3 * l + k];
    }
    this.life[i] = this.life[l];
    this.kind[i] = this.kind[l];
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, kind: number) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
    this.vel[3 * i] = vx; this.vel[3 * i + 1] = vy; this.vel[3 * i + 2] = vz;
    this.life[i] = life;
    this.kind[i] = kind;
  }

  /** Advance by `dt` real seconds with the arm now at angle `theta`. */
  update(dt: number, theta: number) {
    const prev = this.prevTheta ?? theta;
    this.prevTheta = theta;
    const nz = this.nozzles;

    // Emit from every nozzle, spread across the arc the arm swept this frame.
    this.carry += RATE * dt * nz.count;
    const emit = Math.floor(this.carry);
    this.carry -= emit;
    for (let e = 0; e < emit; e++) {
      const j = Math.floor(Math.random() * nz.count);
      const f = Math.random();
      const th = prev + (theta - prev) * f;
      const st = Math.sin(th), ct = Math.cos(th);
      const lp = nz.localPos, ld = nz.localDir, c = nz.center;
      const px = c[3 * j] + lp[3 * j] * ct + lp[3 * j + 2] * st;
      const py = c[3 * j + 1] + lp[3 * j + 1];
      const pz = c[3 * j + 2] - lp[3 * j] * st + lp[3 * j + 2] * ct;
      let dx = ld[3 * j] * ct + ld[3 * j + 2] * st + (Math.random() - 0.5) * 2 * SPREAD;
      let dy = ld[3 * j + 1];
      let dz = -ld[3 * j] * st + ld[3 * j + 2] * ct + (Math.random() - 0.5) * 2 * SPREAD;
      const l = Math.hypot(dx, dy, dz);
      dx /= l; dy /= l; dz /= l;
      const sp = JET_SPEED * (0.85 + Math.random() * 0.3);
      // Already travelled for the part of the frame after it left the nozzle.
      const age = (1 - f) * dt;
      this.spawn(px + dx * sp * age, py + dy * sp * age, pz + dz * sp * age, dx * sp, dy * sp - G * age, dz * sp, 1.2, 0);
    }

    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i--);
        continue;
      }
      const o = 3 * i;
      this.vel[o + 1] -= G * dt;
      let vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
      const dist = Math.hypot(vx, vy, vz) * dt;
      const steps = Math.max(1, Math.ceil(dist / 0.8));
      let dead = false;
      for (let s = 0; s < steps && !dead; s++) {
        this.pos[o] += (vx * dt) / steps;
        this.pos[o + 1] += (vy * dt) / steps;
        this.pos[o + 2] += (vz * dt) / steps;
        const v = this.voxel(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
        if (v === -2) {
          dead = true; // left the tub (or hit the floor/walls)
        } else if (v >= 0 && this.grid[v] >= 0) {
          dead = true;
          if (this.kind[i] === 0 && Math.random() < SPLASH_PROB) this.splash(this.grid[v], this.pos[o], this.pos[o + 1], this.pos[o + 2], vx, vy, vz);
        }
      }
      if (dead) this.kill(i--);
    }

    this.points.geometry.setDrawRange(0, this.n);
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private splash(cell: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const nx = this.normals[3 * cell], ny = this.normals[3 * cell + 1], nz = this.normals[3 * cell + 2];
    // Face the normal against the incoming velocity.
    const sgn = vx * nx + vy * ny + vz * nz > 0 ? -1 : 1;
    const n = [nx * sgn, ny * sgn, nz * sgn];
    const dot = vx * n[0] + vy * n[1] + vz * n[2];
    const rx = vx - 2 * dot * n[0], ry = vy - 2 * dot * n[1], rz = vz - 2 * dot * n[2];
    const count = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < count; k++) {
      const sp = 60 + Math.random() * 120;
      this.spawn(
        x + n[0] * 0.6, y + n[1] * 0.6, z + n[2] * 0.6,
        rx * 0.18 + n[0] * sp * 0.6 + (Math.random() - 0.5) * sp,
        ry * 0.18 + n[1] * sp * 0.6 + (Math.random() - 0.5) * sp,
        rz * 0.18 + n[2] * sp * 0.6 + (Math.random() - 0.5) * sp,
        0.5,
        1,
      );
    }
  }
}
