/**
 * The Google Health API boundary.
 *
 * DELIBERATELY PERMISSIVE, AND THAT IS THE DESIGN. The Hevy schemas in
 * ../hevy/types.ts are tight because Hevy's documentation gives every response
 * field. The Google Health documentation supplied with this work is a rendered
 * copy of the guide pages, and on those pages the "Response" panes are
 * collapsed tabs: concrete response JSON exists for `exercise` (from the
 * codelab), for `active-energy-burned`, and for a `sleep` write body. For the
 * other thirty-odd data types the field names appear in prose and nowhere else.
 *
 * Validating strictly against a shape that was inferred from prose would mean
 * an unrecognised field FAILS a sync rather than being kept. That is exactly
 * backwards: the payload is stored verbatim in external_observations either
 * way, so the cost of tolerance is a value that has to be looked for carefully,
 * and the cost of strictness is a measurement that never arrives.
 *
 * So: the envelope is validated (it is documented, and getting it wrong means
 * pagination breaks silently), and the measurement itself is read by the
 * tolerant accessors below, each of which returns null rather than throwing.
 *
 * `name` IS OPTIONAL, AND THAT IS THE API'S RULE, NOT A CONCESSION. Google
 * documents DataPoint.name as supported only for a subset of identifiable data
 * types; for most types - the steps list response among them - a point arrives
 * with a `dataSource` and its body and no `name` at all. Requiring it here was
 * how the first real sync came to reject well-formed responses, so it is now
 * read when present, preserved exactly, and absent otherwise. What replaces it
 * as an identity is minted in identity.ts, from the fields that actually
 * identify the observation.
 *
 * A POINT IS PARSED ON ITS OWN, NOT WITH THE PAGE. parseDataPoints validates
 * each element separately, so one unreadable point costs one measurement rather
 * than the thousand it shared a page with. That was the second half of the same
 * bug: the failure was at the envelope, so a single bad element discarded the
 * whole window and the sync then skipped the rest of the data type.
 *
 * ONE OBSERVED DISCREPANCY, WORTH NAMING. The workouts guide documents the
 * exercise summary field as `distanceMillimeters`. The actual response captured
 * in the codelab spells it `distanceMillimiters`. Both are read - see
 * registry.ts - because the misspelling is what the API was observed to send
 * and the correct spelling is what the documentation promises.
 */
import { z } from 'zod';

/** Everything the API returns is optional-or-null somewhere. Both mean absent. */
const nullish = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((v) => v ?? null);

/**
 * The list envelope, which every read endpoint shares.
 *
 * `dataPoints` may be absent entirely on an empty window rather than an empty
 * array, so it defaults. `nextPageToken` is an empty string when there is no
 * next page - the codelab response shows exactly that - so "" and absent are
 * both normalised to null and neither can start an infinite loop.
 */
export const dataPointSchema = z.looseObject({
  /**
   * users/{uid}/dataTypes/{type}/dataPoints/{id}, WHERE THE API SENDS ONE.
   *
   * Optional, because Google's documentation says it is: only a subset of
   * identifiable data types carry a name, and for the majority the field "may
   * be empty".
   *
   * EMPTY MEANS EMPTY, AND THAT INCLUDES "". The documentation's word is
   * empty, not absent, so a zero-length string is a shape this has to accept -
   * `.min(1)` would refuse the point outright, which is the very failure being
   * fixed, one field further in. It is normalised to null alongside an absent
   * field, because "" is not an identity anything can be keyed on: every
   * nameless point of a type would collide on it.
   *
   * A name that IS present passes through untouched. It is the provider's own
   * id and the only correct thing to do with it is preserve it.
   */
  name: z.string().nullish().transform((v) => (v ? v : null)),
  dataSource: nullish(z.looseObject({
    recordingMethod: nullish(z.string()),
    platform: nullish(z.string()),
    device: nullish(z.looseObject({
      formFactor: nullish(z.string()),
      manufacturer: nullish(z.string()),
      displayName: nullish(z.string()),
    })),
  })),
});

