/**
 * Filter expressions, built rather than concatenated.
 *
 * PURE, AND SEPARATE FROM THE CLIENT, because the rules are fiddly enough to be
 * worth testing on their own and every one of them turns a mistake into a 400
 * rather than into wrong data:
 *
 *   - Only `>=` and `<` exist. Anything else is
 *     INVALID_DATA_POINT_FILTER_RESTRICTION_COMPARATOR.
 *   - Only AND exists. An OR is
 *     INVALID_DATA_POINT_FILTER_EXPRESSION_STRUCTURE.
 *   - Physical and civil time cannot be mixed in one expression:
 *     INVALID_DATA_POINT_FILTER_MIXED_TIME_RESTRICTIONS.
 *   - The data type is snake_case here and kebab-case in the path. Using the
 *     path form is INVALID_DATA_POINT_FILTER.
 *   - The field depends on the RECORD TYPE, and sleep is the odd one out: it is
 *     filtered on its END time, because a night that starts on the 3rd ends on
 *     the 4th and the 4th is the day it belongs to.
 *
 * The bounds are closed-open - `>= from` and `< to` - which is also how
 * lastNDays and dateRange in lib/normalization/dates.ts think, so a window is
 * the same window on both sides of the boundary.
 */
import type { DataTypeSpec } from './registry';

/**
 * The filter field for a data type, by record shape.
 *
 * CIVIL TIME IS USED THROUGHOUT, deliberately. Civil time is the user's own
 * clock, and a day in CUT OS is a day in the profile's timezone (§40). Asking
 * in physical time would mean computing UTC bounds for a local day, which is
 * exactly the arithmetic that goes wrong across a daylight-saving boundary and
 * exactly what the API's civil filters exist to avoid.
 */
export function filterFieldFor(spec: DataTypeSpec): string {
  switch (spec.record) {
    case 'DAILY':
      return `${spec.filterField}.date`;
    case 'SAMPLE':
      return `${spec.filterField}.sample_time.civil_time`;
    case 'SESSION':
      // Sleep is filtered on when it ENDED. The filters guide gives it its own
      // row for this reason, and it matches how sleep_records.local_date is
      // already defined here: the morning the user woke up.
      return spec.dataType === 'sleep'
        ? 'sleep.interval.civil_end_time'
        : `${spec.filterField}.interval.civil_start_time`;
    case 'INTERVAL':
      return `${spec.filterField}.interval.civil_start_time`;
  }
}

/**
 * A closed-open civil window: field >= from AND field < to.
 *
 * `to` is exclusive, so a single day is (day, day+1). The literals are bare
 * dates rather than midnight timestamps because the guide's own examples use
 * bare dates for civil bounds and a bare date carries no false precision.
 */
export function windowFilter(spec: DataTypeSpec, from: string, to: string): string {
  const field = filterFieldFor(spec);
  return `${field} >= "${from}" AND ${field} < "${to}"`;
}

/**
 * The same, for a physical-time interval - used when fetching the heart-rate
 * samples that fall inside a workout, where the question really is about
 * instants and not about anybody's calendar.
 *
 * Both bounds are physical here. Mixing one physical bound with one civil bound
 * is a documented 400, and it would be a subtle one: the request looks
 * reasonable and the error names a rule most readers have not met.
 */
export function instantFilter(spec: DataTypeSpec, fromIso: string, toIso: string): string {
  const field = spec.record === 'SAMPLE'
    ? `${spec.filterField}.sample_time.physical_time`
    : `${spec.filterField}.interval.start_time`;
  const from = new Date(fromIso).toISOString();
  const to = new Date(toIso).toISOString();
  return `${field} >= "${from}" AND ${field} < "${to}"`;
}
