//! Fast spray-exposure evaluator.
//!
//! Units are centimetres. The tub is a fixed voxel grid; every dish surface
//! sample ("cell") is splatted into it so jets can be ray-marched for occlusion.
//! Model: a rotating spray arm sweeps jet cones; each cell accumulates
//! `flow * cone_profile * cos(incidence) * distance_falloff` over one arm
//! revolution, then `clean = 1 - exp(-k * exposure / adhesion)`.
//!
//! `accumulate` adds the exposure for one arm angle, so the same code serves the
//! batch evaluator (one revolution) and the real-time wash (a few angles per frame).
//!
//! `finalize` turns accumulated direct exposure into cleanliness, adding the effects
//! that depend on where water goes after it hits:
//!   * splash: a fraction of each impact re-emits as a few rays (one specular, three
//!     diffuse) that land on other surfaces, lighting up places the jets never reach;
//!   * water film: impact water is routed downhill over the dish surface; thickness
//!     follows a Nusselt film (h ~ (Q / sin a)^(1/3)). A thick film cushions direct
//!     impact (pools in upward-facing bowls) while a flowing film adds wall shear;
//!   * temperature and detergent enter as one time-integrated rate multiplier (`mint`)
//!     supplied by the caller, because they act on every wetted cell alike.
//! All spatial terms use steady flux rates; the wash integrates time through `mint`.

const TUB_MIN: [f32; 3] = [-30.0, 0.0, -27.5];
const TUB_DIM: [usize; 3] = [60, 80, 55];
const VOXEL: f32 = 1.0;

const CONE_DEG: f32 = 22.0;
const SIGMA_DEG: f32 = 11.0;
const D0: f32 = 30.0;
const MAX_RANGE: f32 = 70.0;
const REF_STEPS: f32 = 36.0;
/// Skip occlusion tests for cells the jet barely touches.
const MIN_CONTRIB: f32 = 0.01;
const MARCH_STEP: f32 = 1.0;
const SELF_CLEARANCE: f32 = 1.4;

pub const FLAG_SPLASH: u32 = 1;
pub const FLAG_FILM: u32 = 2;
const SPLASH_FRAC: f32 = 0.5;
const SPLASH_MIN_FLUX: f32 = 5e-4;
const SPLASH_RANGE: f32 = 25.0;
const SPLASH_REACH: f32 = 16.0;
/// Splashed water falls back: upward-facing surfaces open to the air above get this fraction of the average spray flux.
const RAIN_FRAC: f32 = 0.5;
/// Scales routed flux into film-thickness units.
const FILM_SCALE: f32 = 100.0;
const FILM_MAX: f32 = 6.0;
/// Film thickness at which direct impact is halved-ish.
const FILM_CUSHION: f32 = 2.5;
/// Flux below which a cell counts as dry.
const FILM_WET: f32 = 2e-4;
const K_SHEAR: f32 = 0.4;
/// How much of a jet's tangential momentum cleans, relative to its normal impact.
const SHEAR_GAIN: f32 = 0.35;

/// Thrust of one nozzle in newtons: ~24 L/min through 22 nozzles at 5.6 m/s, rho*Q*v = 0.10 N.
const NOZZLE_THRUST_N: f32 = 0.10;
const REF_DISTANCE: f32 = 20.0;

pub struct Cells<'a> {
    pub pos: &'a [f32],
    pub nrm: &'a [f32],
    pub weight: &'a [f32],
    /// Surface area of each cell in cm^2.
    pub area: &'a [f32],
    pub adhesion: &'a [f32],
    pub dish: &'a [u32],
    /// Four surface neighbours per cell (cell indices, -1 if none).
    pub nbr: &'a [i32],
}

pub struct Nozzles<'a> {
    pub center: &'a [f32],
    pub local_pos: &'a [f32],
    pub local_dir: &'a [f32],
    pub flow: &'a [f32],
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Stats {
    pub mean: f32,
    pub worst10: f32,
    pub collisions: f32,
    pub score: f32,
}

/// Occupancy grid plus a bounding sphere per dish (cells of a dish are contiguous).
pub struct Scene {
    /// Cell index + 1 of the sample that claimed each voxel, 0 = empty.
    occ: Vec<u32>,
    runs: Vec<Run>,
    pub collisions: u32,
}

struct Run {
    start: usize,
    end: usize,
    c: [f32; 3],
    r: f32,
}