/**
 * A data point that passed validation, KEPT EXACTLY AS IT ARRIVED.
 *
 * Not `z.infer` of the schema above, and the difference matters twice over.
 * Parsing a loose object returns a NEW object with the schema's normalisations
 * baked in - an absent `name` becomes an explicit `name: null`, an absent
 * `device` becomes `device: null` - and if that were what travelled onward:
 *
 *   * external_observations.payload would hold this app's rendering of the
 *     record rather than the provider's (§17 says the opposite: the payload is
 *     what arrived, before anything interpreted it);
 *   * and the content digest would be taken over that rendering, so adding one
 *     nullish field to this schema would change every record's version and
 *     re-import a year of history as corrections.
 *
 * So the schema is a GATE - it decides whether a point is readable and says
 * precisely why when it is not - and the raw object is what passes through it.
 * Reading it is the tolerant accessors' job, as it already was for every field
 * below the identity.
 */
export type GoogleDataPoint = Record<string, unknown>;

/**
 * The envelope, with its points left unparsed.
 *
 * `z.unknown()` rather than the point schema, deliberately: the envelope's job
 * is pagination, and a page whose points are individually questionable is still
 * a page whose `nextPageToken` must be honoured. The points are validated one
 * at a time by parseDataPoints below.
 */
export const listResponseSchema = z.looseObject({
  dataPoints: z.array(z.unknown()).default([]),
  nextPageToken: nullish(z.string()).transform((v) => (v ? v : null)),
});

/** A point that could not be read, and the shortest true reason why. */
export interface RejectedDataPoint {
  /** Its position in the page, so a diagnostic can point at something. */
  index: number;
  reason: string;
}

/** A page of points, after each has been validated on its own. */
export interface GoogleDataPointPage {
  dataPoints: GoogleDataPoint[];
  nextPageToken: string | null;
  rejected: RejectedDataPoint[];
}

/**
 * One zod issue as a single line.
 *
 * The failing sync reported `parsed.error.message` - the serialised issue
 * ARRAY, several hundred characters of JSON - once per data type, which is how
 * one wrong assumption became a wall of identical text in Settings. A reason is
 * a path and a sentence; the count belongs to the aggregator, not to the text.
 */
function issueLine(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : 'the data point';
  return `${path}: ${issue.message}`;
}

/**
 * Validates a page's points one at a time.
 *
 * Returns everything that parsed and a short reason for everything that did
 * not, so the caller can keep the good measurements AND say what it lost. A
 * point is only rejected when it is not an object at all or its identity and
 * source fields are the wrong SHAPE - an unrecognised extra field is kept, as
 * the header explains, because the payload is stored verbatim either way.
 */
export function parseDataPoints(
  raw: readonly unknown[],
): { points: GoogleDataPoint[]; rejected: RejectedDataPoint[] } {
  const points: GoogleDataPoint[] = [];
  const rejected: RejectedDataPoint[] = [];

  raw.forEach((element, index) => {
    const parsed = dataPointSchema.safeParse(element);
    if (parsed.success) {
      // `element`, not `parsed.data`: see GoogleDataPoint above. What is stored
      // and what is digested has to be what the provider actually sent.
      points.push(element as Record<string, unknown>);
      return;
    }
    const first = parsed.error.issues[0];
    rejected.push({
      index,
      reason: first === undefined ? 'it could not be read' : issueLine(first),
    });
  });

  return { points, rejected };
}

/**
 * The identity endpoint. Called once at connect time and cached forever - the
 * documentation states the mapping does not change.
 */
export const identitySchema = z.looseObject({
  healthUserId: nullish(z.string()),
  googleUserId: nullish(z.string()),
  fitbitUserId: nullish(z.string()),
});
export type GoogleIdentity = z.infer<typeof identitySchema>;

