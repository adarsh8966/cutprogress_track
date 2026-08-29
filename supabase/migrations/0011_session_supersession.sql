-- 0011_session_supersession.sql
-- Spec §6 (observations), §11 (workout logging), §13 (cardio), §38 (imports).
--
-- Re-importing a day that was already imported used to be the only way to
-- correct it, and daily_metrics SUMS a day's sessions rather than resolving
-- them (lib/data/canonicalise.ts). So importing Aug 28 as "Pull, 65 min" after
-- an earlier "Pull, 58 min" produced a 123-minute day: two true rows, one false
-- total. Neither row is wrong; the sum is.
--
-- The fix keeps the append-only rule rather than bending it. A correction is a
-- NEW row, exactly as it is everywhere else in the raw layer, and the row it
-- replaces is marked superseded. Nothing is updated in place and nothing is
-- deleted: both observations survive, and the aggregate counts only the live
-- one.
--
-- cardio_sessions is in the immutable-observations group (0008_rls.sql) with
-- select and insert only. Rather than promote the whole table to updatable,
-- the write is narrowed to the two supersession columns with a column-level
-- GRANT. Postgres requires BOTH the column privilege and the RLS policy, so
-- `update cardio_sessions set duration_minutes = 999` is still refused - the
-- measurement stays immutable while the bookkeeping around it does not.

alter table workout_sessions
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references workout_sessions (id);

alter table cardio_sessions
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by uuid references cardio_sessions (id);

-- A row cannot supersede itself, and the two columns move together: either the
-- row is live, or it names when and by what it was replaced.
alter table workout_sessions
  drop constraint if exists workout_sessions_supersession_coherent;
alter table workout_sessions
  add constraint workout_sessions_supersession_coherent
  check (superseded_by is null or superseded_at is not null);
alter table workout_sessions
  drop constraint if exists workout_sessions_not_self_superseding;
alter table workout_sessions
  add constraint workout_sessions_not_self_superseding
  check (superseded_by is null or superseded_by <> id);

alter table cardio_sessions
  drop constraint if exists cardio_sessions_supersession_coherent;
alter table cardio_sessions
  add constraint cardio_sessions_supersession_coherent
  check (superseded_by is null or superseded_at is not null);
alter table cardio_sessions
  drop constraint if exists cardio_sessions_not_self_superseding;
alter table cardio_sessions
  add constraint cardio_sessions_not_self_superseding
  check (superseded_by is null or superseded_by <> id);

-- Every aggregate reads "the live sessions for this day", so that is the shape
-- the index takes.
create index if not exists workout_sessions_live_idx
  on workout_sessions (user_id, local_date desc) where superseded_at is null;
create index if not exists cardio_sessions_live_idx
  on cardio_sessions (user_id, local_date desc) where superseded_at is null;

comment on column workout_sessions.superseded_at is
  'When a later observation replaced this one. NULL means this row is live. The row is never deleted.';
comment on column workout_sessions.superseded_by is
  'The session row that replaced this one, so a correction can be traced forwards.';
comment on column cardio_sessions.superseded_at is
  'When a later observation replaced this one. NULL means this row is live. The row is never deleted.';
comment on column cardio_sessions.superseded_by is
  'The session row that replaced this one, so a correction can be traced forwards.';

-- Fruit and veg servings: nutrition_logs has stored this since 0003 and the
-- nutrition score weights it at 10 of 100 (lib/analytics/scores.ts), but there
-- was no canonical column, so the Nutrition page passed a hard-coded null and
-- logging the field could never affect the score it was weighted in.
alter table daily_metrics
  add column if not exists fruit_veg_servings numeric(5, 1)
    check (fruit_veg_servings is null or fruit_veg_servings >= 0);

comment on column daily_metrics.fruit_veg_servings is
  'Resolved servings for the day. NULL means not logged, never zero. Spec §33.';

--------------------------------------------------------------------------------
-- The narrow write on cardio_sessions.
--
-- 0008_rls.sql ends with a blanket `grant ... update ... on all tables`, so the
-- privilege has to be taken back here and re-granted per column. Doing it in
-- this order matters: the revoke must run after that blanket grant.
--------------------------------------------------------------------------------
revoke update on cardio_sessions from authenticated;
grant update (superseded_at, superseded_by) on cardio_sessions to authenticated;

drop policy if exists cardio_sessions_update on cardio_sessions;
create policy cardio_sessions_update on cardio_sessions
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