#[inline]
fn voxel_index(p: [f32; 3]) -> Option<usize> {
    let ix = ((p[0] - TUB_MIN[0]) / VOXEL).floor();
    let iy = ((p[1] - TUB_MIN[1]) / VOXEL).floor();
    let iz = ((p[2] - TUB_MIN[2]) / VOXEL).floor();
    if ix < 0.0 || iy < 0.0 || iz < 0.0 {
        return None;
    }
    let (ix, iy, iz) = (ix as usize, iy as usize, iz as usize);
    if ix >= TUB_DIM[0] || iy >= TUB_DIM[1] || iz >= TUB_DIM[2] {
        return None;
    }
    Some((iz * TUB_DIM[1] + iy) * TUB_DIM[0] + ix)
}

pub fn build_scene(cells: &Cells) -> Scene {
    let n = cells.weight.len();
    let mut occ = vec![0u32; TUB_DIM[0] * TUB_DIM[1] * TUB_DIM[2]];
    let mut collisions = 0u32;
    for i in 0..n {
        let p = [cells.pos[3 * i], cells.pos[3 * i + 1], cells.pos[3 * i + 2]];
        match voxel_index(p) {
            None => collisions += 1,
            Some(v) => {
                if occ[v] == 0 {
                    occ[v] = i as u32 + 1;
                } else if cells.dish[occ[v] as usize - 1] != cells.dish[i] {
                    collisions += 1;
                }
            }
        }
    }

    let mut runs = Vec::new();
    let mut s = 0;
    while s < n {
        let mut e = s;
        while e < n && cells.dish[e] == cells.dish[s] {
            e += 1;
        }
        let mut c = [0f32; 3];
        for i in s..e {
            for a in 0..3 {
                c[a] += cells.pos[3 * i + a];
            }
        }
        let m = (e - s) as f32;
        c = [c[0] / m, c[1] / m, c[2] / m];
        let mut r2 = 0f32;
        for i in s..e {
            let d = [cells.pos[3 * i] - c[0], cells.pos[3 * i + 1] - c[1], cells.pos[3 * i + 2] - c[2]];
            r2 = r2.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        }
        runs.push(Run { start: s, end: e, c, r: r2.sqrt() + 0.5 });
        s = e;
    }
    Scene { occ, runs, collisions }
}

/// Add the exposure from the arm at angle `theta`, each nozzle weighted by `w`.
/// `smear` widens the jets to hide aliasing when the arm is swept in few steps.
pub fn accumulate(
    cells: &Cells,
    noz: &Nozzles,
    scene: &Scene,
    theta: f32,
    w: f32,
    smear: f32,
    exposure: &mut [f32],
    mut force: Option<&mut [f32]>,
) {
    let cone = (CONE_DEG * smear).to_radians();
    let cos_cone2 = cone.cos().powi(2);
    let sigma = (SIGMA_DEG * smear).to_radians();
    let (st, ct) = theta.sin_cos();

    for j in 0..noz.flow.len() {
        let lp = &noz.local_pos[3 * j..3 * j + 3];
        let ld = &noz.local_dir[3 * j..3 * j + 3];
        let c = &noz.center[3 * j..3 * j + 3];
        let np = [
            c[0] + lp[0] * ct + lp[2] * st,
            c[1] + lp[1],
            c[2] - lp[0] * st + lp[2] * ct,
        ];
        let nd = [ld[0] * ct + ld[2] * st, ld[1], -ld[0] * st + ld[2] * ct];
        let flow = noz.flow[j] * w;

        for run in &scene.runs {
            // Cull whole dishes whose bounding sphere lies outside the jet cone.
            let v = [run.c[0] - np[0], run.c[1] - np[1], run.c[2] - np[2]];
            let dist = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if dist - run.r > MAX_RANGE {
                continue;
            }
            if dist > run.r {
                let ang = ((v[0] * nd[0] + v[1] * nd[1] + v[2] * nd[2]) / dist).clamp(-1.0, 1.0).acos();
                if ang - (run.r / dist).asin() > cone {
                    continue;
                }
            }

            for i in run.start..run.end {
                let vx = cells.pos[3 * i] - np[0];
                let vy = cells.pos[3 * i + 1] - np[1];
                let vz = cells.pos[3 * i + 2] - np[2];
                let d2 = vx * vx + vy * vy + vz * vz;
                if d2 < 1.0 || d2 > MAX_RANGE * MAX_RANGE {
                    continue;
                }
                // Cone test without sqrt: dot > 0 and dot^2 > cos^2 * |v|^2.
                let dotp = vx * nd[0] + vy * nd[1] + vz * nd[2];
                if dotp <= 0.0 || dotp * dotp < cos_cone2 * d2 {
                    continue;
                }
                let d = d2.sqrt();
                let u = [vx / d, vy / d, vz / d];
                let facing = -(u[0] * cells.nrm[3 * i]
                    + u[1] * cells.nrm[3 * i + 1]
                    + u[2] * cells.nrm[3 * i + 2]);
                if facing <= 0.0 {
                    continue;
                }

                let ang = (dotp / d).min(1.0).acos();
                let profile = (-(ang / sigma) * (ang / sigma)).exp();
                let falloff = 1.0 / (1.0 + (d / D0) * (d / D0));
                // Normal impact (cos) plus tangential shear from the water spreading along the surface (sin):
                // a jet at a shallow angle still scrubs a steep wall.
                let normal = profile * facing * falloff;
                let contrib = profile * (facing + SHEAR_GAIN * (1.0 - facing * facing).max(0.0).sqrt()) * falloff;
                if contrib < MIN_CONTRIB {
                    continue;
                }

                // Ray-march toward the cell; any occupied voxel on the way blocks it.
                let mut blocked = false;
                let mut t = MARCH_STEP;
                let end = d - SELF_CLEARANCE;
                while t < end {
                    let p = [np[0] + u[0] * t, np[1] + u[1] * t, np[2] + u[2] * t];
                    if let Some(v) = voxel_index(p) {
                        if scene.occ[v] != 0 {
                            blocked = true;
                            break;
                        }
                    }
                    t += MARCH_STEP;
                }
                if !blocked {
                    exposure[i] += flow * contrib;
                    if let Some(f) = force.as_deref_mut() {
                        // Instantaneous push along the inward normal; scaled to newtons by the caller.
                        let d = cells.dish[i] as usize;
                        let a = noz.flow[j] * normal * cells.area[i];
                        f[3 * d] -= a * cells.nrm[3 * i];
                        f[3 * d + 1] -= a * cells.nrm[3 * i + 1];
                        f[3 * d + 2] -= a * cells.nrm[3 * i + 2];
                    }
                }
            }
        }
    }
}

