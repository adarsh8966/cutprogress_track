-- 0010_session_intensity.sql
-- Spec §11 (workout logging), §13 (cardio), §8 (paste ingestion).
--
-- The paste importer reads heart-rate and energy figures that a workout summary
-- routinely carries - "Avg HR: 142 bpm", "Max HR: 174 bpm", "Calories burned:
-- 430" - and until now they had nowhere to go. A field with no column is a field
-- the review screen cannot honestly promise to save, so the columns are added
-- rather than the values quietly dropped.
--
-- Scope is deliberately narrow. Only what an existing table already almost
-- describes is added:
--
--   cardio_sessions   already had average_heart_rate; it gains max_heart_rate.
--   workout_sessions  had no intensity columns at all; it gains the same pair
--                     plus calories, mirroring cardio_sessions exactly.
--
-- NOT added, on purpose:
--   * pace / speed  - fully determined by distance_km and duration_minutes.
--     Storing a derived value invites the two disagreeing.
--   * per-zone minutes - hr_zone stays ONE zone for the session, which is what
--     daily_metrics.zone2_minutes sums (lib/data/canonicalise.ts).
--
-- Every column is nullable. NULL means the summary did not report it, never
-- zero (spec §7/§33).

alter table cardio_sessions
  add column if not exists max_heart_rate numeric(5, 1)
    check (max_heart_rate is null or (max_heart_rate between 25 and 250));

alter table workout_sessions
  add column if not exists average_heart_rate numeric(5, 1)
    check (average_heart_rate is null or (average_heart_rate between 25 and 250)),
  add column if not exists max_heart_rate numeric(5, 1)
    check (max_heart_rate is null or (max_heart_rate between 25 and 250)),
  add column if not exists calories numeric(7, 1)
    check (calories is null or calories >= 0);

-- A maximum below the average is a transcription error, not a measurement.
-- Declared with drop-then-add (as in 0006) so the migration stays re-runnable:
-- ADD CONSTRAINT has no IF NOT EXISTS form.
alter table cardio_sessions
  drop constraint if exists cardio_sessions_hr_ordered;
alter table cardio_sessions
  add constraint cardio_sessions_hr_ordered
  check (
    average_heart_rate is null
    or max_heart_rate is null
    or max_heart_rate >= average_heart_rate
  );

alter table workout_sessions
  drop constraint if exists workout_sessions_hr_ordered;
alter table workout_sessions
  add constraint workout_sessions_hr_ordered
  check (
    average_heart_rate is null
    or max_heart_rate is null
    or max_heart_rate >= average_heart_rate
  );

comment on column cardio_sessions.max_heart_rate is
  'Peak bpm for the session. NULL means not reported. Spec §13.';
comment on column workout_sessions.average_heart_rate is
  'Mean bpm across the session. NULL means not reported. Spec §11.';
comment on column workout_sessions.max_heart_rate is
  'Peak bpm for the session. NULL means not reported. Spec §11.';
comment on column workout_sessions.calories is
  'Energy burned during the session as reported by the source, kcal. NULL means not reported.';
