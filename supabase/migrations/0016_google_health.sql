-- 0016_google_health.sql
-- Google Health as the external source of HEALTH, ACTIVITY and RECOVERY data
-- (spec §14, §15, §16, §17, §33, §40, §41, §48).
--
-- WHAT THIS IS FOR. daily_metrics has had columns for steps, active calories,
-- resting heart rate, HRV, sleep duration and zone-2 minutes since 0005. None
-- of them has ever had a source: they could be typed by hand or parsed out of a
-- paste, and that was all. Google Health (the successor to the Fitbit Web API,
-- which shuts down in September 2026) measures every one of them continuously.
--
-- THIS IS NOT A GOOGLE HEALTH DATA MODEL. It is the same bargain 0014 struck
-- for Hevy: the provider becomes one more writer into the tables that already
-- exist. Weight lands in body_measurements. Steps, distance, resting HR, HRV
-- and the rest land in metric_observations. Sleep lands in sleep_records.
-- Cardio lands in cardio_sessions. Everything downstream - the resolver,
-- daily_metrics, every page, the Context Pack - reads them exactly as it reads
-- a value the user typed.
--
-- FIVE THINGS ARE STRUCTURAL RATHER THAN CONVENTIONAL:
--
--  1. IDEMPOTENCY IS AN INDEX, AGAIN. external_observations is UNIQUE on
--     (user_id, provider, data_type, external_id). Re-syncing a day cannot
--     produce a second copy of a measurement, because the database refuses it -
--     not because the sync code remembered to check. sleep_records and
--     cardio_sessions gain the same external identity 0014 gave sessions.
--
--  2. THE RAW RECORD IS KEPT, WHOLE. external_observations.payload holds the
--     data point exactly as Google sent it, before parsing dropped anything the
--     schema does not model (§17). It is the health_imports.raw_text of this
--     path, and it is what makes a future mapping recoverable from history
--     rather than from a re-sync that may no longer return the same window.
--
--  3. A SUPPORTED TYPE WITH NOWHERE TO GO IS PRESERVED, NOT DISCARDED.
--     mapped_to is null for a data type CUT OS has no canonical destination for
--     yet. The observation is still stored, still timestamped, still
--     attributable - so adding the mapping later is a migration and a reader,
--     not a re-import of data that was thrown away.
--
--  4. A MANUAL VALUE IS NOT SILENTLY OVERWRITTEN. canonical_field_pins records
--     that a (day, field) was authored by hand. The resolver honours the pin,
--     so a sync that arrives afterwards is stored with full provenance and
--     shown as available - and does not move the number the user just fixed.
--     Recency still governs every unpinned field, exactly as before.
--
--  5. A HEART-RATE ZONE IS DEFINED, NOT ASSUMED. hr_zone_definitions holds the
--     boundaries and records how they were arrived at. Zone 2 is computed from
--     measured samples against those boundaries, or taken from the provider's
--     own zone durations, or reported unavailable. It is never inferred from a
--     workout's title and never invented from a default nobody chose.
--
-- Every column added to an existing table is nullable and additive, so a
-- manual, pasted or Hevy-sourced row is unchanged and every existing query
-- keeps working.

--------------------------------------------------------------------------------
-- google_health_connections: the OAuth credential, encrypted, one per user.
--
-- WHY A TABLE AT ALL. Hevy needed a single static API key, so CLAUDE.md's
-- "never store a third-party credential in the database" cost nothing: the key
-- lived in an environment variable and the rule held. An OAuth refresh token
-- cannot. It is issued per user at consent time, it is rotated, and it is
-- revocable by the user from their Google account - none of which an env var
-- can express. So the rule narrows rather than breaks: the token is stored
-- ENCRYPTED (AES-256-GCM), the key that decrypts it lives only in the server's
-- environment and never in the database, and no column here is ever returned to
-- the browser.
--
-- health_user_id is Google's identifier for the account whose data this is. It
-- is stored because a webhook notification names the user by it and nothing
-- else, and because the mapping never changes and so can be cached forever.
-- Nothing today depends on it; it costs one column and it is the half that
-- would otherwise be missing.
--------------------------------------------------------------------------------
create table if not exists google_health_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Google's identifiers for the authorised account.
  health_user_id text,
  google_user_id text,

  -- What the user actually consented to, which may be less than what was asked
  -- for. Partial consent is a supported outcome, not a failure: the data types
  -- the granted scopes cover are synced and the rest are reported as
  -- unavailable rather than retried forever.
  granted_scopes text[] not null default '{}',

  -- AES-256-GCM. Three columns because a GCM ciphertext is meaningless without
  -- its nonce and authentication tag, and storing them concatenated would make
  -- the format a parsing convention rather than a schema.
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_tag text,

  -- When the current access token stops working. Refreshing is on-demand, at
  -- the moment a sync needs a token, which is what Google's documentation
  -- advises: a scheduled batch refresh updates tokens that did not need it and
  -- fails all of them together when it fails.
  access_token_expires_at timestamptz,

  connected_at timestamptz not null default now(),
  last_refresh_at timestamptz,
  -- Set when authorisation is withdrawn - by the user here, or by Google
  -- refusing the refresh token. The row stays: which account was connected, and
  -- when it stopped being connected, is history worth keeping.
  revoked_at timestamptz,
  last_error text,

  unique (user_id)
);