/// Direct-spray flux plus everything that happens to the water afterwards.
pub struct Physics {
    /// Impact rate constant.
    pub k: f32,
    pub flags: u32,
    /// Time-integrated temperature x detergent multiplier (1 = reference cycle).
    pub mint: f32,
}

#[inline]
fn voxel_cell(scene: &Scene, p: [f32; 3]) -> Option<usize> {
    voxel_index(p).and_then(|v| {
        let c = scene.occ[v];
        if c == 0 {
            None
        } else {
            Some(c as usize - 1)
        }
    })
}

/// One splash bounce: re-emit part of each impact as rays and deposit it where they land.
/// Only every `stride`-th cell emits (carrying `stride` times the flux): neighbouring cells are
/// 0.8 cm apart and their splash lands in overlapping spots anyway.
fn splash(cells: &Cells, scene: &Scene, flux: &[f32], min_flux: f32, stride: usize) -> Vec<f32> {
    let n = flux.len();
    let mut out = vec![0f32; n];
    // Cosine-weighted hemisphere samples (u1, u2), fixed so results are deterministic.
    const DIFFUSE: [(f32, f32); 3] = [(0.25, 0.0), (0.5, 0.33), (0.75, 0.66)];
    const W_SPEC: f32 = 0.4;
    const W_DIFF: f32 = 0.2;

    for i in (0..n).step_by(stride) {
        if flux[i] < min_flux {
            continue;
        }
        let p = [cells.pos[3 * i], cells.pos[3 * i + 1], cells.pos[3 * i + 2]];
        let nn = [cells.nrm[3 * i], cells.nrm[3 * i + 1], cells.nrm[3 * i + 2]];

        // Incoming direction ~ from the arm's centre, mirrored about the surface.
        let mut u = [p[0], p[1] - 7.0, p[2]];
        let ul = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt().max(1e-3);
        u = [u[0] / ul, u[1] / ul, u[2] / ul];
        let un = u[0] * nn[0] + u[1] * nn[1] + u[2] * nn[2];
        let spec = [u[0] - 2.0 * un * nn[0], u[1] - 2.0 * un * nn[1], u[2] - 2.0 * un * nn[2]];

        // Tangent frame around the normal.
        let a = if nn[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let mut t1 = [nn[1] * a[2] - nn[2] * a[1], nn[2] * a[0] - nn[0] * a[2], nn[0] * a[1] - nn[1] * a[0]];
        let tl = (t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]).sqrt().max(1e-6);
        t1 = [t1[0] / tl, t1[1] / tl, t1[2] / tl];
        let t2 = [nn[1] * t1[2] - nn[2] * t1[1], nn[2] * t1[0] - nn[0] * t1[2], nn[0] * t1[1] - nn[1] * t1[0]];

        let mut dirs = [(spec, W_SPEC); 4];
        for (r, &(u1, u2)) in DIFFUSE.iter().enumerate() {
            let (rr, ph) = (u1.sqrt(), std::f32::consts::TAU * u2);
            let z = (1.0 - u1).sqrt();
            let (c, s) = (rr * ph.cos(), rr * ph.sin());
            dirs[r + 1] = (
                [t1[0] * c + t2[0] * s + nn[0] * z, t1[1] * c + t2[1] * s + nn[1] * z, t1[2] * c + t2[2] * s + nn[2] * z],
                W_DIFF,
            );
        }

        for &(d, wray) in &dirs {
            if d[0] * nn[0] + d[1] * nn[1] + d[2] * nn[2] <= 0.0 {
                continue;
            }
            let mut t = 1.5;
            while t < SPLASH_RANGE {
                let q = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
                if let Some(j) = voxel_cell(scene, q) {
                    let facing = -(d[0] * cells.nrm[3 * j] + d[1] * cells.nrm[3 * j + 1] + d[2] * cells.nrm[3 * j + 2]);
                    if facing > 0.2 && j != i {
                        let amt = stride as f32 * SPLASH_FRAC * flux[i] * wray * facing / (1.0 + (t / SPLASH_REACH) * (t / SPLASH_REACH));
                        // Spread over the hit sample and its surface neighbours to avoid speckle.
                        out[j] += amt * 0.4;
                        for k in 0..4 {
                            let nb = cells.nbr[4 * j + k];
                            if nb >= 0 {
                                out[nb as usize] += amt * 0.15;
                            }
                        }
                    }
                    break;
                }
                t += MARCH_STEP;
            }
        }
    }
    out
}

