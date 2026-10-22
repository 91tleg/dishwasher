/**
 * The machine the sim is modelled on: a US 24" built-in dishwasher with a third rack.
 * Source: the manufacturer's product page. The page gives the exterior size and
 * features only, so interior geometry below is estimated from that and from the page's
 * "door open, racks pushed in" photo. Replace the estimates with measurements when you have them.
 */

/** Units: cm. */
export const MACHINE = {
  /** Interior of the tub (ESTIMATE: a 24" tub is a little smaller than the 59.8 x 60.3 x 86 cm exterior). */
  tub: { width: 55, depth: 54, height: 71 },

  /** Height of each rack's resting surface above the tub floor (ESTIMATE from the photo). */
  decks: { lower: 9, upper: 41 },
  /** Outside of the cabinet: 59.8 x 86 x 60.3 cm from the Bosch page. y runs from the floor (-12) to the top (74). */
  cabinet: { halfX: 29.9, yMin: -12, yMax: 74, zBack: -29, zFront: 31.3 },
  /** Door: hinged along the bottom edge at tub-floor height, opens forward and down to horizontal. */
  door: { hingeY: 0, hingeZ: 27, thickness: 4.3, height: 74 },
  /** How far each rack slides out along +z, cm (ESTIMATE). */
  rackTravel: { lower: 40, upper: 32 },


  /**
   * Cutlery basket in the front-right of the lower rack, against the right wall (from the photo): a hollow
   * slotted plastic basket with a carry handle. Sizes are ESTIMATES scaled from the photo.
   */
  basket: { minX: 12.5, maxX: 24.5, minZ: 2, maxZ: 24, height: 16, wall: 0.4 },

  /** Spray arms. The photo shows a lower arm and a bar under the upper rack. Nozzle layout is an ESTIMATE. */
  arms: [
    { name: 'lower', y: 5, radii: [3, 7, 11, 15, 19, 22], radialTilt: [-0.55, -0.3, -0.1, 0.15, 0.4, 0.7] },
    { name: 'upper', y: 39, radii: [3, 7, 11, 15, 18], radialTilt: [-0.5, -0.25, 0, 0.3, 0.6] },
  ],

  confirmed: [
    'Exterior 33 7/8 x 23 9/16 x 23 3/4 in (86 x 59.8 x 60.3 cm), 24" built-in',
    '16 place settings, stainless steel tub',
    'Lower rack, upper rack, and a flexible 3rd rack (not modelled yet)',
    'PrecisionWash, programs Heavy / Auto / Normal / Speed 60 / Favorite',
    'Sanitize (NSF certified), CrystalDry, 42 dBA, 688 gal/year',
  ],
  estimated: [
    'Interior size, rack heights, cutlery basket and tine layout',
    'Spray arm count, size, nozzle layout and pump flow (the photo shows two arms)',
    'Program temperatures and durations',
  ],
};

// ---- rack geometry: shared by the 3D view and the physics colliders ----

type V3 = [number, number, number];

/** A straight wire rod (capsule) from a to b. */
export interface Rod {
  a: V3;
  b: V3;
  r: number;
}

export interface Box {
  center: V3;
  half: V3;
}

export const WIRE_R = 0.3;
const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-6; v += step) out.push(v);
  return out;
};

/** Plate tine rows of the lower rack: x positions of each tine, per row z. */
export const LOWER_TINES = {
  rowsZ: [-12, 4],
  x: range(-23, 9, 3.6),
  height: 9,
};

/** Wire-frame lower rack in the style of the photo: grid deck, side walls, two plate-tine rows. */
export function lowerRackRods(): Rod[] {
  const y = MACHINE.decks.lower;
  const rods: Rod[] = [];
  const X0 = -25, X1 = 25, Z0 = -24, Z1 = 24;
  // Deck: long wires front-to-back and cross wires underneath.
  for (const x of range(X0, X1, 3.4)) rods.push({ a: [x, y, Z0], b: [x, y, Z1], r: WIRE_R });
  for (const z of range(Z0, Z1, 6)) rods.push({ a: [X0, y - 0.6, z], b: [X1, y - 0.6, z], r: WIRE_R });
  // Perimeter walls: two rails high at the back and sides, one low at the front.
  for (const h of [5, 11]) {
    rods.push({ a: [X0, y + h, Z0], b: [X1, y + h, Z0], r: WIRE_R });
    rods.push({ a: [X0, y + h, Z0], b: [X0, y + h, Z1], r: WIRE_R });
    rods.push({ a: [X1, y + h, Z0], b: [X1, y + h, Z1], r: WIRE_R });
  }
  rods.push({ a: [X0, y + 4, Z1], b: [X1, y + 4, Z1], r: WIRE_R });
  for (const x of range(X0, X1, 8.3)) rods.push({ a: [x, y, Z0], b: [x, y + 11, Z0], r: WIRE_R });
  for (const z of range(Z0, Z1, 8)) {
    rods.push({ a: [X0, y, z], b: [X0, y + 11, z], r: WIRE_R });
    rods.push({ a: [X1, y, z], b: [X1, y + 11, z], r: WIRE_R });
  }
  // Plate tines, two rows running left to right (they stop before the cutlery basket).
  for (const z of LOWER_TINES.rowsZ) {
    for (const x of LOWER_TINES.x) rods.push({ a: [x, y, z], b: [x, y + LOWER_TINES.height, z], r: 0.35 });
  }
  return rods;
}