comment on table google_health_connections is
  'One Google Health OAuth connection per user. The refresh token is encrypted at rest; the key lives in the environment, never here. Never returned to the browser.';
comment on column google_health_connections.granted_scopes is
  'What the user actually consented to. May be narrower than what was requested - partial consent is handled, not failed.';
comment on column google_health_connections.health_user_id is
  'Google Health''s own id for the authorised account, from getIdentity. Stable forever, so it is cached rather than re-fetched.';
comment on column google_health_connections.revoked_at is
  'When authorisation ended. The row is kept: a connection that existed and stopped is history, not noise.';

--------------------------------------------------------------------------------
-- external_observations: the provider's record, verbatim, before interpretation.
--
-- This is the health_imports of the Google Health path and it plays the same
-- three roles: it is the idempotency key, it is the raw payload §17 requires,
-- and it is the holding pen for a supported data type that has no canonical
-- destination yet.
--
-- WHY value IS UNCONSTRAINED IN SIGN, unlike metric_observations.value. Most
-- measurements cannot be negative and that table's check says so. A sleep skin
-- temperature DERIVATION is a deviation from a baseline, and a colder night
-- than usual is a negative number that is entirely correct. A rail that would
-- refuse a real measurement is not a safety rail.
--
-- WHY BOTH interval_* AND observed_at. Google's data points are one of four
-- record types: a Sample is instantaneous, an Interval and a Session run
-- between two instants, and a Daily belongs to a date with no time at all.
-- Storing whichever the record actually has - and leaving the others null -
-- keeps "when was this measured?" answerable without inventing a precision the
-- source did not report.
--------------------------------------------------------------------------------
create table if not exists external_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- The system this came from, lowercase, matching sync_runs.provider.
  provider text not null,
  -- Google's own data type id, kebab-case exactly as it appears in the URL
  -- path ('daily-resting-heart-rate'). Stored verbatim so an unmapped type can
  -- be named precisely when the time comes to map it.
  data_type text not null,
  -- The provider's stable id for this data point. For Google Health that is the
  -- full resource name, users/{uid}/dataTypes/{type}/dataPoints/{id}.
  external_id text not null,
  -- The provider's own updated_at, so an edited record can be told from an
  -- unchanged one without comparing payloads.
  external_updated_at timestamptz,

  record_type text not null
    check (record_type in ('SAMPLE', 'INTERVAL', 'DAILY', 'SESSION')),

  -- A Sample's instant. Null for an Interval, Session or Daily record.
  observed_at timestamptz,
  -- An Interval's or Session's bounds. Null for a Sample or Daily record.
  interval_start timestamptz,
  interval_end timestamptz,
  -- The offset in force where the measurement happened, as Google reports it.
  -- Kept because a workout at 23:30 in one zone is a different day in another,
  -- and because a historical offset cannot be re-derived from today's rules.
  utc_offset_seconds integer,

  -- The calendar date this belongs to, in the PROFILE'S timezone, resolved at
  -- write time exactly as everywhere else in the raw layer (§40).
  local_date date not null,

  -- The measurement. Null for a record whose value is structural rather than
  -- scalar - a sleep session's stages, an exercise session's metrics summary -
  -- which lives in payload instead.
  value numeric,
  unit text,

  -- The data point exactly as the provider sent it.
  payload jsonb not null default '{}'::jsonb,

  -- Which canonical destination this observation was written to, and the id of
  -- the row it became. Null means the type is supported and stored but not yet
  -- mapped - detected and preserved, per the header.
  mapped_to text,
  mapped_id uuid,

  superseded_at timestamptz,
  superseded_by uuid references external_observations (id),

  constraint external_observations_supersession_coherent
    check (superseded_by is null or superseded_at is not null),
  constraint external_observations_not_self_superseding
    check (superseded_by is null or superseded_by <> id),
  constraint external_observations_interval_ordered
    check (interval_start is null or interval_end is null
           or interval_end >= interval_start),
  -- A record that cannot say when it was measured cannot be placed on a
  -- timeline, correlated with a workout, or corrected later.
  constraint external_observations_has_a_time
    check (observed_at is not null or interval_start is not null
           or record_type = 'DAILY')
);