/// Water that splashed up falls back down. Each upward-facing cell with nothing above it (checked by marching
/// up to the ceiling) gets `RAIN_FRAC` of the scene's average flux, scaled by how squarely it faces up.
fn rain(cells: &Cells, scene: &Scene, flux: &[f32]) -> Vec<f32> {
    let n = flux.len();
    let mut out = vec![0f32; n];
    let (mut sum, mut count) = (0.0f32, 0usize);
    for i in 0..n {
        if cells.weight[i] > 1e-6 {
            sum += flux[i];
            count += 1;
        }
    }
    if count == 0 {
        return out;
    }
    let mean = sum / count as f32;
    for i in 0..n {
        let ny = cells.nrm[3 * i + 1];
        if ny < 0.2 {
            continue;
        }
        let mut p = [
            cells.pos[3 * i] + cells.nrm[3 * i] * 1.4,
            cells.pos[3 * i + 1] + cells.nrm[3 * i + 1] * 1.4,
            cells.pos[3 * i + 2] + cells.nrm[3 * i + 2] * 1.4,
        ];
        let mut open = true;
        while p[1] < TUB_MIN[1] + TUB_DIM[1] as f32 * VOXEL {
            if let Some(v) = voxel_index(p) {
                if scene.occ[v] != 0 {
                    open = false;
                    break;
                }
            }
            p[1] += MARCH_STEP;
        }
        if open {
            out[i] = RAIN_FRAC * mean * ny;
        }
    }
    out
}

