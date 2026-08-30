-- 0014_hevy_training.sql
-- Hevy as the external source of TRAINING data (spec §11, §12, §15, §38, §48).
--
-- WHAT THIS IS FOR. CUT OS can record that a session happened and how hard it
-- was, but a pasted summary cannot say what was performed - so the Training
-- page's whole exercise half has been permanently empty, and volume, e1RM and
-- progression have had nothing to compute over. Hevy holds exactly that missing
-- half, with stable ids for all of it, behind a documented read API.
--
-- This migration does NOT add a Hevy workout model. Hevy becomes one more
-- writer into the tables that already exist: workout_sessions, workout_sets and
-- exercises. Every column below is nullable and additive, so a manual or pasted
-- row is unchanged and every existing query keeps working.
--
-- THREE THINGS ARE STRUCTURAL RATHER THAN CONVENTIONAL:
--
--  1. IDEMPOTENCY IS AN INDEX. workout_sessions gains a UNIQUE index on
--     (user_id, external_source, external_id). Syncing the same Hevy workout a
--     hundred times cannot produce a second session row, because the database
--     refuses it - not because the sync code remembered to check. That is the
--     same guarantee health_imports.idempotency_key gives a paste (§38), and it
--     also makes the 58 + 65 = 123 double-count migration 0011 exists to
--     prevent unreachable by this path: there is one row to update, always.
--
--  2. A REMOVED SET IS MARKED, NOT DELETED. workout_sets gains the same
--     supersession pair 0011 gave sessions and 0012 gave observations. Deleting
--     a workout in Hevy, or a set out of one, must not destroy what CUT OS
--     recorded (§48) - the row stops counting and stays on file.
--
--  3. AN EXERCISE CAN BE CREATED, BUT ONLY AN EXTERNAL ONE. Auto-creating an
--     exercise is impossible today: 0008_rls.sql gives `exercises` a SELECT
--     policy and nothing else, so an insert is refused. The policy added below
--     permits an insert ONLY when external_source is set, and the update grant
--     is narrowed to the two identity columns - so a Hevy exercise can be
--     created and an existing catalog row can be ADOPTED, while the catalog's
--     names, muscle groups and equipment stay exactly as the seed wrote them.

--------------------------------------------------------------------------------
-- workout_sessions: the workout's own identity and name.
--
-- session_type stays the closed enum the analytics group by. `title` is what
-- Hevy calls the workout ("Push Day"), which is not the same question - a title
-- that maps to nothing lands on OTHER and the name is still kept in full, the
-- same bargain lib/health/sessionTypes.ts already strikes for a pasted label.
--
-- average_heart_rate, max_heart_rate and calories are deliberately NOT written
-- by this path: Hevy's workout payload carries none of them, and NULL means
-- "not reported" rather than zero (§33).
--------------------------------------------------------------------------------
alter table workout_sessions
  add column if not exists title text,
  add column if not exists external_source text,
  add column if not exists external_id text,
  add column if not exists external_updated_at timestamptz;

-- A half-identified row - a source with no id, or an id with no source - could
-- not be looked up or de-duplicated, so it is not a state worth allowing.
-- Declared drop-then-add (as in 0006, 0011 and 0012) so the migration stays
-- re-runnable: ADD CONSTRAINT has no IF NOT EXISTS form.
alter table workout_sessions
  drop constraint if exists workout_sessions_external_identity_coherent;
alter table workout_sessions
  add constraint workout_sessions_external_identity_coherent
  check ((external_source is null) = (external_id is null));

-- THE IDEMPOTENCY GUARANTEE. Partial, so the millions of manual and pasted rows
-- that have no external identity are not forced to be distinct from each other.
create unique index if not exists workout_sessions_external_idx
  on workout_sessions (user_id, external_source, external_id)
  where external_source is not null;

comment on column workout_sessions.title is
  'The name the source gave this workout ("Push Day"). session_type is still the closed enum analytics group by; this is the label, kept whole.';
comment on column workout_sessions.external_source is
  'The system this session came from, e.g. HEVY. NULL for a session recorded here.';
comment on column workout_sessions.external_id is
  'That system''s stable id for the workout. UNIQUE per user with external_source: re-syncing cannot create a second row.';
comment on column workout_sessions.external_updated_at is
  'The source''s own updated_at, so a sync can tell an unchanged workout from an edited one.';

