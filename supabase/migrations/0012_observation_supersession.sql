-- 0012_observation_supersession.sql
-- Spec §6 (observations), §17 (provenance), §33 (missing is not zero),
-- §48 (history is permanent).
--
-- WHAT THIS IS FOR. A mistaken record had no way out. The observation tables
-- have no delete policy at all - deliberately, that is §48 enforced by the
-- absence of a policy rather than by convention - so a weight typed against
-- the wrong day, or a nutrition log entered twice, stayed in the raw layer
-- with nothing the user could do about it.
--
-- For most fields that was survivable: daily_metrics RESOLVES scalars, the
-- newest observation wins, and logging the right value again is a correction.
-- What that cannot express is "this measurement should not count at all".
-- There is no value to enter that means "I did not weigh myself that day" -
-- entering 0 would be a fabricated measurement, which is the one thing this
-- system must never store.
--
-- So the same mechanism 0011 gave sessions is extended to the four scalar
-- observation tables, with the same rules and for the same reason: a
-- correction is a NEW row, the row it replaces is MARKED, and nothing is ever
-- updated in place or deleted. Both observations survive; only one counts.
--
-- WHY THE WRITE STAYS NARROW. 0008_rls.sql puts these tables in the immutable
-- group - select and insert, no update, no delete. Promoting them to updatable
-- would make every measurement editable in place and quietly undo §48. Instead
-- the update privilege is granted on the two supersession columns ALONE, with
-- a column-level GRANT. Postgres requires both the column privilege and the
-- RLS policy, so:
--
--     update body_measurements set weight_kg = 999      -- still refused
--     update body_measurements set superseded_at = now() -- allowed, own rows
--
-- The measurement stays immutable. The bookkeeping around it does not. This is
-- exactly what 0011 did for cardio_sessions, and it is repeated rather than
-- generalised so that each table's privileges are readable on their own.

--------------------------------------------------------------------------------
-- The audit vocabulary.
--
-- Spec §41: a change to what the app reports appears in the audit log, with the
-- reason behind it. Withdrawing an observation changes every figure the day
-- feeds, so it needs a kind of its own rather than being filed under something
-- that nearly fits.
--
-- ADD VALUE IF NOT EXISTS keeps the migration re-runnable. It may run inside a
-- transaction (PostgreSQL 12+) as long as the new value is not USED in the same
-- transaction, which it is not - the first use is at runtime.
--------------------------------------------------------------------------------
alter type system_event_kind add value if not exists 'OBSERVATION_SUPERSEDED';
alter type system_event_kind add value if not exists 'OBSERVATION_RESTORED';

--------------------------------------------------------------------------------
-- The columns.
--------------------------------------------------------------------------------
alter table body_measurements
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references body_measurements (id);

alter table metric_observations
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references metric_observations (id);

alter table nutrition_logs
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references nutrition_logs (id);

alter table sleep_records
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references sleep_records (id);

--------------------------------------------------------------------------------
-- The invariants, as CHECKs rather than as application care.
--
-- superseded_by without superseded_at would be a row that claims a replacement
-- but cannot say when, and a row that supersedes itself is a cycle of one.
-- Declared drop-then-add (as in 0006 and 0011) so the migration stays
-- re-runnable: ADD CONSTRAINT has no IF NOT EXISTS form.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'body_measurements',
    'metric_observations',
    'nutrition_logs',
    'sleep_records'
  ] loop
    execute format(
      'alter table %I drop constraint if exists %I', t, t || '_supersession_coherent');
    execute format(
      'alter table %I add constraint %I check (superseded_by is null or superseded_at is not null)',
      t, t || '_supersession_coherent');

    execute format(
      'alter table %I drop constraint if exists %I', t, t || '_not_self_superseding');
    execute format(
      'alter table %I add constraint %I check (superseded_by is null or superseded_by <> id)',
      t, t || '_not_self_superseding');
  end loop;
end $$;

--------------------------------------------------------------------------------
-- The indexes.
--
-- Every read is "the live observations for this day", so that is the shape.
--------------------------------------------------------------------------------
create index if not exists body_measurements_live_idx
  on body_measurements (user_id, local_date desc) where superseded_at is null;
create index if not exists metric_observations_live_idx
  on metric_observations (user_id, metric, local_date desc) where superseded_at is null;
create index if not exists nutrition_logs_live_idx
  on nutrition_logs (user_id, local_date desc) where superseded_at is null;
create index if not exists sleep_records_live_idx
  on sleep_records (user_id, local_date desc) where superseded_at is null;

--------------------------------------------------------------------------------
-- The narrow write.
--
-- 0008_rls.sql ends with a blanket `grant ... update ... on all tables`, so the
-- privilege has to be taken back here and re-granted per column. The order
-- matters: the revoke must run after that blanket grant, which is why this
-- lives in a later migration rather than beside the table definitions.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'body_measurements',
    'metric_observations',
    'nutrition_logs',
    'sleep_records'
  ] loop
    execute format('revoke update on %I from authenticated', t);
    execute format(
      'grant update (superseded_at, superseded_by) on %I to authenticated', t);

    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format(
      'create policy %I on %I for update to authenticated '
      || 'using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_update', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- Documentation lives with the columns, because the next person to read this
-- schema will read it there.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'body_measurements',
    'metric_observations',
    'nutrition_logs',
    'sleep_records'
  ] loop
    execute format(
      'comment on column %I.superseded_at is %L', t,
      'When a correction replaced this observation, or when the user withdrew '
      || 'it. NULL means this row is live. The row is never deleted.');
    execute format(
      'comment on column %I.superseded_by is %L', t,
      'The observation that replaced this one, when there is one. NULL for a '
      || 'withdrawal, which replaces the reading with no reading at all.');
  end loop;
end $$;
