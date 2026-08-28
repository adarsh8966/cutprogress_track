-- 0008_rls.sql
-- ROW LEVEL SECURITY (spec §34, §48).
--
-- Two rules are enforced structurally here rather than by convention:
--
--  1. Isolation. Every user-owned table is filtered by user_id = auth.uid().
--     FORCE ROW LEVEL SECURITY is set so the policies apply even to the table
--     owner, which means a mistake in a privileged context still cannot leak
--     one user's data to another.
--
--  2. History is permanent. Spec §48 forbids overwriting raw records and
--     deleting historical observations. That is implemented by simply NOT
--     CREATING those policies: with RLS enabled and no delete policy, a delete
--     is refused no matter what the application code asks for. Corrections to a
--     measurement are made by inserting a superseding observation, never by
--     editing the original.
--
-- Which tables get which verbs is listed explicitly below so the intent is
-- auditable at a glance.

-- Reference data: readable by any signed-in user, written only by migrations
-- and the seed (service role bypasses RLS).
alter table exercises enable row level security;
drop policy if exists exercises_read on exercises;
create policy exercises_read on exercises
  for select to authenticated using (true);

--------------------------------------------------------------------------------
-- profiles: own row only. Select/insert/update. No delete.
--------------------------------------------------------------------------------
alter table profiles enable row level security;
alter table profiles force row level security;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

--------------------------------------------------------------------------------
-- IMMUTABLE OBSERVATIONS (spec §6, §17, §48)
-- select + insert only. No update. No delete. A correction is a new row.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'body_measurements',
    'metric_observations',
    'nutrition_logs',
    'nutrition_items',
    'sleep_records',
    'cardio_sessions'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = auth.uid())',
      t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (user_id = auth.uid())',
      t || '_insert', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- AUTHORED RECORDS: a workout is written over the course of a session, so a set
-- may be corrected while it is being logged. Still never deleted.
-- select + insert + update. No delete.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'workout_sessions',
    'workout_sets',
    'health_imports',
    'goals',
    'data_sources',
    'recommendations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = auth.uid())',
      t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (user_id = auth.uid())',
      t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format(
      'create policy %I on %I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_update', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- APPEND-ONLY AUDIT + PERMANENT RECORD: select + insert only.
-- system_events is the audit log (§41); context_exports is the historical
-- record of what was handed to ChatGPT (§30). Neither may be rewritten.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['system_events', 'context_exports'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = auth.uid())',
      t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (user_id = auth.uid())',
      t || '_insert', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- REBUILDABLE DERIVED CACHES: full CRUD. These are pure functions of the raw
-- layer (0005 header), so discarding and recomputing them loses nothing.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'daily_metrics',
    'daily_scores',
    'weekly_reviews',
    'monthly_reviews'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = auth.uid())',
      t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (user_id = auth.uid())',
      t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format(
      'create policy %I on %I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format(
      'create policy %I on %I for delete to authenticated using (user_id = auth.uid())',
      t || '_delete', t);
  end loop;
end $$;

-- nutrition_items is owned through its parent log but also carries user_id, so
-- the generic policy above already isolates it correctly.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