--------------------------------------------------------------------------------
-- workout_sets: the exercise block a set belongs to, and the set's own detail.
--
-- WHY THESE LIVE ON THE SET rather than on a workout_exercises row between the
-- session and its sets. A three-level model is tidier on paper and would touch
-- the FK, every training query, the manual logger, logSet and the analytics
-- LoggedSet type - a large blast radius, in a single-user app, for a
-- normalisation nobody reads. Carrying the exercise's index and note on each of
-- its sets denormalises one short string; reads reconstruct the block by
-- grouping on (exercise_index, exercise_id), which is what the session page
-- does anyway.
--
-- distance_km and duration_seconds are TRAINING measurements belonging to a set
-- (a loaded carry, a machine interval). They are never summed into
-- daily_metrics.cardio_minutes or written to cardio_sessions: cardio and
-- activity stay CUT OS's own, whatever an external training app happens to
-- record. Units follow the neighbours - km as in cardio_sessions.distance_km,
-- seconds as in the rest_seconds column right beside them.
--------------------------------------------------------------------------------
alter table workout_sets
  add column if not exists exercise_index smallint
    check (exercise_index is null or exercise_index >= 0),
  add column if not exists exercise_notes text,
  add column if not exists superset_id smallint,
  add column if not exists set_type text,
  add column if not exists distance_km numeric(7, 3)
    check (distance_km is null or distance_km >= 0),
  add column if not exists duration_seconds integer
    check (duration_seconds is null or duration_seconds >= 0),
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references workout_sets (id);

alter table workout_sets
  drop constraint if exists workout_sets_supersession_coherent;
alter table workout_sets
  add constraint workout_sets_supersession_coherent
  check (superseded_by is null or superseded_at is not null);
alter table workout_sets
  drop constraint if exists workout_sets_not_self_superseding;
alter table workout_sets
  add constraint workout_sets_not_self_superseding
  check (superseded_by is null or superseded_by <> id);

-- Every read is "the live sets of this session", so that is the shape.
create index if not exists workout_sets_live_idx
  on workout_sets (session_id) where superseded_at is null;

comment on column workout_sets.exercise_index is
  'Position of this set''s exercise within the workout, 0-based, as the source ordered it.';
comment on column workout_sets.exercise_notes is
  'The note attached to the EXERCISE, carried on each of its sets. Not a note about this one set.';
comment on column workout_sets.superset_id is
  'Groups exercises performed as a superset, as the source grouped them. NULL means not part of one.';
comment on column workout_sets.set_type is
  'The source''s own word for this set, verbatim and uninterpreted. Only the exact string "warmup" sets warmup = true; nothing else is read into meaning.';
comment on column workout_sets.distance_km is
  'Distance covered in this set. Training data - never summed into cardio_minutes.';
comment on column workout_sets.duration_seconds is
  'How long this set took. Seconds, matching rest_seconds beside it.';
comment on column workout_sets.superseded_at is
  'When this set stopped counting - removed at the source, or replaced. NULL means live. The row is never deleted.';
comment on column workout_sets.superseded_by is
  'The set that replaced this one, when there is one. NULL for a removal, which replaces the set with no set at all.';

--------------------------------------------------------------------------------
-- exercises: external identity, and the narrowest write that makes §3 possible.
--
-- NOTE ON RLS. `exercises` has RLS enabled but deliberately NOT forced (see
-- 0008), and that must stay true: 0009_seed_exercises.sql is an upsert run by
-- the migration owner, and forcing RLS would subject the seed to the policy
-- below - which refuses a row with no external_source - and break every future
-- re-seed. Table owners and the service role bypass RLS; `authenticated` does
-- not, which is the boundary that matters here.
--
-- The table has no user_id. It is shared reference data in a single-user
-- system, so the policies are unqualified rather than keyed to auth.uid(). A
-- second account would see another's Hevy exercises; it would also see an empty
-- app in every other respect, and giving this table a user_id is the change to
-- make before that ever stops being true.
--------------------------------------------------------------------------------
alter table exercises
  add column if not exists external_source text,
  add column if not exists external_id text;

alter table exercises
  drop constraint if exists exercises_external_identity_coherent;
alter table exercises
  add constraint exercises_external_identity_coherent
  check ((external_source is null) = (external_id is null));

-- One CUT OS exercise per external template, forever. This is what makes
-- "resolve by stable id" a lookup rather than a search.
create unique index if not exists exercises_external_idx
  on exercises (external_source, external_id)
  where external_source is not null;

-- An exercise can be CREATED, but only an externally-sourced one. The seeded
-- catalog cannot be added to through the application.
drop policy if exists exercises_insert on exercises;
create policy exercises_insert on exercises
  for insert to authenticated
  with check (external_source is not null);