/// Turn accumulated, time-weighted direct exposure `g` into cleanliness. Returns (mean, worst10).
/// `out_film`, if given, receives a 0..1 wetness per cell for rendering (film thickness, gated by dryness).
pub fn finalize(
    cells: &Cells,
    scene: &Scene,
    g: &[f32],
    ph: &Physics,
    out_clean: &mut [f32],
    mut out_film: Option<&mut [f32]>,
) -> (f32, f32) {
    let n = cells.weight.len();
    let mint = ph.mint.max(1e-6);
    let flux: Vec<f32> = g.iter().map(|&x| x / mint).collect();

    // Two bounces: water that splashed once can splash again off what it hit. Then the spray that went up comes
    // back down as rain on anything facing up with a clear view of the ceiling.
    let fs = if ph.flags & FLAG_SPLASH != 0 {
        let mut first = splash(cells, scene, &flux, SPLASH_MIN_FLUX, 2);
        let second = splash(cells, scene, &first, SPLASH_MIN_FLUX * 0.4, 4);
        for i in 0..n {
            first[i] += second[i];
        }
        let rain = rain(cells, scene, &flux);
        for i in 0..n {
            first[i] += rain[i];
        }
        first
    } else {
        vec![0.0; n]
    };

    let mut cushion = vec![1.0f32; n];
    let mut tau = vec![0.0f32; n];
    if ph.flags & FLAG_FILM != 0 {
        // Route water downhill: highest cells first, each passes its throughput to its lowest neighbour.
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_unstable_by(|&a, &b| cells.pos[3 * b + 1].partial_cmp(&cells.pos[3 * a + 1]).unwrap());
        let mut q: Vec<f32> = (0..n).map(|i| flux[i] + fs[i]).collect();
        for &i in &order {
            let ny = cells.nrm[3 * i + 1];
            if ny < -0.3 {
                continue; // underside: water drips off instead of running along it
            }
            let y = cells.pos[3 * i + 1];
            let mut best = -1i32;
            let mut best_y = y - 0.05;
            for k in 0..4 {
                let nb = cells.nbr[4 * i + k];
                if nb >= 0 && cells.pos[3 * nb as usize + 1] < best_y {
                    best_y = cells.pos[3 * nb as usize + 1];
                    best = nb;
                }
            }
            if best >= 0 {
                q[best as usize] += q[i];
            }
        }
        for i in 0..n {
            let ny = cells.nrm[3 * i + 1];
            if ny < -0.3 {
                continue;
            }
            let sin_a = (1.0 - ny * ny).max(0.0).sqrt().max(0.08);
            let h = (FILM_SCALE * q[i] / sin_a).cbrt().min(FILM_MAX);
            let wet = q[i] / (q[i] + FILM_WET);
            cushion[i] = 1.0 / (1.0 + (h / FILM_CUSHION) * (h / FILM_CUSHION));
            tau[i] = h * (1.0 - ny * ny).max(0.0).sqrt() * wet;
            if let Some(f) = out_film.as_deref_mut() {
                f[i] = (h / 3.0).min(1.0) * wet;
            }
        }
    }

    let mut wsum = 0.0f32;
    let mut csum = 0.0f32;
    for i in 0..n {
        let x = mint * (ph.k * (cushion[i] * flux[i] + fs[i]) + K_SHEAR * tau[i]) / cells.adhesion[i];
        let c = 1.0 - (-x).exp();
        out_clean[i] = c;
        wsum += cells.weight[i];
        csum += cells.weight[i] * c;
    }
    let mean = if wsum > 0.0 { csum / wsum } else { 0.0 };

    // Worst 10% by soil weight: the dirtiest cells hold the line for the score.
    let mut order: Vec<usize> = (0..n).filter(|&i| cells.weight[i] > 1e-6).collect();
    order.sort_unstable_by(|&a, &b| out_clean[a].partial_cmp(&out_clean[b]).unwrap());
    let budget = wsum * 0.10;
    let (mut acc_w, mut acc_c) = (0.0f32, 0.0f32);
    for &i in &order {
        if acc_w >= budget {
            break;
        }
        acc_w += cells.weight[i];
        acc_c += cells.weight[i] * out_clean[i];
    }
    (mean, if acc_w > 0.0 { acc_c / acc_w } else { 0.0 })
}

/// Newtons per unit of `flow * contrib * area`, from momentum balance: a flat plate square-on to one
/// nozzle that intercepts the whole jet at `REF_DISTANCE` must feel that nozzle's full thrust.
pub fn force_scale() -> f32 {
    let sigma = SIGMA_DEG.to_radians();
    let r_max = REF_DISTANCE * CONE_DEG.to_radians().tan();
    let n = 400;
    let dr = r_max / n as f32;
    let mut integral = 0.0f32;
    for k in 0..n {
        let r = (k as f32 + 0.5) * dr;
        let d = (r * r + REF_DISTANCE * REF_DISTANCE).sqrt();
        let ang = (r / REF_DISTANCE).atan();
        let fall = (-(ang / sigma) * (ang / sigma)).exp() / (1.0 + (d / D0) * (d / D0));
        let normal = fall * ang.cos();
        // Same cutoff as `accumulate` (which includes the shear term), so the calibration matches what is simulated.
        if fall * (ang.cos() + SHEAR_GAIN * ang.sin()) >= MIN_CONTRIB {
            integral += normal * std::f32::consts::TAU * r * dr;
        }
    }
    NOZZLE_THRUST_N / integral
}

