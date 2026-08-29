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

/**
 * The three units a user reads and types in, carried together.
 *
 * WHY THIS EXISTS. The display-unit preference was honoured by every write
 * action and ignored by every form label and every page. A form labelled
 * "Weight (lb)" while the action converted with the profile's KG setting
 * turned 203.7 pounds into 203.7 kilograms on save - silently, on a screen
 * that had just told the user what unit it wanted. The preference is only safe
 * when the label, the value shown and the conversion all read the SAME source,
 * so that source is passed around as one object rather than assumed three
 * times.
 */
export interface DisplayUnits {
  weight: WeightUnit;
  length: LengthUnit;
  distance: DistanceUnit;
}

/** The user's units, from their profile. */
export function unitsOf(profile: {
  weightDisplayUnit: WeightUnit;
  lengthDisplayUnit: LengthUnit;
  distanceDisplayUnit: DistanceUnit;
}): DisplayUnits {
  return {
    weight: profile.weightDisplayUnit,
    length: profile.lengthDisplayUnit,
    distance: profile.distanceDisplayUnit,
  };
}

/**
 * The same weight, written in a different unit.
 *
 * For a form field whose unit selector just changed: the MEASUREMENT must not
 * change, only how it is spelled. Blank stays blank - it means "not set", and
 * converting it would invent a zero - and text that is not a number is handed
 * back untouched so the user can see and fix what they typed.
 */
export function restateWeight(text: string, from: WeightUnit, to: WeightUnit): string {
  const trimmed = text.trim();
  if (trimmed === '') return text;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return text;
  if (from === to) return text;
  return String(Math.round(displayWeight(canonicalWeight(value, from), to) * 10) / 10);
}

/** The labels for a set of display units, ready to put next to a figure. */
export function unitLabels(units: DisplayUnits): {
  weight: string;
  length: string;
  distance: string;
} {
  return {
    weight: WEIGHT_UNIT_LABEL[units.weight],
    length: LENGTH_UNIT_LABEL[units.length],
    distance: DISTANCE_UNIT_LABEL[units.distance],
  };
}