/** Upper rack: grid deck, low walls, two short tine rows, and a fold-down cup shelf on each side. */
export function upperRackRods(): Rod[] {
  const y = MACHINE.decks.upper;
  const rods: Rod[] = [];
  const X0 = -24, X1 = 24, Z0 = -22, Z1 = 22;
  for (const x of range(X0, X1, 3.2)) rods.push({ a: [x, y, Z0], b: [x, y, Z1], r: WIRE_R });
  for (const z of range(Z0, Z1, 8)) rods.push({ a: [X0, y - 0.6, z], b: [X1, y - 0.6, z], r: WIRE_R });
  for (const h of [5, 10]) {
    rods.push({ a: [X0, y + h, Z0], b: [X1, y + h, Z0], r: WIRE_R });
    rods.push({ a: [X0, y + h, Z1], b: [X1, y + h, Z1], r: WIRE_R });
    rods.push({ a: [X0, y + h, Z0], b: [X0, y + h, Z1], r: WIRE_R });
    rods.push({ a: [X1, y + h, Z0], b: [X1, y + h, Z1], r: WIRE_R });
  }
  for (const x of [X0, X1]) for (const z of range(Z0, Z1, 11)) rods.push({ a: [x, y, z], b: [x, y + 10, z], r: WIRE_R });
  // Two rows of short tines in the middle.
  for (const z of [-6, 6]) {
    for (const x of range(-20, 20, 4)) rods.push({ a: [x, y, z], b: [x, y + 7, z], r: 0.35 });
  }
  // Cup shelves: pairs of rods along the sides, sloping up toward the wall.
  for (const side of [-1, 1]) {
    rods.push({ a: [side * 17, y + 11, Z0 + 1], b: [side * 17, y + 11, Z1 - 1], r: 0.3 });
    rods.push({ a: [side * 21, y + 13, Z0 + 1], b: [side * 21, y + 13, Z1 - 1], r: 0.3 });
    for (const z of [Z0 + 1, Z1 - 1]) rods.push({ a: [side * 17, y + 11, z], b: [side * 21, y + 13, z], r: 0.3 });
  }
  return rods;
}

export interface BasketPart extends Box {
  kind: 'floor' | 'wall' | 'divider';
}

/**
 * The cutlery basket as thin plates: a floor, four walls, and dividers that cut the inside into upright slots
 * so utensils stand straight. Open at the top. The same plates draw the basket and collide with dishes.
 */
export function basketParts(): BasketPart[] {
  const b = MACHINE.basket;
  const base = MACHINE.decks.lower + 0.3; // rests on the deck wires
  const w = b.maxX - b.minX, d = b.maxZ - b.minZ, t = b.wall, h = b.height;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const parts: BasketPart[] = [
    { kind: 'floor', center: [cx, base + t / 2, cz], half: [w / 2, t / 2, d / 2] },
    { kind: 'wall', center: [cx, base + h / 2, b.minZ + t / 2], half: [w / 2, h / 2, t / 2] },
    { kind: 'wall', center: [cx, base + h / 2, b.maxZ - t / 2], half: [w / 2, h / 2, t / 2] },
    { kind: 'wall', center: [b.minX + t / 2, base + h / 2, cz], half: [t / 2, h / 2, d / 2] },
    { kind: 'wall', center: [b.maxX - t / 2, base + h / 2, cz], half: [t / 2, h / 2, d / 2] },
  ];
  // Dividers: 3 columns by 5 rows of ~4 cm slots, a little lower than the rim.
  const dh = h - 3;
  for (let k = 1; k < 3; k++) parts.push({ kind: 'divider', center: [b.minX + (w * k) / 3, base + dh / 2, cz], half: [0.15, dh / 2, d / 2] });
  for (let k = 1; k < 5; k++) parts.push({ kind: 'divider', center: [cx, base + dh / 2, b.minZ + (d * k) / 5], half: [w / 2, dh / 2, 0.15] });
  return parts;
}

/** The basket's carry handle: an arch across the top, so it can be lifted out by hand. */
export function basketHandleRods(): Rod[] {
  const b = MACHINE.basket;
  const rimY = MACHINE.decks.lower + 0.3 + b.height;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const R = (b.maxX - b.minX) / 2 - b.wall / 2;
  const rods: Rod[] = [];
  const n = 12;
  const at = (i: number): [number, number, number] => {
    const th = (Math.PI * i) / n;
    return [cx + R * Math.cos(th), rimY + 6 * Math.sin(th), cz];
  };
  for (let i = 0; i < n; i++) rods.push({ a: at(i), b: at(i + 1), r: 0.45 });
  return rods;
}

/**
 * Fixed walls: tub sides, back and ceiling, the base block under the tub, and the room floor.
 * The front is the door (a moving body), so there is no fixed front wall.
 */
export function tubBoxes(): Box[] {
  const { width: w, depth: d, height: h } = MACHINE.tub;
  const c = MACHINE.cabinet;
  const side = c.halfX - w / 2; // side wall thickness
  const back = -d / 2 - c.zBack; // back wall thickness
  const zMid = (c.zBack + c.zFront) / 2;
  const zHalf = (c.zFront - c.zBack) / 2;
  return [
    // base block: from the room floor up to the tub floor
    { center: [0, c.yMin / 2, zMid], half: [c.halfX, -c.yMin / 2, zHalf] },
    // ceiling: the top of the cabinet
    { center: [0, h + (c.yMax - h) / 2, zMid], half: [c.halfX, (c.yMax - h) / 2, zHalf] },
    // sides
    { center: [-(w / 2 + side / 2), h / 2, zMid], half: [side / 2, h / 2, zHalf] },
    { center: [w / 2 + side / 2, h / 2, zMid], half: [side / 2, h / 2, zHalf] },
    // back wall
    { center: [0, h / 2, c.zBack + back / 2], half: [w / 2, h / 2, back / 2] },
    // the room floor, wide enough to catch anything dropped nearby
    { center: [0, c.yMin - 5, 0], half: [220, 5, 220] },
  ];
}