-- THE IDEMPOTENCY GUARANTEE, AND THE VERSION HISTORY, IN ONE INDEX.
--
-- Keyed on the record's identity AND the provider's own updated_at, so:
--
--   * re-syncing an UNCHANGED record is refused outright - which is what makes
--     re-syncing a window free, and it is the database refusing it rather than
--     the sync code remembering to check;
--   * an EDITED record has a different version and so gets through, as a new
--     row beside the old one;
--   * every version that ever arrived keeps its own row, so this table is the
--     measurement's history and not only its latest state.
--
-- That is precisely the bargain health_imports.idempotency_key already strikes
-- for a pasted report (§38), reached here through an index instead of a hash
-- because the provider supplies the identity and the version directly.
--
-- coalesce, not a bare column: in PostgreSQL every NULL is distinct from every
-- other NULL, so a unique index over a nullable column does not constrain the
-- rows that leave it null - and a data type whose payload carries no updateTime
-- would silently lose its idempotency guarantee, which is the one place a
-- missing constraint would be invisible until it had already duplicated a
-- year of history.
create unique index if not exists external_observations_identity_idx
  on external_observations (
    user_id, provider, data_type, external_id,
    coalesce(external_updated_at, '-infinity'::timestamptz)
  );

-- Every read is "this provider's live records of this type, for these days".
create index if not exists external_observations_live_idx
  on external_observations (user_id, provider, data_type, local_date desc)
  where superseded_at is null;

-- Correlating a workout with the heart rate recorded during it is an interval
-- query, and it is the hottest one this table serves.
create index if not exists external_observations_interval_idx
  on external_observations (user_id, data_type, interval_start)
  where superseded_at is null;

create index if not exists external_observations_observed_idx
  on external_observations (user_id, data_type, observed_at)
  where superseded_at is null;

-- Finding what arrived but has not been mapped, for the integration detail view.
create index if not exists external_observations_unmapped_idx
  on external_observations (user_id, provider, data_type)
  where mapped_to is null and superseded_at is null;

comment on table external_observations is
  'The provider''s record, verbatim, before interpretation. Idempotency key, raw payload (§17), and the holding pen for a supported data type with no canonical destination yet.';
comment on column external_observations.value is
  'The scalar measurement where there is one. Deliberately unconstrained in sign: a sleep temperature derivation is a deviation and a colder night is negative.';
comment on column external_observations.mapped_to is
  'The table this observation was normalised into. NULL means supported, stored, and not yet mapped - never discarded.';
comment on column external_observations.payload is
  'The data point exactly as the provider sent it, before parsing dropped anything the schema does not model.';

