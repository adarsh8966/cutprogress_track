/**
 * The Google Health OAuth scopes, in one place.
 *
 * WHY THIS FILE EXISTS AT ALL. A scope string scattered across an auth URL, a
 * capability check and three call sites is a scope you cannot audit. Asking
 * "what does this app request, and what does each request buy?" should be
 * answerable by reading one file, and adding a capability later should be
 * adding an entry here rather than hunting for string literals.
 *
 * ALL GOOGLE HEALTH SCOPES ARE RESTRICTED. Google classifies every one of them
 * as such, which means a third-party security review before the app can serve
 * more than 100 users. That is not a constraint on this integration - it is a
 * constraint on publishing it - but it is why `reason` below is written for a
 * person: it is the text the consent explanation is built from, and a user
 * being asked for restricted health data deserves to be told what for.
 *
 * NOTHING HERE IS A SECRET. Scope strings are public identifiers and appear in
 * the authorisation URL the browser follows. The client secret is not here; it
 * lives in env.ts, which is server-only.
 */

const PREFIX = 'https://www.googleapis.com/auth/googlehealth';

export interface ScopeSpec {
  /** The full scope string sent to Google. */
  readonly scope: string;
  /** The short form the documentation's tables use. */
  readonly short: string;
  /** Shown on the connect screen, in the user's language, before consent. */
  readonly reason: string;
  /**
   * Whether the integration is useful without it. Google lets a user grant a
   * subset of what was asked for, so "required" here means "the sync has
   * nothing to do without this", not "the request will fail".
   */
  readonly required: boolean;
}

/**
 * The four scopes this application requests, and only those.
 *
 * DELIBERATELY ABSENT, each for a stated reason:
 *
 *   .nutrition.readonly    Nutrition intake is entered by hand in CUT OS and
 *                          stays that way. Requesting read access to food logs
 *                          would be asking for data this app has decided not to
 *                          use. It also covers hydration-log, which is
 *                          therefore out of reach - a real limitation, and the
 *                          right trade.
 *   .ecg.readonly          ECG is a clinical signal with no destination here.
 *   .irn.readonly          Irregular rhythm notifications, likewise.
 *   .profile.readonly      Age and membership date. CUT OS already has date of
 *   .settings.readonly     birth on the profile, and reads no device settings.
 *   every .writeonly       This integration never writes to Google Health.
 *                          There is no write scope, so a write is not something
 *                          that can be done by mistake - it is something that
 *                          cannot be expressed.
 *
 * Adding one is a deliberate act: an entry here, a registry entry for the data
 * types it unlocks, a canonical destination, and the user's consent.
 */
export const REQUESTED_SCOPES: readonly ScopeSpec[] = [
  {
    scope: `${PREFIX}.activity_and_fitness.readonly`,
    short: '.activity_and_fitness.readonly',
    reason:
      'Steps, distance, floors, active minutes, active zone minutes, calories '
      + 'burned, VO2 max and your recorded workouts. This is what fills the '
      + 'activity half of the dashboard and what lets a workout be matched to '
      + 'the heart rate recorded during it.',
    required: true,
  },
  {
    scope: `${PREFIX}.health_metrics_and_measurements.readonly`,
    short: '.health_metrics_and_measurements.readonly',
    reason:
      'Weight, body fat, resting heart rate, heart-rate variability, heart-rate '
      + 'samples, respiratory rate and blood oxygen. This is the recovery half, '
      + 'and the heart-rate data every zone calculation is built on.',
    required: true,
  },
  {
    scope: `${PREFIX}.sleep.readonly`,
    short: '.sleep.readonly',
    reason:
      'Sleep sessions and their stages — REM, deep, light and awake — so sleep '
      + 'duration and quality can be read alongside training load.',
    required: false,
  },
  {
    scope: `${PREFIX}.location.readonly`,
    short: '.location.readonly',
    reason:
      'The GPS track recorded during an outdoor workout, exported as a TCX '
      + 'file and kept with the session. Without it the session summary still '
      + 'arrives; only the route is missing.',
    required: false,
  },
] as const;

/** What goes in the `scope` parameter of the authorisation URL. */
export function scopeParameter(): string {
  return REQUESTED_SCOPES.map((s) => s.scope).join(' ');
}

/**
 * Google returns the granted scopes as a space-separated string. Partial
 * consent is a supported outcome, not a failure, so this parses whatever came
 * back rather than assuming it matches what was asked for.
 */
export function parseGrantedScopes(granted: string | null | undefined): string[] {
  if (!granted) return [];
  return granted.split(/\s+/).filter((s) => s.length > 0);
}

/** The scopes that were asked for and not granted. */
export function missingScopes(granted: readonly string[]): ScopeSpec[] {
  const held = new Set(granted);
  return REQUESTED_SCOPES.filter((spec) => !held.has(spec.scope));
}

/** Whether enough was granted for a sync to do anything at all. */
export function hasUsableScopes(granted: readonly string[]): boolean {
  const held = new Set(granted);
  return REQUESTED_SCOPES.some((spec) => held.has(spec.scope));
}

export function holdsScope(granted: readonly string[], scope: string): boolean {
  return granted.includes(scope);
}

/** The short-form names, for display. */
export const SCOPE_BY_SHORT: Record<string, ScopeSpec> = Object.fromEntries(
  REQUESTED_SCOPES.map((spec) => [spec.short, spec]),
);

export const ACTIVITY_SCOPE = `${PREFIX}.activity_and_fitness.readonly`;
export const METRICS_SCOPE = `${PREFIX}.health_metrics_and_measurements.readonly`;
export const SLEEP_SCOPE = `${PREFIX}.sleep.readonly`;
export const LOCATION_SCOPE = `${PREFIX}.location.readonly`;

export type GoogleHealthScope =
  | typeof ACTIVITY_SCOPE
  | typeof METRICS_SCOPE
  | typeof SLEEP_SCOPE
  | typeof LOCATION_SCOPE;
