/**
 * A realistic week of pasted health data, for stress-testing the importer.
 *
 * This is deliberately imperfect, because a real week is. It mixes label
 * aliases, unit systems and formatting the way three different apps and a
 * person typing at 6am would, and it contains genuine mistakes the parser has
 * to refuse rather than absorb:
 *
 *   day 1  a full day: body, macros, activity, recovery, a workout with HR
 *   day 2  kilograms and metric distance; a workout AND two cardio sessions
 *   day 3  no weight; sleep written as "7 hours 15 minutes"; two workouts
 *   day 4  a rest day - steps only, plus a malformed calorie value
 *   day 5  British spellings, a duplicate field, an unknown field
 *   day 6  a named date, ragged whitespace, units written into labels
 *   day 7  a cardio-only day, plus a pace line that has nowhere to be stored
 *
 * The point of the fixture is not that everything parses. It is that what
 * parses is exactly right, what does not is reported, and the two never
 * contaminate each other.
 */

export const SEVEN_DAY_REPORT = [
  'Bevel weekly export',
  '',
  'Date: 2026-09-01',
  'Weight: 203.7 lb',
  'Waist: 35.4 in',
  'Calories: 2,001',
  'Protein: 172g',
  'Carbs: 198g',
  'Fat: 67g',
  'Fiber: 29g',
  'Steps: 15,000',
  'Active calories: 640',
  'Sleep: 7h 30m',
  'Resting HR: 58 bpm',
  'HRV: 71 ms',
  'Workout: Push',
  'Duration: 55 min',
  'Avg HR: 128 bpm',
  'Max HR: 161 bpm',
  'Calories burned: 430',
  '',
  'Date: 2026-09-02',
  'Weight: 92.4 kg',
  'Calories: 1,950',
  'Protein: 180 g',
  'Carbohydrates: 165g',
  'Fat: 58g',
  'Steps: 11,250',
  'Sleep: 450 min',
  'RHR: 57',
  'Workout: Pull',
  'Duration: 61 min',
  'Average heart rate: 124 bpm',
  'Cardio: Incline walk',
  'Duration: 30 min',
  'Distance: 2.4 km',
  'Zone: 2',
  'Cardio: Cycling',
  'Duration: 45 min',
  'Distance: 18.2 km',
  'Avg HR: 131 bpm',
  '',
  'Date: 2026-09-03',
  'Calories: 2,240',
  'Protein: 165g',
  'Carbs: 240g',
  'Fat: 71g',
  'Fibre: 24g',
  'Steps: 9,880',
  'Sleep: 7 hours 15 minutes',
  'HRV: 66ms',
  'Workout: Legs',
  'Duration: 1h 5m',
  'Max HR: 172 bpm',
  'Workout: Upper',
  'Duration: 40 min',
  '',
  'Date: 2026-09-04',
  'Steps: 4,102',
  'Sleep: 8h',
  'Calories: two thousand',
  '',
  'DATE: 2026-09-05',
  'weight: 202.9 LBS',
  'WAIST: 89 cm',
  'Calories: 1,875',
  'Protein: 158g',
  'Fibre: 31g',
  'Fiber: 27g',
  'Steps: 12,400',
  'Mood: pretty good',
  'Resting heart rate: 56 bpm',
  'Sleep: 6.75 hours',
  '',
  'Date: Sep 6, 2026',
  '   Weight (lb)  :  202.4   ',
  'Calories:1,990',
  'Protein:  175g',
  'Steps   13,207',
  'Active energy: 705',
  'Sleep: 7h 05m',
  'Workout: Full body',
  'Duration: 62 min',
  'Avg. HR: 133 bpm',
  '',
  'Date: 2026-09-07',
  'Weight: 202.1 lb',
  'Steps: 18,430',
  'Sleep: 8 hours 5 minutes',
  'HRV: 78 ms',
  'Cardio: Running',
  'Duration: 38 min',
  'Distance: 3.1 mi',
  'Avg HR: 152 bpm',
  'Max HR: 178 bpm',
  'Pace: 12:15 /mi',
  'Calories burned: 465',
].join('\n');

/** The days the fixture describes, in the order they are written. */
export const SEVEN_DAY_DATES = [
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-05', '2026-09-06', '2026-09-07',
];

/**
 * Input that is wrong in every way that matters, used to prove the parser
 * refuses rather than absorbs. None of these should produce a stored value.
 */
export const HOSTILE_REPORT = [
  'Date: 2026-10-01',
  'Weight: 9999 lb',
  'Waist: -12 in',
  'Calories: 1e6',
  'Protein: 0x40',
  'Carbs: Infinity',
  'Fat: NaN',
  'Steps: 12 000',
  'Sleep: 26h',
  'Resting HR: 900 bpm',
  'HRV: lots',
  'Duration: 45 min',
  'Distance: 5 km',
  'Random: nonsense',
].join('\n');
