/**
 * PURE: what identifies a Google Health observation when Google does not.
 *
 * THE PROBLEM THIS SOLVES. `external_observations` is keyed on
 * (user, provider, data_type, external_id, version), and that key is the whole
 * idempotency guarantee: re-reading a window is free because the database
 * refuses a record it already has. Google supplies the external id as
 * `DataPoint.name` - but only for a subset of data types. For the rest, and
 * that includes steps, the field is simply absent, and an integration that
 * requires it either rejects real data (which is what happened) or invents an
 * identity that changes every sync (which would duplicate a year of history on
 * the second press of the button).
 *
 * So CUT OS mints one, from the facts that actually identify the observation:
 * the provider, the data type, the recording source, WHEN it was measured, and
 * whatever else distinguishes two points that share all of those.
 *
 *   cutos:1/google-health/steps/i=2026-08-29T00:00:00.000Z..2026-08-30T00:00:00.000Z/s=FITBIT~AUTOMATICALLY_RECORDED~-~-
 *   cutos:1/google-health/daily-resting-heart-rate/d=2026-08-29/s=FITBIT~-~-~-
 *
 * FOUR PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. DETERMINISTIC. The same observation produces the same string on every
 *     sync, forever. A random component - a UUID, a timestamp of the run - would
 *     make every re-read a new record and every backfill a duplicate.
 *
 *  2. DISTINGUISHABLE FROM GOOGLE'S OWN. A resource name always begins
 *     `users/`, so the `cutos:` scheme cannot be mistaken for one, in this code
 *     or by somebody reading a row six months from now. Which kind of identity
 *     a record carries is a provenance fact and it stays legible.
 *
 *  3. LEGIBLE, NOT HASHED. The id says what identified the observation. A
 *     digest would be shorter and would answer no question at all - and the one
 *     time you need this field is when something has gone wrong and you are
 *     looking at the row.
 *
 *  4. FREE OF THE MEASUREMENT. The value is deliberately NOT part of the
 *     identity. A revised step count has to be a correction to the same
 *     observation, not a second observation: two live rows for one day would
 *     both carry the same instant, and resolveObservations breaks a tie on
 *     source priority - so with both sides GOOGLE_HEALTH the day would resolve
 *     in whatever order the rows came back. Versioning is contentVersion's job,
 *     below, and the two are kept apart on purpose.
 */
import { createHash } from 'node:crypto';
import { asObject, str } from './types';

/**
 * The scheme, with its version.
 *
 * VERSIONED BECAUSE CHANGING THE FORMAT IS A DATA MIGRATION. Every id ever
 * minted is stored, and a v1 id has to keep meaning what it meant - if the
 * format changed under the same prefix, every existing record would look like a
 * new one on the next sync and the whole year would import again. A change
 * bumps the number and comes with a plan for the rows already on disk.
 */
export const DERIVED_ID_SCHEME = 'cutos:1';

/**
 * The provider slug, lowercase, as written to `provider` columns.
 *
 * It lives in this pure module rather than in the writer because a derived
 * identity names it, and the mapper - which must stay free of `server-only`
 * imports so it can be tested with a JSON literal - is what mints one. The
 * writer re-exports it, so there is still one spelling of it in the codebase.
 */
export const GOOGLE_HEALTH_PROVIDER = 'google-health';

/** Where a record's identity came from. Stored as part of the id's shape. */
export type IdentitySource = 'PROVIDER' | 'DERIVED';

/** True for an id CUT OS minted, false for one Google supplied. */
export function isDerivedExternalId(externalId: string): boolean {
  return externalId.startsWith(`${DERIVED_ID_SCHEME}/`);
}

/**
 * A component, reduced to a character set that cannot break the format.
 *
 * `~` and `/` are the separators, so they are replaced rather than escaped -
 * an escape scheme is one more thing to get wrong, and no real platform,
 * manufacturer or device name is distinguished only by punctuation. An empty or
 * absent component becomes `-`, which keeps the SHAPE of the id fixed: a
 * response with no device metadata and one with an unreadable device name
 * produce ids with the same number of fields, so the format stays readable and
 * a missing part is visible rather than silently closing a gap.
 */
function slug(value: unknown): string {
  const text = str(value);
  if (text === null) return '-';
  const cleaned = text.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? '-' : cleaned.slice(0, 48);
}

