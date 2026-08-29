-- 0003_raw_observations.sql
-- THE RAW LAYER (spec §6, §15, §17).
--
-- Every row here is an OBSERVATION: a thing that was measured or reported at a
-- point in time, by a named source. Observations are append-only. They are
-- never overwritten and never deleted (enforced in 0008_rls.sql by granting no
-- delete policy at all). Canonical, de-duplicated values are resolved into
-- daily_metrics (0005) from these rows, so the entire history can always be
-- reconstructed and any past resolution can be re-audited.
--
-- local_date is DERIVED: it is the calendar date of `measured_at` rendered in
-- the profile's timezone at write time (lib/normalization/dates.ts). It is
-- stored rather than computed because the profile timezone can change, and a
-- past observation must keep the date it was actually recorded under. Spec §40.

-- Spec §6. Weight and waist. Both nullable: an observation may carry either.
create table if not exists body_measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  measured_at timestamptz not null,
  local_date date not null,

  weight_kg numeric(6, 3) check (weight_kg is null or (weight_kg between 20 and 400)),
  waist_cm numeric(5, 1) check (waist_cm is null or (waist_cm between 30 and 250)),

  notes text,
  source data_source not null default 'MANUAL',
  import_id uuid,

  -- An observation carrying no measurement at all is meaningless.
  constraint body_measurements_has_a_value
    check (weight_kg is not null or waist_cm is not null)
);

create index if not exists body_measurements_user_date_idx
  on body_measurements (user_id, local_date desc);

comment on table body_measurements is
  'Append-only weight/waist observations. Never overwritten. Spec §6.';

-- Generic scalar observations with provenance (steps, HR, HRV, ...). Spec §17.
create table if not exists metric_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  metric metric_key not null,
  value numeric(12, 3) not null,

  measured_at timestamptz not null,
  local_date date not null,

  source data_source not null default 'MANUAL',
  import_id uuid,
  notes text,

  constraint metric_observations_non_negative check (value >= 0)
);

create index if not exists metric_observations_user_metric_date_idx
  on metric_observations (user_id, metric, local_date desc);

comment on table metric_observations is
  'Append-only scalar daily metrics with provenance. Spec §15/§17.';

-- Spec §8. One row per (day, source) nutrition report.
-- NOTE every macro is nullable. A day where protein was not recorded stores
-- NULL, never 0 (spec §7/§33) - otherwise analytics reads it as "ate no
-- protein" and every downstream average is wrong.
create table if not exists nutrition_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  local_date date not null,
  logged_at timestamptz not null default now(),

  calories numeric(7, 1) check (calories is null or calories >= 0),
  protein_g numeric(6, 1) check (protein_g is null or protein_g >= 0),
  carbs_g numeric(6, 1) check (carbs_g is null or carbs_g >= 0),
  fat_g numeric(6, 1) check (fat_g is null or fat_g >= 0),
  fiber_g numeric(6, 1) check (fiber_g is null or fiber_g >= 0),

  -- Spec §9: optional self-reported servings, used by the nutrition score.
  fruit_veg_servings numeric(4, 1)
    check (fruit_veg_servings is null or fruit_veg_servings >= 0),

  notes text,
  source data_source not null default 'MANUAL',
  import_id uuid
);

create index if not exists nutrition_logs_user_date_idx
  on nutrition_logs (user_id, local_date desc);

comment on table nutrition_logs is
  'Append-only per-day nutrition observations. NULL means not logged, not zero. Spec §8/§33.';

-- Individual food entries belonging to a nutrition log. Optional detail.
create table if not exists nutrition_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  nutrition_log_id uuid not null references nutrition_logs (id) on delete cascade,
  created_at timestamptz not null default now(),

  name text not null,
  quantity numeric(8, 2),
  unit text,

  calories numeric(7, 1) check (calories is null or calories >= 0),
  protein_g numeric(6, 1) check (protein_g is null or protein_g >= 0),
  carbs_g numeric(6, 1) check (carbs_g is null or carbs_g >= 0),
  fat_g numeric(6, 1) check (fat_g is null or fat_g >= 0),
  fiber_g numeric(6, 1) check (fiber_g is null or fiber_g >= 0)
);

create index if not exists nutrition_items_log_idx on nutrition_items (nutrition_log_id);

-- Spec §14. Recovery data. Never a hard gate on training - purely informational.
create table if not exists sleep_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- The date the sleep is attributed to (the morning the user woke up).
  local_date date not null,
  sleep_start timestamptz,
  sleep_end timestamptz,

  duration_minutes numeric(6, 1)
    check (duration_minutes is null or (duration_minutes between 0 and 1440)),
  sleep_score numeric(5, 1)
    check (sleep_score is null or (sleep_score between 0 and 100)),

  source data_source not null default 'MANUAL',
  import_id uuid,
  notes text,

  constraint sleep_records_interval_ordered
    check (sleep_start is null or sleep_end is null or sleep_end >= sleep_start)
);

create index if not exists sleep_records_user_date_idx
  on sleep_records (user_id, local_date desc);

comment on table sleep_records is
  'Append-only sleep observations. Informational only - recovery is never a hard gate. Spec §14.';

-- Spec §13.
create table if not exists cardio_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  local_date date not null,
  started_at timestamptz,

  cardio_type cardio_type not null,
  duration_minutes numeric(6, 1) not null check (duration_minutes >= 0),
  distance_km numeric(7, 3) check (distance_km is null or distance_km >= 0),
  average_heart_rate numeric(5, 1)
    check (average_heart_rate is null or (average_heart_rate between 25 and 250)),
  -- Heart-rate zone 1-5 where known. Zone 2 minutes drive the cardio analytics.
  hr_zone smallint check (hr_zone is null or (hr_zone between 1 and 5)),
  calories numeric(7, 1) check (calories is null or calories >= 0),

  notes text,
  source data_source not null default 'MANUAL',
  import_id uuid
);

create index if not exists cardio_sessions_user_date_idx
  on cardio_sessions (user_id, local_date desc);

comment on table cardio_sessions is 'Append-only cardio observations. Spec §13.';
