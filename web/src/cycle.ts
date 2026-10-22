/** Wash-cycle schedule: water temperature and detergent over time, and the toggles for spatial effects. */

/** Programs on the modelled machine. The page lists the names only: temperatures and times are ASSUMED. */
export const PROGRAMS = {
  heavy: { label: 'Heavy', tempC: 65, minutes: 30 },
  auto: { label: 'Auto', tempC: 50, minutes: 20 },
  normal: { label: 'Normal', tempC: 55, minutes: 20 },
  speed60: { label: 'Speed 60', tempC: 60, minutes: 10 },
} as const;
export type ProgramId = keyof typeof PROGRAMS;

export interface Cycle {
  program: ProgramId;
  /** Main-wash length in minutes. */
  minutes: number;
  /** Target water temperature, deg C. */
  tempC: number;
  /** Detergent doses (1 = a normal tab). */
  detergent: number;
  /** One splash bounce. */
  splash: boolean;
  /** Water film (cushioning + wall shear). */
  film: boolean;
}

export const DEFAULT_CYCLE: Cycle = { program: 'normal', minutes: 20, tempC: 55, detergent: 1, splash: true, film: true };

export const washSeconds = (c: Cycle) => c.minutes * 60;


const T_INLET = 15;
/** deg C per second while the heater runs. */
const HEAT_RATE = 0.15;
/** Cleaning kinetics roughly speed up by this factor per +10 deg C. */
const Q10 = 1.6;
const T_REF = 55;
/** The dispenser opens this many seconds into the wash and the tab dissolves over ~TAU_D. */
const DETERGENT_OPEN = 120;
const DETERGENT_TAU = 90;
/** Detergent boosts the rate up to (1 + BOOST), saturating around HALF doses. */
const BOOST = 1.5;
const HALF = 0.3;

export function waterTemp(t: number, c: Cycle): number {
  return Math.min(c.tempC, T_INLET + HEAT_RATE * t);
}

export function detergentConc(t: number, c: Cycle): number {
  return c.detergent * (1 - Math.exp(-Math.max(0, t - DETERGENT_OPEN) / DETERGENT_TAU));
}

const boost = (conc: number) => 1 + (BOOST * conc) / (conc + HALF);

/** Cleaning-rate multiplier at time t, normalised to 1 at 55 deg C with one full dose. */
export function rateMultiplier(t: number, c: Cycle): number {
  const fT = Math.pow(Q10, (waterTemp(t, c) - T_REF) / 10);
  return (fT * boost(detergentConc(t, c))) / boost(1);
}

/** Time-average of the multiplier over the whole wash. */
export function meanMultiplier(c: Cycle): number {
  const n = 180;
  let s = 0;
  for (let i = 0; i < n; i++) s += rateMultiplier(((i + 0.5) / n) * washSeconds(c), c);
  return s / n;
}

export function cycleFlags(c: Cycle): number {
  return (c.splash ? 1 : 0) | (c.film ? 2 : 0);
}
