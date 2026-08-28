/**
 * Unit conversion (spec §39).
 *
 * Conversions live here and nowhere else. Canonical storage is metric; these
 * functions run only at the two boundaries - parsing input and rendering
 * output. Nothing in lib/analytics ever calls them, because analytics operates
 * purely on canonical units.
 *
 * Factors are exact by definition (international pound, international mile).
 */

export const KG_PER_LB = 0.45359237;
export const CM_PER_INCH = 2.54;
export const KM_PER_MILE = 1.609344;

/** Energy density used for the energy-balance TDEE estimate (spec §20). */
export const KCAL_PER_KG_BODY_MASS = 7700;

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

export function inchesToCm(inches: number): number {
  return inches * CM_PER_INCH;
}

export function cmToInches(cm: number): number {
  return cm / CM_PER_INCH;
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE;
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

/** Height entered as feet and inches, e.g. 5'10" -> 177.8 cm. */
export function feetInchesToCm(feet: number, inches: number): number {
  return inchesToCm(feet * 12 + inches);
}

export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = cmToInches(cm);
  const feet = Math.floor(totalInches / 12);
  return { feet, inches: totalInches - feet * 12 };
}

export function hoursToMinutes(hours: number): number {
  return hours * 60;
}

/** "7h 42m" style duration -> minutes. */
export function hoursMinutesToMinutes(hours: number, minutes: number): number {
  return hours * 60 + minutes;
}

export function minutesToHoursMinutes(total: number): {
  hours: number;
  minutes: number;
} {
  const hours = Math.floor(total / 60);
  return { hours, minutes: Math.round(total - hours * 60) };
}

export type WeightUnit = 'KG' | 'LB';
export type DistanceUnit = 'KM' | 'MI';
export type LengthUnit = 'CM' | 'IN';

/** Converts a canonical kg value into the unit the user reads in. */
export function displayWeight(kg: number, unit: WeightUnit): number {
  return unit === 'KG' ? kg : kgToLb(kg);
}

/** Converts a user-entered weight in their display unit into canonical kg. */
export function canonicalWeight(value: number, unit: WeightUnit): number {
  return unit === 'KG' ? value : lbToKg(value);
}

export function displayDistance(km: number, unit: DistanceUnit): number {
  return unit === 'KM' ? km : kmToMiles(km);
}

export function canonicalDistance(value: number, unit: DistanceUnit): number {
  return unit === 'KM' ? value : milesToKm(value);
}

export function displayLength(cm: number, unit: LengthUnit): number {
  return unit === 'CM' ? cm : cmToInches(cm);
}

export function canonicalLength(value: number, unit: LengthUnit): number {
  return unit === 'CM' ? value : inchesToCm(value);
}

/**
 * Converts a rate. Rates carry a unit in the numerator only (kg/week ->
 * lb/week), so the same factor applies as for a scalar.
 */
export function displayWeightRate(kgPerWeek: number, unit: WeightUnit): number {
  return unit === 'KG' ? kgPerWeek : kgToLb(kgPerWeek);
}

export const WEIGHT_UNIT_LABEL: Record<WeightUnit, string> = { KG: 'kg', LB: 'lb' };
export const DISTANCE_UNIT_LABEL: Record<DistanceUnit, string> = {
  KM: 'km',
  MI: 'mi',
};
export const LENGTH_UNIT_LABEL: Record<LengthUnit, string> = { CM: 'cm', IN: 'in' };
