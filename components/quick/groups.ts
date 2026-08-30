/**
 * Quick Entry's sections, named once.
 *
 * The form renders them, the page validates the `?open=` that Quick Add sends,
 * and the day view builds the links. Three places that must agree on a string,
 * which is exactly the kind of agreement that decays if each keeps its own
 * copy - a renamed section would silently start opening nothing.
 */
export const QUICK_GROUPS = [
  'Body',
  'Nutrition',
  'Activity and vitals',
  'Sleep',
  'Workout',
  'Cardio',
] as const;

export type QuickGroup = (typeof QUICK_GROUPS)[number];

export function isQuickGroup(value: string): value is QuickGroup {
  return (QUICK_GROUPS as readonly string[]).includes(value);
}

/**
 * Which groups start open.
 *
 * Weight and food are what gets logged most nights, so those two are open and
 * the rest are one tap away. Every group stays reachable; none is behind a
 * menu or another page.
 */
export const DEFAULT_OPEN: Record<QuickGroup, boolean> = {
  Body: true,
  Nutrition: true,
  'Activity and vitals': false,
  Sleep: false,
  Workout: false,
  Cardio: false,
};

/** What each group is for, on the Quick Add buttons. */
export const QUICK_ADD_LABEL: Record<QuickGroup, string> = {
  Body: 'Weight',
  Nutrition: 'Nutrition',
  'Activity and vitals': 'Steps and vitals',
  Sleep: 'Sleep',
  Workout: 'Workout',
  Cardio: 'Cardio',
};