/// `peaks` receives, per dish, the largest instantaneous spray force over the sweep (newtons)
/// and the vertical part of it at that moment (positive = pushing the dish up).
pub fn evaluate(
    cells: &Cells,
    noz: &Nozzles,
    steps: usize,
    ph: &Physics,
    out_clean: &mut [f32],
    peaks: &mut [f32],
) -> Stats {
    let scene = build_scene(cells);
    let smear = (REF_STEPS / steps as f32).max(1.0);
    let scale = force_scale();
    let n_dish = scene.runs.len();
    let mut g = vec![0f32; cells.weight.len()];
    let mut force = vec![0f32; 3 * n_dish];
    peaks.fill(0.0);
    for s in 0..steps {
        let theta = std::f32::consts::TAU * s as f32 / steps as f32;
        force.fill(0.0);
        // Steady-state: one revolution of spray, scaled by the cycle's integrated multiplier.
        accumulate(cells, noz, &scene, theta, ph.mint / steps as f32, smear, &mut g, Some(&mut force));
        for d in 0..n_dish.min(peaks.len() / 2) {
            let f = [force[3 * d] * scale, force[3 * d + 1] * scale, force[3 * d + 2] * scale];
            let mag = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]).sqrt();
            if mag > peaks[2 * d] {
                peaks[2 * d] = mag;
                peaks[2 * d + 1] = f[1];
            }
        }
    }
    let (mean, worst10) = finalize(cells, &scene, &g, ph, out_clean, None);
    Stats { mean, worst10, collisions: scene.collisions as f32, score: 0.5 * mean + 0.5 * worst10 }
}

// ---- C ABI for WebAssembly (no wasm-bindgen needed) ----

#[no_mangle]
pub extern "C" fn alloc(n_bytes: usize) -> *mut u8 {
    let mut v: Vec<u64> = Vec::with_capacity((n_bytes + 7) / 8);
    let p = v.as_mut_ptr() as *mut u8;
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `alloc` with the same `n_bytes`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, n_bytes: usize) {
    drop(Vec::from_raw_parts(ptr as *mut u64, 0, (n_bytes + 7) / 8));
}

#[allow(clippy::too_many_arguments)]
unsafe fn views<'a>(
    n: usize,
    pos: *const f32,
    nrm: *const f32,
    weight: *const f32,
    area: *const f32,
    adhesion: *const f32,
    dish: *const u32,
    nbr: *const i32,
) -> Cells<'a> {
    use std::slice::from_raw_parts as s;
    Cells {
        pos: s(pos, 3 * n),
        nrm: s(nrm, 3 * n),
        weight: s(weight, n),
        area: s(area, n),
        adhesion: s(adhesion, n),
        dish: s(dish, n),
        nbr: s(nbr, 4 * n),
    }
}

unsafe fn nozzle_views<'a>(m: usize, c: *const f32, lp: *const f32, ld: *const f32, f: *const f32) -> Nozzles<'a> {
    use std::slice::from_raw_parts as s;
    Nozzles { center: s(c, 3 * m), local_pos: s(lp, 3 * m), local_dir: s(ld, 3 * m), flow: s(f, m) }
}

unsafe fn write_stats(out: *mut f32, mean: f32, worst10: f32, collisions: u32) {
    let o = std::slice::from_raw_parts_mut(out, 4);
    o[0] = mean;
    o[1] = worst10;
    o[2] = collisions as f32;
    o[3] = 0.5 * mean + 0.5 * worst10;
}

/// Score a layout over one arm revolution.
///
/// # Safety
/// All pointers must reference buffers sized as described by the counts.
#[no_mangle]
pub unsafe extern "C" fn evaluate_layout(
    n_cells: u32,
    pos: *const f32,
    nrm: *const f32,
    weight: *const f32,
    area: *const f32,
    adhesion: *const f32,
    dish: *const u32,
    nbr: *const i32,
    n_noz: u32,
    ncenter: *const f32,
    nlpos: *const f32,
    nldir: *const f32,
    nflow: *const f32,
    steps: u32,
    k: f32,
    mint: f32,
    flags: u32,
    out_clean: *mut f32,
    out_stats: *mut f32,
    n_dishes: u32,
    out_peaks: *mut f32,
) {
    let n = n_cells as usize;
    let cells = views(n, pos, nrm, weight, area, adhesion, dish, nbr);
    let noz = nozzle_views(n_noz as usize, ncenter, nlpos, nldir, nflow);
    let ph = Physics { k, flags, mint };
    let st = evaluate(
        &cells,
        &noz,
        steps as usize,
        &ph,
        std::slice::from_raw_parts_mut(out_clean, n),
        std::slice::from_raw_parts_mut(out_peaks, 2 * n_dishes as usize),
    );
    write_stats(out_stats, st.mean, st.worst10, st.collisions as u32);
}