--------------------------------------------------------------------------------
-- hr_zone_definitions: what a zone actually means, and how that was decided.
--
-- Zone 2 is a claim about physiology, so it needs boundaries that came from
-- somewhere. This table records them per user and, crucially, records `method`
-- alongside - MEASURED_MAX from an observed maximum heart rate, ESTIMATED_MAX
-- from age, or MANUAL where the user set them. Analytics reports the method
-- with the number, so "22 minutes in Zone 2" is never separable from what Zone
-- 2 was taken to be.
--
-- An age-derived maximum is a MODEL PARAMETER, not a measurement, and the
-- distinction is kept: it is stored here with its method, not written into
-- metric_observations where it would read as something the user's device
-- recorded.
--------------------------------------------------------------------------------
create table if not exists hr_zone_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  zone smallint not null check (zone between 1 and 5),
  lower_bpm numeric(5, 1) not null check (lower_bpm between 25 and 250),
  -- Null on the top zone, which has no ceiling.
  upper_bpm numeric(5, 1) check (upper_bpm is null or (upper_bpm between 25 and 250)),

  method text not null
    check (method in ('MEASURED_MAX', 'ESTIMATED_MAX', 'MANUAL', 'PROVIDER')),
  -- The maximum the boundaries were computed from, where they were computed.
  max_heart_rate numeric(5, 1)
    check (max_heart_rate is null or (max_heart_rate between 100 and 250)),
  -- Free text naming the evidence: 'observed maximum over 90 days',
  -- '220 - age (37)'. Shown next to any zone figure.
  derived_from text,

  constraint hr_zone_definitions_ordered
    check (upper_bpm is null or upper_bpm > lower_bpm),

  unique (user_id, zone)
);

comment on table hr_zone_definitions is
  'Per-user heart-rate zone boundaries and the method that produced them. A zone figure is never reported without the definition behind it.';
comment on column hr_zone_definitions.method is
  'How the boundaries were arrived at. ESTIMATED_MAX is a model parameter, not a measurement, and is reported as such.';

--------------------------------------------------------------------------------
-- session_telemetry: the physiology recorded DURING a training session.
--
-- WHY A SEPARATE TABLE rather than more columns on workout_sessions. The three
-- columns 0010 added there - average_heart_rate, max_heart_rate, calories - are
-- the SESSION'S OWN intensity, whoever reported it, and Google Health fills
-- them like any other source would. What does not belong there is the
-- correlation itself: which provider record this was matched to, how confident
-- that match is, how much of the session the heart rate actually covers, and
-- the per-zone breakdown. Those are facts about a JOIN between two systems, and
-- putting them on the session would make workout_sessions a table that knows
-- what Google Health is.
--
-- ONE ROW PER (session, provider). A session can only be matched to one record
-- from a given provider, and re-running the correlation updates that row rather
-- than adding a second opinion.
--
-- WHY BOTH zone_minutes AND provider_zone_minutes. The first is computed here
-- from raw samples against the user's own definitions; the second is the
-- provider's own bucketing, which uses its own boundaries and its own names.
-- They are different measurements of the same session and merging them would
-- destroy the ability to say which one a figure came from.
--------------------------------------------------------------------------------
create table if not exists session_telemetry (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references workout_sessions (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  provider text not null,
  -- The provider record this session was matched to, where there was one. Null
  -- means heart rate was gathered for the session's interval without an
  -- exercise session of the provider's own to attach it to - which is the
  -- normal case for lifting, since a lift is often not recorded as an exercise.
  external_id text,

  match_method text not null
    check (match_method in ('INTERVAL_OVERLAP', 'INTERVAL_ONLY', 'NONE')),
  -- 0..1. Stored so a match can be explained and a weak one questioned.
  match_confidence numeric(4, 3)
    check (match_confidence is null or (match_confidence between 0 and 1)),
  overlap_seconds integer check (overlap_seconds is null or overlap_seconds >= 0),

  -- How much of the session heart rate actually covers. A 60-minute session
  -- with 8 minutes of samples has an average heart rate that means very little,
  -- and this is the column that lets the UI say so instead of printing it flat.
  hr_sample_count integer check (hr_sample_count is null or hr_sample_count >= 0),
  hr_coverage_pct numeric(5, 2)
    check (hr_coverage_pct is null or (hr_coverage_pct between 0 and 100)),

  average_hr numeric(5, 1) check (average_hr is null or (average_hr between 25 and 250)),
  min_hr numeric(5, 1) check (min_hr is null or (min_hr between 25 and 250)),
  max_hr numeric(5, 1) check (max_hr is null or (max_hr between 25 and 250)),

  -- { "1": 15.0, "2": 22.0, "3": 8.0 } - minutes per zone, computed here.
  zone_minutes jsonb not null default '{}'::jsonb,
  -- { "lightTime": 900, "fatBurnTime": 1320 } - the provider's own buckets,
  -- in its own vocabulary, in seconds, exactly as reported.
  provider_zone_minutes jsonb not null default '{}'::jsonb,

  active_zone_minutes numeric(6, 1)
    check (active_zone_minutes is null or active_zone_minutes >= 0),
  calories_kcal numeric(7, 1) check (calories_kcal is null or calories_kcal >= 0),
  distance_km numeric(7, 3) check (distance_km is null or distance_km >= 0),
  steps integer check (steps is null or steps >= 0),

  constraint session_telemetry_hr_ordered
    check (min_hr is null or max_hr is null or max_hr >= min_hr),
  constraint session_telemetry_average_within_range
    check (average_hr is null or min_hr is null or average_hr >= min_hr),
  constraint session_telemetry_average_below_max
    check (average_hr is null or max_hr is null or average_hr <= max_hr),

  unique (session_id, provider)
);

create index if not exists session_telemetry_user_idx
  on session_telemetry (user_id, provider);

comment on table session_telemetry is
  'Physiology recorded during a training session by an external provider, and the correlation that attached it. One row per (session, provider).';
comment on column session_telemetry.hr_coverage_pct is
  'How much of the session heart rate actually covers. An average over 12% of a session is reported with that caveat, never as a bare number.';
comment on column session_telemetry.zone_minutes is
  'Minutes per zone 1-5, computed from samples against the user''s own hr_zone_definitions.';
comment on column session_telemetry.provider_zone_minutes is
  'The provider''s own zone buckets, in its own vocabulary and units. Kept separate: merging would lose which boundaries a figure used.';

--------------------------------------------------------------------------------
-- canonical_field_pins: a value the user authored, protected from an import.
--
-- THE PROBLEM THIS SOLVES. Resolution is recency-first (lib/normalization/
-- canonical.ts): the newest observation for a day wins, and source priority
-- only breaks a tie between two readings of the same instant. That is right for
-- corrections - it is the rule that stopped a hand-typed value outranking every
-- later fix forever - but it means an imported measurement recorded LATER in
-- the day than a manual correction would move the number the user had just set,
-- silently, on the next sync.
--
-- So a manual observation PINS the fields it carried for that date. The
-- resolver then considers only manual observations for a pinned field. The
-- imported observation is still written, still carries full provenance, and is
-- shown on /day/[date] as available and not applied - one click clears the pin
-- and lets it through.
--
-- NOTHING IS DELETED AND NOTHING IS HIDDEN. A pin changes which observation is
-- canonical. It does not change what was observed.
--
-- cleared_at rather than a delete: which fields were pinned and when the pin
-- was lifted is the kind of thing that explains a number six months later.
--------------------------------------------------------------------------------
create table if not exists canonical_field_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  local_date date not null,
  -- The canonical field name as the resolver knows it: 'weightKg', 'steps',
  -- 'restingHeartRate'. Matched against the keys of the fields map in
  -- lib/data/canonicalise.ts.
  field text not null,

  -- The observation that set the pin, for display. Not a foreign key: the
  -- observation it names may live in any of five tables.
  pinned_observation_id uuid,
  pinned_at timestamptz not null default now(),
  cleared_at timestamptz,
  reason text
);