/** The OAuth token endpoint's response. */
export const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: nullish(z.number()),
  refresh_token: nullish(z.string()),
  scope: nullish(z.string()),
  token_type: nullish(z.string()),
  /**
   * Present, and short, while the OAuth app is in Testing: the documentation
   * states a testing-mode refresh token expires after seven days, and the
   * codelab response shows 604799 seconds. Read so the UI can say when a
   * reconnection will be needed instead of presenting an expiry as a failure.
   */
  refresh_token_expires_in: nullish(z.number()),
});
export type GoogleTokenResponse = z.infer<typeof tokenResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Tolerant accessors.                                                       */
/*                                                                           */
/* Each returns null for anything it cannot read. That is the whole point:    */
/* a field that is absent, misspelled, or a shape nobody documented must      */
/* leave a null - which downstream means "not measured" - and never a zero.   */
/* ------------------------------------------------------------------------ */

/** A plain object, or null. The guard every accessor below starts from. */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Walks a dotted path without throwing on a missing or non-object link. */
export function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    const object = asObject(current);
    if (object === null) return undefined;
    current = object[key];
  }
  return current;
}

/**
 * A number, from a number or from a string.
 *
 * The API serialises 64-bit integers as strings to preserve precision - the
 * vitals guide says so explicitly of `beatsPerMinute`, and the codelab response
 * shows `"steps": "2038"` - so a reader that only accepts numbers silently
 * loses every step count. An empty string is absent, not zero.
 */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A number at a dotted path, or the first path that yields one. */
export function numAt(value: unknown, ...paths: string[]): number | null {
  for (const path of paths) {
    const found = num(at(value, path));
    if (found !== null) return found;
  }
  return null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function strAt(value: unknown, ...paths: string[]): string | null {
  for (const path of paths) {
    const found = str(at(value, path));
    if (found !== null) return found;
  }
  return null;
}

/**
 * A protobuf Duration, which the API renders as a seconds string with a
 * trailing "s" ("1800s", "900s"). Returns seconds.
 */
export function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = str(value);
  if (text === null) return null;
  const parsed = Number(text.endsWith('s') ? text.slice(0, -1) : text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** An ISO instant that parses, or null. */
export function instantAt(value: unknown, ...paths: string[]): string | null {
  for (const path of paths) {
    const text = str(at(value, path));
    if (text !== null && !Number.isNaN(Date.parse(text))) {
      return new Date(text).toISOString();
    }
  }
  return null;
}

/**
 * A google.type.Date - { year, month, day } - as YYYY-MM-DD.
 *
 * The daily record types are dated rather than timestamped, and the day is the
 * user's civil day with no instant attached. Rendering it as a date string
 * keeps it that way; turning it into midnight UTC would invent a time nobody
 * recorded and would land some users on the wrong day.
 */
export function civilDateAt(value: unknown, ...paths: string[]): string | null {
  for (const path of paths) {
    const raw = at(value, path);
    const text = str(raw);
    if (text !== null && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const object = asObject(raw);
    if (object === null) continue;
    const year = num(object.year);
    const month = num(object.month);
    const day = num(object.day);
    if (year === null || month === null || day === null) continue;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

/** The UTC offset the API attaches to an interval, as seconds. */
export function offsetSecondsAt(value: unknown, ...paths: string[]): number | null {
  for (const path of paths) {
    const found = durationSeconds(at(value, path));
    if (found !== null) return found;
  }
  return null;
}

/** Page-size ceilings, from the "Query historical data" guidance. */
export const MAX_PAGE_SIZE = {
  /** "for certain data types like exercise and sleep ... capped at 25". */
  session: 25,
  /** "For most data types, page sizes are capped at a maximum of 10,000." */
  standard: 1000,
} as const;

/**
 * Maximum query ranges for the aggregation endpoints, from the data-types
 * guide. Exceeding one is a 400, so the sync chunks its windows to fit.
 */
export const MAX_ROLLUP_RANGE_DAYS = {
  short: 14,
  standard: 90,
} as const;

/** The data types whose rollup range is the short one. */
export const SHORT_RANGE_DATA_TYPES = new Set([
  'calories-in-heart-rate-zone', 'heart-rate', 'active-minutes', 'total-calories',
]);