/**
 * The recording source, as four fields in a fixed order.
 *
 * WHY THE SOURCE IS PART OF THE IDENTITY. A phone and a watch both report steps
 * for the same day, and they are two measurements of it, not one. Folding the
 * source in keeps them apart; leaving it out would make the second overwrite
 * the first and the day would report whichever device synced last.
 *
 * Every part is optional (the guide's own examples show points with a bare
 * `dataSource`, and some with none), so each is independently allowed to be
 * absent without changing what the rest mean.
 */
export function sourceFingerprint(dataSource: unknown): string {
  const source = asObject(dataSource);
  const device = asObject(source?.device);
  return [
    slug(source?.platform),
    slug(source?.recordingMethod),
    slug(device?.manufacturer),
    slug(device?.displayName),
  ].join('~');
}

/** The timing a derived id is built on. Mirrors RecordTiming in mapper.ts. */
export interface IdentityTiming {
  observedAt: string | null;
  intervalStart: string | null;
  intervalEnd: string | null;
  localDate: string;
}

/**
 * The timing component: the most specific thing the record actually said.
 *
 * An instant beats an interval beats a date, because that is the order of
 * precision and a derived id must not claim more precision than the record had.
 * A DAILY record has only a date and that is not a shortcoming - it is a
 * statement about a calendar day, and `d=` says so.
 */
function timingComponent(timing: IdentityTiming): string {
  if (timing.observedAt !== null) return `t=${timing.observedAt}`;
  if (timing.intervalStart !== null) {
    return `i=${timing.intervalStart}..${timing.intervalEnd ?? '-'}`;
  }
  if (timing.intervalEnd !== null) return `i=-..${timing.intervalEnd}`;
  return `d=${timing.localDate}`;
}

export interface DerivedIdInput {
  provider: string;
  dataType: string;
  timing: IdentityTiming;
  dataSource: unknown;
  /**
   * What separates two points that share a data type, a time and a source.
   *
   * Most types need none: a sample is identified by its instant, a daily record
   * by its date. Some do - `time-in-heart-rate-zone` returns one point per zone
   * over the SAME interval from the SAME source, and without the zone name
   * those points collapse onto one id and all but one is lost. The registry
   * entry names them, so the fact lives with the data type rather than here.
   */
  discriminators?: readonly (string | number | null | undefined)[];
}

/** The identity CUT OS mints when the provider supplies none. */
export function derivedExternalId(input: DerivedIdInput): string {
  const parts = [
    DERIVED_ID_SCHEME,
    slug(input.provider),
    slug(input.dataType),
    timingComponent(input.timing),
    `s=${sourceFingerprint(input.dataSource)}`,
  ];
  const extra = (input.discriminators ?? [])
    .map((value) => (value === null || value === undefined ? null : slug(String(value))))
    .filter((value): value is string => value !== null && value !== '-');
  if (extra.length > 0) parts.push(`k=${extra.join('~')}`);
  return parts.join('/');
}

/**
 * JSON with its object keys in a fixed order, at every depth.
 *
 * `JSON.stringify` preserves insertion order, and the API is under no
 * obligation to serialise a record's fields the same way twice. Without this,
 * an identical payload arriving with two fields transposed would digest
 * differently and read as a correction - which would supersede a perfectly good
 * observation and write a new one saying the same thing, on every sync, forever.
 * Array order is preserved: in a list of sleep stages, order is meaning.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * A version for a record the provider did not version.
 *
 * WHY THIS EXISTS AT ALL. The idempotency index keys on the provider's
 * `updateTime`, and most rollup points do not carry one. Every version is then
 * null, every re-read of a day looks like the record already on file, and the
 * day is frozen at whatever the first sync happened to see - which for TODAY,
 * still accumulating, is a partial step count that never gets corrected. That
 * is worse than a duplicate: it is a wrong number that looks settled.
 *
 * So the content of the record becomes its version. Byte-identical re-reads
 * digest the same and are refused by the database exactly as before; a revised
 * value digests differently and arrives as a correction that supersedes its
 * predecessor. Both rows survive, one counts, and the history is intact - the
 * same bargain external_updated_at already strikes for a provider that does
 * version its records.
 *
 * SHA-256 over the canonical form: this is a version key, not a security
 * boundary, but a digest that can collide across the versions of one record is
 * a measurement silently not applied, and there is no reason to accept that
 * risk for a few bytes.
 */
export function contentVersion(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 32);
}