-- One live pin per field per day. Partial, so a cleared pin stays on file
-- without blocking a new one.
create unique index if not exists canonical_field_pins_live_idx
  on canonical_field_pins (user_id, local_date, field)
  where cleared_at is null;

create index if not exists canonical_field_pins_user_date_idx
  on canonical_field_pins (user_id, local_date desc);

comment on table canonical_field_pins is
  'A (day, field) whose canonical value was authored by hand. The resolver honours the pin; imports are still stored and shown as available, not applied.';
comment on column canonical_field_pins.cleared_at is
  'When the pin was lifted. Kept rather than deleted - which fields were protected, and when they stopped being, explains a number later.';

--------------------------------------------------------------------------------
-- sleep_records: the structure of a night, not only its length.
--
-- 0003 gave this table a duration and a score, which is what a pasted summary
-- reports. A sleep session from a wearable reports the stages that make up the
-- duration, the physiology measured during it, and a stable id of its own.
--
-- shortAwakenings is COUNTED, not summed into awake_minutes. The API's own
-- guidance is explicit that short awakenings overlap the surrounding stages
-- rather than partitioning the timeline with them, so adding their duration to
-- the stage totals would count the same minutes twice and make the parts
-- exceed the whole.
--
-- Every column is nullable: a device that does not measure SpO2 leaves it null,
-- which means "not measured", never zero (§33).
--------------------------------------------------------------------------------
alter table sleep_records
  add column if not exists rem_minutes numeric(6, 1)
    check (rem_minutes is null or (rem_minutes between 0 and 1440)),
  add column if not exists deep_minutes numeric(6, 1)
    check (deep_minutes is null or (deep_minutes between 0 and 1440)),
  add column if not exists light_minutes numeric(6, 1)
    check (light_minutes is null or (light_minutes between 0 and 1440)),
  add column if not exists awake_minutes numeric(6, 1)
    check (awake_minutes is null or (awake_minutes between 0 and 1440)),
  add column if not exists short_awakenings smallint
    check (short_awakenings is null or short_awakenings >= 0),
  -- Deviation from the user's own baseline, in degrees Celsius. SIGNED: a
  -- colder night than usual is a negative number and a real measurement.
  add column if not exists temperature_delta_c numeric(4, 2)
    check (temperature_delta_c is null or (temperature_delta_c between -15 and 15)),
  add column if not exists respiratory_rate numeric(4, 1)
    check (respiratory_rate is null or (respiratory_rate between 1 and 60)),
  add column if not exists oxygen_saturation_pct numeric(4, 1)
    check (oxygen_saturation_pct is null or (oxygen_saturation_pct between 50 and 100)),
  add column if not exists external_source text,
  add column if not exists external_id text,
  add column if not exists external_updated_at timestamptz;

