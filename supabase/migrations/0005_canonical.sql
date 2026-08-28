-- 0005_canonical.sql
-- THE CANONICAL LAYER (spec §7, §16, §17).
--
-- daily_metrics holds ONE resolved row per user per local date. It is derived
-- from the raw observation tables in 0003/0004 by a deterministic, documented
-- resolver (lib/normalization/canonical.ts) that picks a winner per field using
-- the configurable source priority in data_sources, and records which
-- observation won in the provenance column.
--
-- daily_metrics is a CACHE of a pure function over the raw layer. It can always
-- be rebuilt from scratch, so a resolver bug is never data loss.
--
-- EVERY metric column is nullable and NULL means "not logged". It does not mean
-- zero (spec §7/§33). This is the single easiest way to ruin health analytics
-- and the schema is built so that it cannot happen by accident.

create table if not exists data_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source data_source not null,
  -- Lower number wins a conflict. Spec §16's default ordering is
  -- MANUAL < HEALTH_CONNECT < BEVEL < IMPORT_TEXT < ESTIMATED.
  priority smallint not null,
  enabled boolean not null default true,
  notes text,

  unique (user_id, source)
);

comment on table data_sources is
  'Per-user, configurable source priority used to resolve conflicting observations. Spec §16.';

create table if not exists daily_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The user's LOCAL calendar date (spec §40).
  local_date date not null,

  -- Body
  weight_kg numeric(6, 3),
  waist_cm numeric(5, 1),

  -- Activity
  steps integer check (steps is null or steps >= 0),
  active_calories numeric(7, 1) check (active_calories is null or active_calories >= 0),
  total_calories_burned numeric(7, 1)
    check (total_calories_burned is null or total_calories_burned >= 0),
  workout_minutes numeric(6, 1)
    check (workout_minutes is null or workout_minutes >= 0),
  cardio_minutes numeric(6, 1)
    check (cardio_minutes is null or cardio_minutes >= 0),
  zone2_minutes numeric(6, 1)
    check (zone2_minutes is null or zone2_minutes >= 0),

  -- Recovery
  resting_heart_rate numeric(5, 1)
    check (resting_heart_rate is null or (resting_heart_rate between 25 and 250)),
  hrv_ms numeric(6, 1) check (hrv_ms is null or hrv_ms >= 0),
  sleep_duration_minutes numeric(6, 1)
    check (sleep_duration_minutes is null or (sleep_duration_minutes between 0 and 1440)),
  sleep_score numeric(5, 1)
    check (sleep_score is null or (sleep_score between 0 and 100)),

  -- Nutrition
  calories_consumed numeric(7, 1)
    check (calories_consumed is null or calories_consumed >= 0),
  protein_g numeric(6, 1) check (protein_g is null or protein_g >= 0),
  carbs_g numeric(6, 1) check (carbs_g is null or carbs_g >= 0),
  fat_g numeric(6, 1) check (fat_g is null or fat_g >= 0),
  fiber_g numeric(6, 1) check (fiber_g is null or fiber_g >= 0),

  -- Training
  training_sessions smallint
    check (training_sessions is null or training_sessions >= 0),

  -- Spec §16/§17: which observation won each field, and how confident we are.
  -- Shape: { "<field>": { "source": data_source, "confidence": confidence_level,
  --                       "observation_id": uuid|null, "candidates": int } }
  -- Validated in TypeScript by lib/normalization/provenance.ts.
  provenance jsonb not null default '{}'::jsonb,

  unique (user_id, local_date)
);

create index if not exists daily_metrics_user_date_idx
  on daily_metrics (user_id, local_date desc);

comment on table daily_metrics is
  'Canonical one-row-per-day resolved view of the raw layer. Rebuildable cache. Spec §7/§17.';
comment on column daily_metrics.provenance is
  'Per-field {source, confidence, observation_id} map. Spec §16.';
