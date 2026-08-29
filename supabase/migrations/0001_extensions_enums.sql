-- 0001_extensions_enums.sql
-- The enumerated vocabularies used across CUT OS.
--
-- Design note: enums are used where the value set is closed and safety-relevant
-- (data sources, recommendation templates). See docs/data-model.md.

-- No extensions are required. gen_random_uuid() has been core PostgreSQL since
-- 13, and every hash (import idempotency keys, context-pack content hashes) is
-- computed in TypeScript so the algorithm is unit-testable.

-- Spec §4 - the training/nutrition phase a profile is currently in.
do $$ begin
  create type phase as enum ('CUT', 'MAINTENANCE', 'REVERSE_DIET', 'LEAN_GAIN');
exception when duplicate_object then null; end $$;

-- Spec §15 - provenance. Every observation records where it came from.
do $$ begin
  create type data_source as enum (
    'MANUAL',
    'HEALTH_CONNECT',
    'GOOGLE_HEALTH',
    'BEVEL',
    'IMPORT_TEXT',
    'ESTIMATED',
    'OTHER'
  );
exception when duplicate_object then null; end $$;

-- Spec §16 - confidence attached to a canonical (resolved) value.
do $$ begin
  create type confidence_level as enum ('HIGH', 'MODERATE', 'LOW');
exception when duplicate_object then null; end $$;

-- Spec §5 - goal types the user can set.
do $$ begin
  create type goal_type as enum (
    'WEIGHT',
    'WAIST',
    'STEPS',
    'CALORIES',
    'PROTEIN',
    'TRAINING_FREQUENCY',
    'CARDIO_MINUTES',
    'RUNNING_DISTANCE'
  );
exception when duplicate_object then null; end $$;

-- Spec §26 - the shape of a training day.
do $$ begin
  create type session_type as enum (
    'UPPER',
    'LOWER',
    'PUSH',
    'PULL',
    'LEGS',
    'FULL_BODY',
    'CARDIO',
    'OTHER'
  );
exception when duplicate_object then null; end $$;

-- Spec §13 - cardio modalities.
do $$ begin
  create type cardio_type as enum (
    'WALKING',
    'INCLINE_WALKING',
    'RUNNING',
    'CYCLING',
    'OTHER'
  );
exception when duplicate_object then null; end $$;

-- Spec §23/§45 - recommendations are drawn from a CLOSED set of templates.
-- This is a safety mechanism: the system cannot emit an arbitrary protocol,
-- so it structurally cannot recommend extreme dieting. Adding a member here
-- is a deliberate, reviewable act.
do $$ begin
  create type recommendation_kind as enum (
    'MAINTAIN_CURRENT_INTAKE',
    'CONSIDER_MODEST_CALORIE_REDUCTION',
    'CONSIDER_MODEST_CALORIE_INCREASE',
    'CONSIDER_INCREASING_DAILY_STEPS',
    'CONSIDER_ADDING_ZONE2_CARDIO',
    'IMPROVE_LOGGING_CONSISTENCY',
    'IMPROVE_TRAINING_ADHERENCE',
    'PRIORITISE_SLEEP',
    'COLLECT_MORE_DATA_BEFORE_CHANGING',
    'RATE_OF_LOSS_TOO_FAST_CONSIDER_EASING'
  );
exception when duplicate_object then null; end $$;

-- Spec §41 - audit log event categories.
do $$ begin
  create type system_event_kind as enum (
    'IMPORT_CONFIRMED',
    'IMPORT_DUPLICATE_REJECTED',
    'CANONICAL_RESOLVED',
    'TARGET_CHANGED',
    'RECOMMENDATION_GENERATED',
    'CONTEXT_EXPORTED',
    'SAFETY_WARNING_ACKNOWLEDGED',
    'PROFILE_UPDATED'
  );
exception when duplicate_object then null; end $$;

-- Scalar daily metrics that do not warrant their own typed table but still
-- require full provenance (spec §15/§17). Used by metric_observations.
do $$ begin
  create type metric_key as enum (
    'STEPS',
    'ACTIVE_CALORIES',
    'TOTAL_CALORIES_BURNED',
    'RESTING_HEART_RATE',
    'HRV_MS',
    'WORKOUT_MINUTES',
    'CARDIO_MINUTES'
  );
exception when duplicate_object then null; end $$;