-- Declared drop-then-add (as in 0006, 0011, 0012 and 0014) so the migration
-- stays re-runnable: ADD CONSTRAINT has no IF NOT EXISTS form.
alter table sleep_records
  drop constraint if exists sleep_records_external_identity_coherent;
alter table sleep_records
  add constraint sleep_records_external_identity_coherent
  check ((external_source is null) = (external_id is null));

-- ONE LIVE ROW PER EXTERNAL RECORD, not one row ever.
--
-- The narrower form - unique on the identity alone, as 0014 uses for
-- workout_sessions - is right there because that path UPDATES a session in
-- place. This path cannot: sleep_records is an immutable observation, so a
-- corrected night is a NEW row that supersedes the old one. With a
-- non-partial index the superseded predecessor still holds the identity and
-- the correction is refused, leaving the night with no live row at all.
--
-- Partial on superseded_at, therefore: at most one row that COUNTS per
-- external record, with every predecessor still on file beside it. That is
-- the guarantee actually wanted, and it is the same shape as the live
-- indexes 0011 and 0012 added for reads.
create unique index if not exists sleep_records_external_idx
  on sleep_records (user_id, external_source, external_id)
  where external_source is not null and superseded_at is null;

comment on column sleep_records.short_awakenings is
  'Count of brief wake transitions. NOT summed into awake_minutes: they overlap the surrounding stages rather than partitioning the night with them.';
comment on column sleep_records.temperature_delta_c is
  'Skin temperature deviation from baseline during sleep, in Celsius. Signed - a colder night is negative and is a real measurement.';
comment on column sleep_records.external_id is
  'The source''s stable id for this sleep session. UNIQUE per user with external_source: re-syncing cannot create a second row.';

--------------------------------------------------------------------------------
-- cardio_sessions: external identity, so a synced session can be re-synced.
--
-- Without this, importing the same Google Health walk twice would write two
-- cardio_sessions rows and daily_metrics.cardio_minutes would sum them - the
-- exact 58 + 65 = 123 arithmetic 0011 exists to prevent, arriving by a
-- different door. 0014 closed that door for workout_sessions; this closes it
-- here.
--------------------------------------------------------------------------------
alter table cardio_sessions
  add column if not exists external_source text,
  add column if not exists external_id text,
  add column if not exists external_updated_at timestamptz;

alter table cardio_sessions
  drop constraint if exists cardio_sessions_external_identity_coherent;
alter table cardio_sessions
  add constraint cardio_sessions_external_identity_coherent
  check ((external_source is null) = (external_id is null));

-- Partial on superseded_at, for the reason given at sleep_records above: a
-- correction here is a new row, and a superseded predecessor must not keep
-- hold of the identity its replacement needs.
create unique index if not exists cardio_sessions_external_idx
  on cardio_sessions (user_id, external_source, external_id)
  where external_source is not null and superseded_at is null;

comment on column cardio_sessions.external_id is
  'The source''s stable id for this session. UNIQUE per user with external_source: at most one cardio row per external record, so re-syncing cannot double a day''s minutes.';

