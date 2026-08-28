-- 0002_profiles_goals.sql
-- Spec §4 (profiles) and §5 (goals).
--
-- Units: canonical storage is metric everywhere (kg, cm, km, kcal, minutes).
-- Column names carry the unit so a mismatch is visible in the schema itself.
-- Display units are a per-profile preference only. See docs/data-model.md §Units.

create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  height_cm numeric(5, 1),
  sex text check (sex in ('MALE', 'FEMALE', 'UNSPECIFIED')),
  date_of_birth date,

  -- Spec §40: daily aggregation happens in the user's local timezone, never UTC.
  timezone text not null default 'UTC',

  -- Display preferences. Storage stays metric regardless of these.
  weight_display_unit text not null default 'LB' check (weight_display_unit in ('LB', 'KG')),
  distance_display_unit text not null default 'MI' check (distance_display_unit in ('MI', 'KM')),
  length_display_unit text not null default 'IN' check (length_display_unit in ('IN', 'CM')),

  starting_weight_kg numeric(6, 3),
  target_weight_kg numeric(6, 3),

  phase phase not null default 'CUT',

  -- Daily targets. Nullable: an unset target is not a zero target (spec §33).
  target_calories integer check (target_calories is null or target_calories > 0),
  target_protein_g integer check (target_protein_g is null or target_protein_g >= 0),
  target_fiber_g integer check (target_fiber_g is null or target_fiber_g >= 0),
  target_steps integer check (target_steps is null or target_steps >= 0),
  target_training_sessions_per_week integer
    check (target_training_sessions_per_week is null
           or (target_training_sessions_per_week between 0 and 14)),
  target_cardio_minutes_per_week integer
    check (target_cardio_minutes_per_week is null or target_cardio_minutes_per_week >= 0),

  -- Spec §45: an aggressive-but-sane rate ceiling the user has explicitly accepted.
  max_weekly_loss_rate_pct numeric(4, 2) not null default 1.00
    check (max_weekly_loss_rate_pct > 0 and max_weekly_loss_rate_pct <= 2.00),

  cut_start_date date,

  constraint profiles_height_sane
    check (height_cm is null or (height_cm between 100 and 250)),
  constraint profiles_target_weight_sane
    check (target_weight_kg is null or (target_weight_kg between 30 and 300))
);

comment on table profiles is
  'One row per authenticated user. Baseline, targets and display preferences. Spec §4.';
comment on column profiles.timezone is
  'IANA timezone. Drives every daily rollup; see lib/normalization/dates.ts. Spec §40.';

-- Spec §5: multiple concurrent goals, each independently active.
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  goal_type goal_type not null,
  target_value numeric(10, 3) not null,
  -- Canonical unit the target_value is expressed in (e.g. 'kg', 'steps', 'kcal').
  unit text not null,
  start_date date not null,
  target_date date,
  active boolean not null default true,
  notes text,

  constraint goals_dates_ordered
    check (target_date is null or target_date >= start_date)
);

create index if not exists goals_user_active_idx
  on goals (user_id, active, goal_type);

comment on table goals is 'User-defined targets. Spec §5.';
