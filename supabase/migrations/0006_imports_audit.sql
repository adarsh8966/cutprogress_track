-- 0006_imports_audit.sql
-- Spec §8 (paste ingestion), §17 (never throw away the original input),
-- §38 (idempotent imports), §41 (audit log).

create table if not exists health_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- THE ORIGINAL INPUT, kept verbatim and forever. If the parser turns out to
  -- be wrong six months from now, everything can be re-derived from this. Spec §17.
  raw_text text not null,

  -- What the parser extracted, before the user reviewed it.
  parsed jsonb not null default '{}'::jsonb,
  -- What the user actually confirmed, after editing the review screen.
  confirmed jsonb,

  parser_name text not null,
  parser_version text not null,

  target_local_date date,
  source data_source not null default 'IMPORT_TEXT',

  status text not null default 'PENDING'
    check (status in ('PENDING', 'CONFIRMED', 'DISCARDED', 'DUPLICATE')),
  confirmed_at timestamptz,

  -- Spec §38: sha-256 of (normalised raw_text + target date). Pasting the same
  -- Bevel report twice is detected here rather than silently duplicating a day.
  idempotency_key text not null,

  unique (user_id, idempotency_key)
);

create index if not exists health_imports_user_created_idx
  on health_imports (user_id, created_at desc);

comment on table health_imports is
  'Every paste, kept verbatim with its parse and its confirmation. Spec §8/§17/§38.';
comment on column health_imports.idempotency_key is
  'sha-256 over normalised text + target date. UNIQUE per user - re-pasting cannot duplicate data. Spec §38.';

-- Link raw observations back to the import that produced them. Declared here
-- because health_imports is created after the observation tables.
alter table body_measurements
  drop constraint if exists body_measurements_import_fk;
alter table body_measurements
  add constraint body_measurements_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

alter table metric_observations
  drop constraint if exists metric_observations_import_fk;
alter table metric_observations
  add constraint metric_observations_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

alter table nutrition_logs
  drop constraint if exists nutrition_logs_import_fk;
alter table nutrition_logs
  add constraint nutrition_logs_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

alter table sleep_records
  drop constraint if exists sleep_records_import_fk;
alter table sleep_records
  add constraint sleep_records_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

alter table cardio_sessions
  drop constraint if exists cardio_sessions_import_fk;
alter table cardio_sessions
  add constraint cardio_sessions_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

alter table workout_sessions
  drop constraint if exists workout_sessions_import_fk;
alter table workout_sessions
  add constraint workout_sessions_import_fk
  foreign key (import_id) references health_imports (id) on delete set null;

-- Spec §41. Automated changes are never silent.
create table if not exists system_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  kind system_event_kind not null,
  summary text not null,
  -- The evidence behind the event, so any past decision stays auditable.
  detail jsonb not null default '{}'::jsonb,

  previous_value text,
  new_value text,
  reason text,
  status text not null default 'RECORDED'
    check (status in ('RECORDED', 'PENDING_REVIEW', 'ACKNOWLEDGED'))
);

create index if not exists system_events_user_created_idx
  on system_events (user_id, created_at desc);

comment on table system_events is
  'Audit log. Every automated change records what changed, why, and on what evidence. Spec §41.';
