-- 0004_training.sql
-- Spec §10 (exercise library), §11 (workout logging), §12 (training analytics).

-- The canonical exercise library. Seeded in 0009 from data/exercises/catalog.json.
-- exercise_id is a stable human-readable slug so that re-seeding an updated
-- catalog never orphans historical workout_sets.
create table if not exists exercises (
  exercise_id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  name text not null,
  primary_muscle_group text not null,
  equipment text not null,

  -- Nippard tier where known. NULL means "not sourced", never a guessed value.
  nippard_tier text check (nippard_tier is null or nippard_tier in ('S', 'A', 'B', 'C')),

  muscle_subgroups text[] not null default '{}',
  demonstration_url text,
  active boolean not null default true,

  -- True for exercises performable with the user's apartment gym equipment.
  apartment_gym boolean not null default false
);

create index if not exists exercises_muscle_idx
  on exercises (primary_muscle_group) where active;

comment on table exercises is
  'Canonical exercise library, seeded from data/exercises/catalog.json. Spec §10.';
comment on column exercises.nippard_tier is
  'NULL means the tier was not sourced. Never inferred or fabricated. Spec §48.';

-- Spec §11. A training session.
create table if not exists workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  local_date date not null,
  start_time timestamptz,
  end_time timestamptz,
  duration_minutes numeric(6, 1)
    check (duration_minutes is null or (duration_minutes between 0 and 1440)),

  session_type session_type not null default 'OTHER',
  notes text,

  -- Spec §12: adherence needs planned-but-skipped sessions to be representable.
  completed boolean not null default true,

  source data_source not null default 'MANUAL',
  import_id uuid,

  constraint workout_sessions_interval_ordered
    check (start_time is null or end_time is null or end_time >= start_time)
);

create index if not exists workout_sessions_user_date_idx
  on workout_sessions (user_id, local_date desc);

comment on table workout_sessions is 'Append-only training sessions. Spec §11.';

-- Spec §11. One row per set performed.
create table if not exists workout_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references workout_sessions (id) on delete cascade,
  created_at timestamptz not null default now(),

  exercise_id text not null references exercises (exercise_id),
  set_number smallint not null check (set_number > 0),

  -- Stored in kg (canonical). Bodyweight movements may legitimately be 0 kg
  -- added load, which is a real measurement, not missing data.
  weight_kg numeric(6, 2) check (weight_kg is null or weight_kg >= 0),
  reps smallint check (reps is null or reps >= 0),

  rir numeric(3, 1) check (rir is null or (rir between 0 and 10)),
  rpe numeric(3, 1) check (rpe is null or (rpe between 1 and 10)),
  rest_seconds integer check (rest_seconds is null or rest_seconds >= 0),

  warmup boolean not null default false,
  to_failure boolean not null default false,

  notes text,

  unique (session_id, exercise_id, set_number)
);

create index if not exists workout_sets_user_exercise_idx
  on workout_sets (user_id, exercise_id);
create index if not exists workout_sets_session_idx on workout_sets (session_id);

comment on table workout_sets is
  'Append-only set-level training data. Working sets (warmup=false) drive volume and e1RM. Spec §11/§12.';