-- ADOPTION, AND NOTHING ELSE. 0008 ends with a blanket
-- `grant ... update ... on all tables`, so the privilege is taken back here and
-- re-granted per column - the same pattern 0011 and 0012 use, and the order
-- matters: the revoke must run after that blanket grant. Postgres requires BOTH
-- the column privilege and the policy, so:
--
--     update exercises set name = 'whatever'          -- still refused
--     update exercises set external_id = '05293BCA'   -- allowed
--
-- Linking an existing catalog row to its Hevy template is therefore possible;
-- rewriting what that row IS is not. No delete policy exists, here as everywhere.
revoke update on exercises from authenticated;
grant update (external_source, external_id) on exercises to authenticated;

drop policy if exists exercises_update on exercises;
create policy exercises_update on exercises
  for update to authenticated
  using (true) with check (external_source is not null);

comment on column exercises.external_source is
  'The system this exercise was created from or adopted by, e.g. HEVY. NULL for a catalog row nothing external has claimed.';
comment on column exercises.external_id is
  'That system''s stable template id. UNIQUE with external_source, so a rename at the source can never fork an exercise into two.';

--------------------------------------------------------------------------------
-- sync_runs: what a synchronisation did, so it can be debugged (spec §41).
--
-- Not an audit-log kind. system_events records changes to what the app REPORTS;
-- this records the mechanics of a run, which is a different question with
-- different columns and a different reader (/import). A sync writes to the
-- audit log exactly once, and only when it withdraws a workout deleted at the
-- source.
--
-- A run that fails leaves cursor_after NULL and the next run re-reads the same
-- window. That is safe by construction rather than by luck: every write this
-- path performs is keyed - the session by its external id, the set by its
-- exercise and number - so replaying an event changes nothing that is already
-- correct.
--------------------------------------------------------------------------------
create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  provider text not null,
  triggered_by text not null default 'MANUAL'
    check (triggered_by in ('MANUAL', 'SCHEDULED')),

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),

  events_found integer not null default 0 check (events_found >= 0),
  workouts_created integer not null default 0 check (workouts_created >= 0),
  workouts_updated integer not null default 0 check (workouts_updated >= 0),
  workouts_unchanged integer not null default 0 check (workouts_unchanged >= 0),
  workouts_deleted integer not null default 0 check (workouts_deleted >= 0),
  exercises_created integer not null default 0 check (exercises_created >= 0),
  exercises_matched integer not null default 0 check (exercises_matched >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),

  -- Everything the run could not do cleanly but carried on through, named.
  warnings jsonb not null default '[]'::jsonb,
  error text,

  -- The window this run read, and the one the next run should start from.
  -- cursor_after stays NULL unless the run finished cleanly.
  cursor_before timestamptz,
  cursor_after timestamptz,

  constraint sync_runs_finished_has_time
    check (status = 'RUNNING' or finished_at is not null)
);

-- Two syncs at once - the button pressed while the cron is running - would read
-- the same events and race each other's writes. Refused by the database rather
-- than by a lock the application has to remember to take.
create unique index if not exists sync_runs_one_running_idx
  on sync_runs (user_id, provider) where status = 'RUNNING';

create index if not exists sync_runs_user_provider_started_idx
  on sync_runs (user_id, provider, started_at desc);

-- 0008's blanket grant ran before this table existed, so it needs its own -
-- and DELETE is deliberately not in it. The observation tables hold the delete
-- privilege from that blanket grant and are stopped by the absent policy, which
-- silently affects no rows; withholding the privilege here refuses the attempt
-- outright instead. Same guarantee, stated more loudly.
grant select, insert, update on sync_runs to authenticated;

-- Authored record: written, then completed. Never deleted - a failed run is
-- exactly the one worth still having.
alter table sync_runs enable row level security;
alter table sync_runs force row level security;

drop policy if exists sync_runs_select on sync_runs;
create policy sync_runs_select on sync_runs
  for select to authenticated using (user_id = auth.uid());

drop policy if exists sync_runs_insert on sync_runs;
create policy sync_runs_insert on sync_runs
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists sync_runs_update on sync_runs;
create policy sync_runs_update on sync_runs
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table sync_runs is
  'One row per synchronisation attempt with an external provider. Never deleted: a failed run is the one worth keeping. Spec §41.';
comment on column sync_runs.cursor_after is
  'Where the next run should start. NULL when the run did not finish cleanly, so the window is simply re-read - every write on this path is keyed, so a replay is a no-op.';