/// Add the (weight-scaled) exposure for one arm angle into `g` (n_cells floats, persists between calls).
///
/// # Safety
/// All pointers must reference buffers sized as described by the counts.
#[no_mangle]
pub unsafe extern "C" fn accumulate_step(
    n_cells: u32,
    pos: *const f32,
    nrm: *const f32,
    weight: *const f32,
    area: *const f32,
    adhesion: *const f32,
    dish: *const u32,
    nbr: *const i32,
    n_noz: u32,
    ncenter: *const f32,
    nlpos: *const f32,
    nldir: *const f32,
    nflow: *const f32,
    theta: f32,
    w: f32,
    g: *mut f32,
) {
    let n = n_cells as usize;
    let cells = views(n, pos, nrm, weight, area, adhesion, dish, nbr);
    let noz = nozzle_views(n_noz as usize, ncenter, nlpos, nldir, nflow);
    let scene = build_scene(&cells);
    accumulate(&cells, &noz, &scene, theta, w, 1.0, std::slice::from_raw_parts_mut(g, n), None);
}

/// Cleanliness from the exposure accumulated so far by `accumulate_step`.
///
/// # Safety
/// All pointers must reference buffers sized as described by the counts.
#[no_mangle]
pub unsafe extern "C" fn finalize_layout(
    n_cells: u32,
    pos: *const f32,
    nrm: *const f32,
    weight: *const f32,
    area: *const f32,
    adhesion: *const f32,
    dish: *const u32,
    nbr: *const i32,
    g: *const f32,
    k: f32,
    mint: f32,
    flags: u32,
    out_clean: *mut f32,
    out_film: *mut f32,
    out_stats: *mut f32,
) {
    let n = n_cells as usize;
    let cells = views(n, pos, nrm, weight, area, adhesion, dish, nbr);
    let scene = build_scene(&cells);
    let ph = Physics { k, flags, mint };
    let film = std::slice::from_raw_parts_mut(out_film, n);
    film.fill(0.0);
    let (mean, worst10) = finalize(
        &cells,
        &scene,
        std::slice::from_raw_parts(g, n),
        &ph,
        std::slice::from_raw_parts_mut(out_clean, n),
        Some(film),
    );
    write_stats(out_stats, mean, worst10, scene.collisions);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_nozzle() -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        (vec![0.0, 7.0, 0.0], vec![0.0; 3], vec![0.0, 1.0, 0.0], vec![1.0])
    }

    const PLAIN: Physics = Physics { k: 50.0, flags: 0, mint: 1.0 };

    #[test]
    fn open_cell_facing_jet_gets_cleaned_and_shadowed_cell_does_not() {
        let (c, lp, ld, f) = one_nozzle();
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        let cells = Cells {
            pos: &[0.0, 20.0, 0.0, 0.0, 24.0, 0.0],
            nrm: &[0.0, -1.0, 0.0, 0.0, -1.0, 0.0],
            weight: &[1.0, 1.0],
            area: &[1.0, 1.0],
            adhesion: &[1.0, 1.0],
            dish: &[0, 1],
            nbr: &[-1; 8],
        };
        let mut out = [0.0f32; 2];
        evaluate(&cells, &noz, 8, &PLAIN, &mut out, &mut [0.0; 4]);
        assert!(out[0] > 0.5, "front cell should be cleaned: {}", out[0]);
        assert!(out[1] < 0.01, "shadowed cell should stay dirty: {}", out[1]);
    }

    #[test]
    fn back_facing_cell_is_not_cleaned() {
        let (c, lp, ld, f) = one_nozzle();
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        let cells = Cells {
            pos: &[0.0, 20.0, 0.0],
            nrm: &[0.0, 1.0, 0.0],
            weight: &[1.0],
            area: &[1.0],
            adhesion: &[1.0],
            dish: &[0],
            nbr: &[-1; 4],
        };
        let mut out = [0.0f32; 1];
        evaluate(&cells, &noz, 8, &PLAIN, &mut out, &mut [0.0; 4]);
        assert_eq!(out[0], 0.0);
    }

    #[test]
    fn stepwise_accumulation_matches_batch() {
        let (c, lp, ld, f) = (vec![0.0, 7.0, 0.0], vec![5.0, 0.0, 0.0], vec![0.0, 1.0, 0.2], vec![1.0]);
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        let cells = Cells {
            pos: &[5.0, 20.0, 0.0, -4.0, 22.0, 3.0],
            nrm: &[0.0, -1.0, 0.0, 0.0, -1.0, 0.0],
            weight: &[1.0, 1.0],
            area: &[1.0, 1.0],
            adhesion: &[1.0, 1.0],
            dish: &[0, 1],
            nbr: &[-1; 8],
        };
        let ph = Physics { k: 30.0, flags: FLAG_SPLASH | FLAG_FILM, mint: 0.7 };
        let mut batch = [0.0f32; 2];
        evaluate(&cells, &noz, 36, &ph, &mut batch, &mut [0.0; 4]);

        let scene = build_scene(&cells);
        let mut g = [0.0f32; 2];
        for s in 0..36 {
            accumulate(&cells, &noz, &scene, std::f32::consts::TAU * s as f32 / 36.0, ph.mint / 36.0, 1.0, &mut g, None);
        }
        let mut step = [0.0f32; 2];
        finalize(&cells, &scene, &g, &ph, &mut step, None);
        assert_eq!(batch, step);
    }

    #[test]
    fn splash_cleans_cells_the_jets_cannot_see() {
        let (c, lp, ld, f) = one_nozzle();
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        // One emitter facing down, over a floor of up-facing cells that no jet can hit directly.
        let mut pos = vec![0.0, 20.0, 0.0];
        let mut nrm = vec![0.0, -1.0, 0.0];
        for x in -10i32..=10 {
            for z in -10i32..=10 {
                if x.abs() > 1 || z.abs() > 1 {
                    pos.extend([x as f32, 14.0, z as f32]);
                    nrm.extend([0.0, 1.0, 0.0]);
                }
            }
        }
        let n = pos.len() / 3;
        let cells = Cells {
            pos: &pos,
            nrm: &nrm,
            weight: &vec![1.0; n],
            area: &vec![1.0; n],
            adhesion: &vec![1.0; n],
            dish: &vec![0; n],
            nbr: &vec![-1; 4 * n],
        };
        let sum = |flags| {
            let ph = Physics { k: 400.0, flags, mint: 1.0 };
            let mut out = vec![0.0f32; n];
            evaluate(&cells, &noz, 16, &ph, &mut out, &mut [0.0; 2]);
            out[1..].iter().sum::<f32>()
        };
        assert_eq!(sum(0), 0.0);
        assert!(sum(FLAG_SPLASH) > 0.5, "splash should reach the floor: {}", sum(FLAG_SPLASH));
    }

    #[test]
    fn longer_or_hotter_cycle_cleans_more() {
        let (c, lp, ld, f) = one_nozzle();
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        let cells = Cells {
            pos: &[0.0, 25.0, 0.0],
            nrm: &[0.0, -1.0, 0.0],
            weight: &[1.0],
            area: &[1.0],
            adhesion: &[1.0],
            dish: &[0],
            nbr: &[-1; 4],
        };
        let run = |mint| {
            let mut out = [0.0f32; 1];
            evaluate(&cells, &noz, 8, &Physics { k: 20.0, flags: 0, mint }, &mut out, &mut [0.0; 2]);
            out[0]
        };
        assert!(run(2.0) > run(1.0) && run(1.0) > run(0.3));
    }

    #[test]
    fn plate_square_on_to_a_jet_feels_about_the_nozzle_thrust() {
        // A big flat plate at the reference distance catches the whole jet: force ~ thrust.
        let c = vec![0.0, 0.0, 0.0];
        let (lp, ld, f) = (vec![0.0; 3], vec![0.0, 1.0, 0.0], vec![1.0]);
        let noz = Nozzles { center: &c, local_pos: &lp, local_dir: &ld, flow: &f };
        let (mut pos, mut nrm) = (vec![], vec![]);
        for x in -100i32..=100 {
            for z in -100i32..=100 {
                pos.extend([x as f32 * 0.2, REF_DISTANCE, z as f32 * 0.2]);
                nrm.extend([0.0, -1.0, 0.0]);
            }
        }
        let n = pos.len() / 3;
        let cells = Cells {
            pos: &pos,
            nrm: &nrm,
            weight: &vec![1.0; n],
            area: &vec![0.04; n],
            adhesion: &vec![1.0; n],
            dish: &vec![0; n],
            nbr: &vec![-1; 4 * n],
        };
        let mut out = vec![0.0f32; n];
        let mut peaks = [0.0f32; 2];
        evaluate(&cells, &noz, 36, &Physics { k: 1.0, flags: 0, mint: 1.0 }, &mut out, &mut peaks);
        // Plate faces down, so the jet pushes it up: +y.
        assert!((peaks[0] - NOZZLE_THRUST_N).abs() < 0.2 * NOZZLE_THRUST_N, "force {}", peaks[0]);
        assert!(peaks[1] > 0.0);
    }
}

