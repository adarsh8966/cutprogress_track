-- 0007_derived.sql
-- THE DERIVED LAYER (spec §9, §23, §30, §43, §51, §52).
--
-- Everything here is computed output. Each row records the code version that
-- produced it, so a recommendation or an export can always be explained months
-- later (spec §43 model versioning).

-- Spec §9. Transparent, configurable nutrition score with its components kept.
create table if not exists daily_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  local_date date not null,

  nutrition_score numeric(5, 2)
    check (nutrition_score is null or (nutrition_score between 0 and 100)),
  -- The per-component breakdown that produced the score. The score is never
  -- shown without being able to show this (spec §57).
  nutrition_components jsonb not null default '{}'::jsonb,

  data_quality_score numeric(5, 2)
    check (data_quality_score is null or (data_quality_score between 0 and 100)),
  data_quality_components jsonb not null default '{}'::jsonb,

  scorer_version text not null,

  unique (user_id, local_date)
);

create index if not exists daily_scores_user_date_idx
  on daily_scores (user_id, local_date desc);

-- Spec §51.
create table if not exists weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  week_start_date date not null,
  week_end_date date not null,

  -- Full computed review payload (Derived<T> values with their evidence).
  metrics jsonb not null default '{}'::jsonb,
  assessment text,
  analytics_version text not null,

  unique (user_id, week_start_date),
  constraint weekly_reviews_dates_ordered check (week_end_date >= week_start_date)
);

-- Spec §52.
create table if not exists monthly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  month_start_date date not null,
  metrics jsonb not null default '{}'::jsonb,
  assessment text,
  analytics_version text not null,

  unique (user_id, month_start_date)
);

-- Spec §23. CANDIDATES, not commands. The kind is drawn from a closed enum
-- (0001), which is what structurally prevents an unsafe protocol from ever
-- being emitted (spec §45).
create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  kind recommendation_kind not null,
  headline text not null,
  -- The evidence that produced this candidate. Never empty (spec §57).
  evidence jsonb not null,
  confidence confidence_level not null,

  generated_for_date date not null,
  analytics_version text not null,

  -- The user (or ChatGPT, via the user) decides. The app never self-applies.
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  resolved_at timestamptz,
  resolution_note text,

  constraint recommendations_evidence_not_empty
    check (jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb)
);

create index if not exists recommendations_user_created_idx
  on recommendations (user_id, created_at desc);

comment on table recommendations is
  'Recommendation candidates with mandatory evidence. Closed template set. Spec §23/§45/§57.';

-- Spec §30/§43. Every generated Context Pack is kept with its schema version.
create table if not exists context_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  context_version text not null,
  generated_for_date date not null,

  body text not null,
  -- sha-256 of body, so an identical regeneration is recognisable.
  content_hash text not null,

  data_quality_score numeric(5, 2)
    check (data_quality_score is null or (data_quality_score between 0 and 100)),
  analytics_version text not null,
  -- Window sizes and thresholds in force when this pack was produced.
  parameters jsonb not null default '{}'::jsonb
);

create index if not exists context_exports_user_created_idx
  on context_exports (user_id, created_at desc);

comment on table context_exports is
  'Persisted Context Packs with schema version and content hash. Spec §30/§43.';
