import { buildDishLocal, type DishKind } from './geometry';
import { isUtensil } from './utensils';

/** Dishes are ceramic and utensils are stainless steel. Material is not a choice. */
const CERAMIC = { density: 2.4, wall: 0.3, friction: 0.5 };
const STEEL = { density: 7.9, wall: 0.16, friction: 0.3, color: 0xb8c0c8 };
const of = (kind: DishKind) => (isUtensil(kind) ? STEEL : CERAMIC);

/**
 * Mass in kg, from surface area times an effective wall thickness. (Utensils are solid bar, so their effective
 * wall is much thicker than the drawn ribbon.)
 */
export function dishMass(kind: DishKind): number {
  const m = of(kind);
  return (buildDishLocal(kind).faceArea * m.wall * m.density) / 1000;
}

export const dishFriction = (kind: DishKind): number => of(kind).friction;

/** Colour override: utensils are steel; dishes keep their own china colour. */
export const dishColor = (kind: DishKind): number | null => (isUtensil(kind) ? STEEL.color : null);