--------------------------------------------------------------------------------
-- daily_metrics: the new canonical fields.
--
-- Every one of these has a metric_key from 0015 or a sleep_records column
-- above, a METRIC_FIELD entry in lib/data/canonicalise.ts, and a reader. A
-- column with no reader is a value that is stored, confirmed and invisible,
-- which is the failure this codebase is most careful about.
--
-- All nullable, as tests/integration/migrations.test.ts requires of every
-- measurement column here. NULL means not logged. It does not mean zero (§33).
--------------------------------------------------------------------------------
alter table daily_metrics
  add column if not exists body_fat_pct numeric(4, 1)
    check (body_fat_pct is null or (body_fat_pct between 1 and 75)),
  add column if not exists vo2_max numeric(4, 1)
    check (vo2_max is null or (vo2_max between 10 and 100)),
  add column if not exists distance_km numeric(7, 3)
    check (distance_km is null or distance_km >= 0),
  add column if not exists floors numeric(6, 1)
    check (floors is null or floors >= 0),
  add column if not exists active_minutes numeric(6, 1)
    check (active_minutes is null or (active_minutes between 0 and 1440)),
  add column if not exists active_zone_minutes numeric(6, 1)
    check (active_zone_minutes is null or active_zone_minutes >= 0),
  add column if not exists respiratory_rate numeric(4, 1)
    check (respiratory_rate is null or (respiratory_rate between 1 and 60)),
  add column if not exists oxygen_saturation_pct numeric(4, 1)
    check (oxygen_saturation_pct is null or (oxygen_saturation_pct between 50 and 100)),
  add column if not exists rem_minutes numeric(6, 1)
    check (rem_minutes is null or (rem_minutes between 0 and 1440)),
  add column if not exists deep_minutes numeric(6, 1)
    check (deep_minutes is null or (deep_minutes between 0 and 1440)),
  add column if not exists light_minutes numeric(6, 1)
    check (light_minutes is null or (light_minutes between 0 and 1440)),
  add column if not exists awake_minutes numeric(6, 1)
    check (awake_minutes is null or (awake_minutes between 0 and 1440)),
  -- Signed, for the same reason as sleep_records.temperature_delta_c.
  add column if not exists sleep_temperature_delta_c numeric(4, 2)
    check (sleep_temperature_delta_c is null
           or (sleep_temperature_delta_c between -15 and 15));

comment on column daily_metrics.active_zone_minutes is
  'Active zone minutes as the provider computes them, against its own zone boundaries. Not the same measurement as zone2_minutes, which uses the user''s definitions.';
comment on column daily_metrics.sleep_temperature_delta_c is
  'Skin temperature deviation during sleep. Signed. NULL means not measured.';

--------------------------------------------------------------------------------
-- sync_runs: counters that are not shaped like a workout.
--
-- 0014's eight counters name workouts and exercises, because the only sync was
-- Hevy's. A Google Health run creates no workouts and matches no exercises; it
-- reads data points across a dozen data types. Rather than overload the
-- existing columns into meaning something different per provider - which is how
-- a number ends up wrong on a screen - generic counters are added beside them
-- and each provider fills the ones that describe what it did.
--
-- detail carries the per-data-type breakdown and the backfill checkpoints. It
-- is what makes an interrupted 365-day backfill resumable rather than
-- restartable, and what lets Settings say "sleep: 340 days, heart rate: 12 days"
-- instead of one opaque total.
--------------------------------------------------------------------------------
alter table sync_runs
  add column if not exists records_created integer not null default 0
    check (records_created >= 0),
  add column if not exists records_updated integer not null default 0
    check (records_updated >= 0),
  add column if not exists records_unchanged integer not null default 0
    check (records_unchanged >= 0),
  add column if not exists records_withdrawn integer not null default 0
    check (records_withdrawn >= 0),
  add column if not exists detail jsonb not null default '{}'::jsonb;

comment on column sync_runs.detail is
  'Per-data-type outcome and backfill checkpoints. What makes an interrupted backfill resumable rather than restartable.';

--------------------------------------------------------------------------------
-- ROW LEVEL SECURITY.
--
-- 0008's blanket `grant select, insert, update, delete on all tables` ran before
-- any of these tables existed, so each needs its own grant - and DELETE is
-- withheld outright from the two that record history, which is a step stronger
-- than the observation tables' merely-absent policy.
--
-- external_observations joins the immutable group: select and insert, plus a
-- column-level update on the supersession pair ALONE. Postgres requires both
-- the column privilege and the policy, so:
--
--     update external_observations set value = 999        -- refused
--     update external_observations set superseded_at = now()  -- allowed
--
-- The measurement is immutable. The bookkeeping around it is not. Same bargain
-- as 0011 and 0012, and mapped_to/mapped_id are deliberately NOT in the grant:
-- they are written once, at insert, by the same statement that normalises the
-- record.
--------------------------------------------------------------------------------

-- google_health_connections: the credential. Updatable (tokens rotate), never
-- deletable through the app - disconnecting sets revoked_at and clears the
-- ciphertext, which keeps the fact of the connection while destroying the key
-- material.
grant select, insert, update on google_health_connections to authenticated;
alter table google_health_connections enable row level security;
alter table google_health_connections force row level security;

drop policy if exists google_health_connections_select on google_health_connections;
create policy google_health_connections_select on google_health_connections
  for select to authenticated using (user_id = auth.uid());
drop policy if exists google_health_connections_insert on google_health_connections;
create policy google_health_connections_insert on google_health_connections
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists google_health_connections_update on google_health_connections;
create policy google_health_connections_update on google_health_connections
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- external_observations: immutable observation.
grant select, insert on external_observations to authenticated;
grant update (superseded_at, superseded_by) on external_observations to authenticated;
alter table external_observations enable row level security;
alter table external_observations force row level security;

drop policy if exists external_observations_select on external_observations;
create policy external_observations_select on external_observations
  for select to authenticated using (user_id = auth.uid());
drop policy if exists external_observations_insert on external_observations;
create policy external_observations_insert on external_observations
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists external_observations_update on external_observations;
create policy external_observations_update on external_observations
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- hr_zone_definitions: settings. Fully editable by their owner, and deletable -
-- removing a zone definition removes a claim, it does not destroy a measurement.
grant select, insert, update, delete on hr_zone_definitions to authenticated;
alter table hr_zone_definitions enable row level security;
alter table hr_zone_definitions force row level security;

drop policy if exists hr_zone_definitions_select on hr_zone_definitions;
create policy hr_zone_definitions_select on hr_zone_definitions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists hr_zone_definitions_insert on hr_zone_definitions;
create policy hr_zone_definitions_insert on hr_zone_definitions
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists hr_zone_definitions_update on hr_zone_definitions;
create policy hr_zone_definitions_update on hr_zone_definitions
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists hr_zone_definitions_delete on hr_zone_definitions;
create policy hr_zone_definitions_delete on hr_zone_definitions
  for delete to authenticated using (user_id = auth.uid());

-- session_telemetry: a derived correlation, rebuildable from
-- external_observations by re-running the matcher. So it is a cache, and like
-- daily_metrics it may be deleted.
grant select, insert, update, delete on session_telemetry to authenticated;
alter table session_telemetry enable row level security;
alter table session_telemetry force row level security;

drop policy if exists session_telemetry_select on session_telemetry;
create policy session_telemetry_select on session_telemetry
  for select to authenticated using (user_id = auth.uid());
drop policy if exists session_telemetry_insert on session_telemetry;
create policy session_telemetry_insert on session_telemetry
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists session_telemetry_update on session_telemetry;
create policy session_telemetry_update on session_telemetry
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists session_telemetry_delete on session_telemetry;
create policy session_telemetry_delete on session_telemetry
  for delete to authenticated using (user_id = auth.uid());

-- canonical_field_pins: authored record. Written, then cleared. Never deleted -
-- a pin that existed and was lifted is exactly the history that explains why a
-- number changed.
grant select, insert, update on canonical_field_pins to authenticated;
alter table canonical_field_pins enable row level security;
alter table canonical_field_pins force row level security;

drop policy if exists canonical_field_pins_select on canonical_field_pins;
create policy canonical_field_pins_select on canonical_field_pins
  for select to authenticated using (user_id = auth.uid());
drop policy if exists canonical_field_pins_insert on canonical_field_pins;
create policy canonical_field_pins_insert on canonical_field_pins
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists canonical_field_pins_update on canonical_field_pins;
create policy canonical_field_pins_update on canonical_field_pins
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
