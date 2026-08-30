/**
 * Database types.
 *
 * Hand-written to mirror supabase/migrations/. Regenerate with
 * `npx supabase gen types typescript --project-id <id> > lib/supabase/types.ts`
 * once a project exists; until then these are kept in step by hand and the
 * PGlite integration tests catch drift in the schema itself.
 *
 * Numeric columns come back from PostgREST as `number` for int types and as
 * `number` for numeric when the value fits; the query layer in lib/data
 * normalises everything through Number() so nothing downstream has to care.
 */

/*
 * NOTE ON `type` VS `interface` BELOW.
 * Every row shape here is a type alias, not an interface, and must stay one.
 * supabase-js constrains each table's Row to Record<string, unknown>; an
 * interface has no implicit index signature and so fails that constraint,
 * which silently resolves the whole schema to `never` and turns every query
 * result into an untyped error rather than a helpful one.
 */

export type DataSourceEnum =
  | 'MANUAL' | 'HEVY' | 'HEALTH_CONNECT' | 'GOOGLE_HEALTH' | 'BEVEL'
  | 'IMPORT_TEXT' | 'ESTIMATED' | 'OTHER';
export type PhaseEnum = 'CUT' | 'MAINTENANCE' | 'REVERSE_DIET' | 'LEAN_GAIN';
export type ConfidenceEnum = 'HIGH' | 'MODERATE' | 'LOW';
export type SessionTypeEnum =
  | 'UPPER' | 'LOWER' | 'PUSH' | 'PULL' | 'LEGS' | 'FULL_BODY' | 'CARDIO' | 'OTHER';
export type CardioTypeEnum =
  | 'WALKING' | 'INCLINE_WALKING' | 'RUNNING' | 'CYCLING' | 'OTHER';
export type MetricKeyEnum =
  | 'STEPS' | 'ACTIVE_CALORIES' | 'TOTAL_CALORIES_BURNED'
  | 'RESTING_HEART_RATE' | 'HRV_MS' | 'WORKOUT_MINUTES' | 'CARDIO_MINUTES'
  // 0015. Every one of these has a METRIC_FIELD entry in lib/data/canonicalise.ts
  // and a canonical column. A key with neither is stored and never resolved,
  // which is what already happens to WORKOUT_MINUTES and CARDIO_MINUTES.
  | 'DISTANCE_KM' | 'FLOORS' | 'ACTIVE_MINUTES' | 'ACTIVE_ZONE_MINUTES'
  | 'SEDENTARY_MINUTES' | 'VO2_MAX' | 'BODY_FAT_PCT' | 'RESPIRATORY_RATE'
  | 'OXYGEN_SATURATION_PCT';
export type GoalTypeEnum =
  | 'WEIGHT' | 'WAIST' | 'STEPS' | 'CALORIES' | 'PROTEIN'
  | 'TRAINING_FREQUENCY' | 'CARDIO_MINUTES' | 'RUNNING_DISTANCE';
export type RecommendationKindEnum =
  | 'MAINTAIN_CURRENT_INTAKE' | 'CONSIDER_MODEST_CALORIE_REDUCTION'
  | 'CONSIDER_MODEST_CALORIE_INCREASE' | 'CONSIDER_INCREASING_DAILY_STEPS'
  | 'CONSIDER_ADDING_ZONE2_CARDIO' | 'IMPROVE_LOGGING_CONSISTENCY'
  | 'IMPROVE_TRAINING_ADHERENCE' | 'PRIORITISE_SLEEP'
  | 'COLLECT_MORE_DATA_BEFORE_CHANGING' | 'RATE_OF_LOSS_TOO_FAST_CONSIDER_EASING';
export type SystemEventKindEnum =
  | 'IMPORT_CONFIRMED' | 'IMPORT_DUPLICATE_REJECTED' | 'CANONICAL_RESOLVED'
  | 'TARGET_CHANGED' | 'RECOMMENDATION_GENERATED' | 'CONTEXT_EXPORTED'
  | 'SAFETY_WARNING_ACKNOWLEDGED' | 'PROFILE_UPDATED'
  | 'OBSERVATION_SUPERSEDED' | 'OBSERVATION_RESTORED'
  | 'PROVIDER_CONNECTED' | 'PROVIDER_DISCONNECTED'
  | 'CANONICAL_FIELD_PINNED' | 'CANONICAL_FIELD_UNPINNED';

export type ProfileRow = {
  id: string;
  created_at: string;
  updated_at: string;
  height_cm: number | null;
  sex: 'MALE' | 'FEMALE' | 'UNSPECIFIED' | null;
  date_of_birth: string | null;
  timezone: string;
  weight_display_unit: 'LB' | 'KG';
  distance_display_unit: 'MI' | 'KM';
  length_display_unit: 'IN' | 'CM';
  starting_weight_kg: number | null;
  target_weight_kg: number | null;
  phase: PhaseEnum;
  target_calories: number | null;
  target_protein_g: number | null;
  target_fiber_g: number | null;
  target_steps: number | null;
  target_training_sessions_per_week: number | null;
  target_cardio_minutes_per_week: number | null;
  max_weekly_loss_rate_pct: number;
  cut_start_date: string | null;
}

export type BodyMeasurementRow = {
  id: string;
  user_id: string;
  created_at: string;
  measured_at: string;
  local_date: string;
  weight_kg: number | null;
  waist_cm: number | null;
  notes: string | null;
  source: DataSourceEnum;
  import_id: string | null;
  /**
   * Set when a correction replaced this observation, or when the user withdrew
   * it. NULL means live (migration 0012). The row is never deleted.
   */
  superseded_at: string | null;
  superseded_by: string | null;
}

export type MetricObservationRow = {
  id: string;
  user_id: string;
  created_at: string;
  metric: MetricKeyEnum;
  value: number;
  measured_at: string;
  local_date: string;
  source: DataSourceEnum;
  import_id: string | null;
  notes: string | null;
  /**
   * Set when a correction replaced this observation, or when the user withdrew
   * it. NULL means live (migration 0012). The row is never deleted.
   */
  superseded_at: string | null;
  superseded_by: string | null;
}

export type NutritionLogRow = {
  id: string;
  user_id: string;
  created_at: string;
  local_date: string;
  logged_at: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  fruit_veg_servings: number | null;
  notes: string | null;
  source: DataSourceEnum;
  import_id: string | null;
  /**
   * Set when a correction replaced this observation, or when the user withdrew
   * it. NULL means live (migration 0012). The row is never deleted.
   */
  superseded_at: string | null;
  superseded_by: string | null;
}

export type SleepRecordRow = {
  id: string;
  user_id: string;
  created_at: string;
  local_date: string;
  sleep_start: string | null;
  sleep_end: string | null;
  duration_minutes: number | null;
  sleep_score: number | null;
  source: DataSourceEnum;
  import_id: string | null;
  notes: string | null;
  /**
   * Set when a correction replaced this observation, or when the user withdrew
   * it. NULL means live (migration 0012). The row is never deleted.
   */
  superseded_at: string | null;
  superseded_by: string | null;
  /** Stage breakdown and sleep physiology (0016). NULL means not measured. */
  rem_minutes: number | null;
  deep_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  /**
   * Brief wake transitions, COUNTED. Deliberately not added to awake_minutes:
   * they overlap the surrounding stages rather than partitioning the night, so
   * summing them would count the same minutes twice.
   */
  short_awakenings: number | null;
  /** Signed: a colder night than baseline is negative, and is a measurement. */
  temperature_delta_c: number | null;
  respiratory_rate: number | null;
  oxygen_saturation_pct: number | null;
  external_source: string | null;
  external_id: string | null;
  external_updated_at: string | null;
}

export type CardioSessionRow = {
  id: string;
  user_id: string;
  created_at: string;
  local_date: string;
  started_at: string | null;
  cardio_type: CardioTypeEnum;
  duration_minutes: number;
  distance_km: number | null;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  hr_zone: number | null;
  calories: number | null;
  notes: string | null;
  source: DataSourceEnum;
  import_id: string | null;
  /** Set when a corrected import replaced this row. NULL means live (0011). */
  superseded_at: string | null;
  superseded_by: string | null;
  /**
   * External identity (0016). UNIQUE per user with external_source, so
   * re-syncing an imported session updates one row rather than doubling the
   * day's cardio minutes.
   */
  external_source: string | null;
  external_id: string | null;
  external_updated_at: string | null;
}

export type ExerciseRow = {
  exercise_id: string;
  created_at: string;
  updated_at: string;
  name: string;
  primary_muscle_group: string;
  equipment: string;
  nippard_tier: 'S' | 'A' | 'B' | 'C' | null;
  muscle_subgroups: string[];
  demonstration_url: string | null;
  active: boolean;
  apartment_gym: boolean;
  /** The system this exercise was created from or adopted by (0014). */
  external_source: string | null;
  /** That system's stable template id. UNIQUE with external_source. */
  external_id: string | null;
}

export type WorkoutSessionRow = {
  id: string;
  user_id: string;
  created_at: string;
  local_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  session_type: SessionTypeEnum;
  average_heart_rate: number | null;
  max_heart_rate: number | null;
  calories: number | null;
  notes: string | null;
  completed: boolean;
  source: DataSourceEnum;
  import_id: string | null;
  /** Set when a corrected import replaced this row. NULL means live (0011). */
  superseded_at: string | null;
  superseded_by: string | null;
  /** The name the source gave this workout. session_type stays the enum (0014). */
  title: string | null;
  external_source: string | null;
  external_id: string | null;
  external_updated_at: string | null;
}

export type WorkoutSetRow = {
  id: string;
  user_id: string;
  session_id: string;
  created_at: string;
  exercise_id: string;
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  rir: number | null;
  rpe: number | null;
  rest_seconds: number | null;
  warmup: boolean;
  to_failure: boolean;
  notes: string | null;
  /** Which exercise block of the workout this set belongs to, 0-based (0014). */
  exercise_index: number | null;
  /** The note on the EXERCISE, carried on each of its sets. */
  exercise_notes: string | null;
  superset_id: number | null;
  /** The source's own word for this set, verbatim and uninterpreted. */
  set_type: string | null;
  distance_km: number | null;
  duration_seconds: number | null;
  /** A set removed at the source stops counting without being deleted (0014). */
  superseded_at: string | null;
  superseded_by: string | null;
}

/** One synchronisation attempt with an external provider (0014). */
export type SyncRunRow = {
  id: string;
  user_id: string;
  created_at: string;
  provider: string;
  triggered_by: 'MANUAL' | 'SCHEDULED';
  started_at: string;
  finished_at: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  events_found: number;
  workouts_created: number;
  workouts_updated: number;
  workouts_unchanged: number;
  workouts_deleted: number;
  exercises_created: number;
  exercises_matched: number;
  records_failed: number;
  warnings: string[];
  error: string | null;
  cursor_before: string | null;
  cursor_after: string | null;
  /**
   * Provider-neutral counters (0016). The eight above name workouts and
   * exercises because Hevy was the only sync. A run that reads data points
   * across a dozen data types fills these instead, and each provider fills the
   * set that describes what it actually did rather than overloading the other.
   */
  records_created: number;
  records_updated: number;
  records_unchanged: number;
  records_withdrawn: number;
  /** Per-data-type outcome and backfill checkpoints. Makes a backfill resumable. */
  detail: Record<string, unknown>;
}

export type DailyMetricsRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  local_date: string;
  weight_kg: number | null;
  waist_cm: number | null;
  steps: number | null;
  active_calories: number | null;
  total_calories_burned: number | null;
  workout_minutes: number | null;
  cardio_minutes: number | null;
  zone2_minutes: number | null;
  resting_heart_rate: number | null;
  hrv_ms: number | null;
  sleep_duration_minutes: number | null;
  sleep_score: number | null;
  calories_consumed: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  fruit_veg_servings: number | null;
  training_sessions: number | null;
  /** 0016. All nullable; NULL means not logged, never zero (spec §33). */
  body_fat_pct: number | null;
  vo2_max: number | null;
  distance_km: number | null;
  floors: number | null;
  active_minutes: number | null;
  /**
   * The provider's own zone accounting, against its own boundaries. NOT the
   * same measurement as zone2_minutes, which uses the user's definitions.
   */
  active_zone_minutes: number | null;
  respiratory_rate: number | null;
  oxygen_saturation_pct: number | null;
  rem_minutes: number | null;
  deep_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  /** Signed. NULL means not measured. */
  sleep_temperature_delta_c: number | null;
  provenance: Record<string, unknown>;
}

export type HealthImportRow = {
  id: string;
  user_id: string;
  created_at: string;
  raw_text: string;
  parsed: Record<string, unknown>;
  confirmed: Record<string, unknown> | null;
  parser_name: string;
  parser_version: string;
  target_local_date: string | null;
  source: DataSourceEnum;
  status: 'PENDING' | 'CONFIRMED' | 'DISCARDED' | 'DUPLICATE';
  confirmed_at: string | null;
  idempotency_key: string;
}

export type GoalRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  goal_type: GoalTypeEnum;
  target_value: number;
  unit: string;
  start_date: string;
  target_date: string | null;
  active: boolean;
  notes: string | null;
}

export type SystemEventRow = {
  id: string;
  user_id: string;
  created_at: string;
  kind: SystemEventKindEnum;
  summary: string;
  detail: Record<string, unknown>;
  previous_value: string | null;
  new_value: string | null;
  reason: string | null;
  status: 'RECORDED' | 'PENDING_REVIEW' | 'ACKNOWLEDGED';
}

export type ContextExportRow = {
  id: string;
  user_id: string;
  created_at: string;
  context_version: string;
  generated_for_date: string;
  body: string;
  content_hash: string;
  data_quality_score: number | null;
  analytics_version: string;
  parameters: Record<string, unknown>;
}

export type RecommendationRow = {
  id: string;
  user_id: string;
  created_at: string;
  kind: RecommendationKindEnum;
  headline: string;
  evidence: Record<string, unknown>;
  confidence: ConfidenceEnum;
  generated_for_date: string;
  analytics_version: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';
  resolved_at: string | null;
  resolution_note: string | null;
}

/**
 * A Google Health OAuth connection (0016). One per user.
 *
 * NOTHING HERE IS EVER SENT TO THE BROWSER. The ciphertext columns are read
 * only by the server-side token module, which decrypts with a key that lives in
 * the environment and never in the database.
 */
export type GoogleHealthConnectionRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  health_user_id: string | null;
  google_user_id: string | null;
  /** What the user actually consented to, which may be less than was asked. */
  granted_scopes: string[];
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  access_token_expires_at: string | null;
  connected_at: string;
  last_refresh_at: string | null;
  /** Set when authorisation ended. The row stays: that is history. */
  revoked_at: string | null;
  last_error: string | null;
}

/** The provider's record, verbatim, before interpretation (0016). */
export type ExternalObservationRow = {
  id: string;
  user_id: string;
  created_at: string;
  provider: string;
  /** Google's own data type id, kebab-case, exactly as it appears in the path. */
  data_type: string;
  external_id: string;
  external_updated_at: string | null;
  record_type: 'SAMPLE' | 'INTERVAL' | 'DAILY' | 'SESSION';
  observed_at: string | null;
  interval_start: string | null;
  interval_end: string | null;
  utc_offset_seconds: number | null;
  local_date: string;
  /** Deliberately signed: a sleep temperature deviation can be negative. */
  value: number | null;
  unit: string | null;
  payload: Record<string, unknown>;
  /** NULL means supported, stored, and not yet mapped - never discarded. */
  mapped_to: string | null;
  mapped_id: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
}

/** Heart-rate zone boundaries and the method that produced them (0016). */
export type HrZoneDefinitionRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  zone: number;
  lower_bpm: number;
  /** NULL on the top zone, which has no ceiling. */
  upper_bpm: number | null;
  method: 'MEASURED_MAX' | 'ESTIMATED_MAX' | 'MANUAL' | 'PROVIDER';
  max_heart_rate: number | null;
  derived_from: string | null;
}

/** Physiology recorded during a training session by a provider (0016). */
export type SessionTelemetryRow = {
  id: string;
  user_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  external_id: string | null;
  match_method: 'INTERVAL_OVERLAP' | 'INTERVAL_ONLY' | 'NONE';
  match_confidence: number | null;
  overlap_seconds: number | null;
  hr_sample_count: number | null;
  /** How much of the session heart rate covers. An average over 12% is caveated. */
  hr_coverage_pct: number | null;
  average_hr: number | null;
  min_hr: number | null;
  max_hr: number | null;
  /** Minutes per zone 1-5, computed against the user's own definitions. */
  zone_minutes: Record<string, unknown>;
  /** The provider's own buckets, in its own vocabulary and units. */
  provider_zone_minutes: Record<string, unknown>;
  active_zone_minutes: number | null;
  calories_kcal: number | null;
  distance_km: number | null;
  steps: number | null;
}

/** A (day, field) whose canonical value was authored by hand (0016). */
export type CanonicalFieldPinRow = {
  id: string;
  user_id: string;
  created_at: string;
  local_date: string;
  /** The canonical field name as the resolver knows it, e.g. 'weightKg'. */
  field: string;
  pinned_observation_id: string | null;
  pinned_at: string;
  /** When the pin was lifted. Kept rather than deleted. */
  cleared_at: string | null;
  reason: string | null;
}

/** Insert shapes: server-defaulted columns are optional. */
type Insertable<T, Defaulted extends keyof T> = Omit<T, Defaulted> &
  Partial<Pick<T, Defaulted>>;

type ServerDefaults = 'id' | 'created_at' | 'updated_at';

/**
 * A session is always inserted live. Marking a row superseded is a later,
 * separate write (migration 0011), so these columns are not part of an insert
 * and an "already superseded" row cannot be created in the first place.
 */
type SessionDefaults = 'id' | 'created_at' | 'superseded_at' | 'superseded_by';

/** The same, for the scalar observation tables since migration 0012. */
type ObservationDefaults = 'id' | 'created_at' | 'superseded_at' | 'superseded_by';

/**
 * The columns 0016 added to sleep_records and cardio_sessions.
 *
 * OPTIONAL AT INSERT, unlike everything else on these tables. The general rule
 * here is that a writer must state every column, including the nulls, so that
 * re-writing a row cannot leave a stale value behind. These are the exception
 * because they were added to tables that already had writers: the manual sleep
 * logger has nothing to say about REM minutes and never will, and requiring it
 * to write eleven explicit nulls would be ceremony rather than safety. The
 * provider that DOES know them writes them all, every time.
 */
type SleepExtras =
  | 'rem_minutes' | 'deep_minutes' | 'light_minutes' | 'awake_minutes'
  | 'short_awakenings' | 'temperature_delta_c' | 'respiratory_rate'
  | 'oxygen_saturation_pct'
  | 'external_source' | 'external_id' | 'external_updated_at';

/** The external identity 0016 gave cardio_sessions. Same reasoning. */
type CardioExtras = 'external_source' | 'external_id' | 'external_updated_at';

/**
 * And for workout_sets since 0014. A set is always inserted live and always
 * inserted with an identity of its own; marking one superseded is a later,
 * separate write, so an "already removed" set cannot be created.
 */
type SetDefaults = 'id' | 'created_at' | 'superseded_at' | 'superseded_by';

/**
 * A sync run is INSERTed as started and UPDATEd as finished, so everything the
 * run goes on to count is optional at insert time.
 */
type SyncRunDefaults =
  | 'id' | 'created_at' | 'started_at' | 'finished_at' | 'status' | 'triggered_by'
  | 'events_found' | 'workouts_created' | 'workouts_updated' | 'workouts_unchanged'
  | 'workouts_deleted' | 'exercises_created' | 'exercises_matched' | 'records_failed'
  | 'warnings' | 'error' | 'cursor_before' | 'cursor_after'
  | 'records_created' | 'records_updated' | 'records_unchanged'
  | 'records_withdrawn' | 'detail';

type TableDef<Row, Insert = Row, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
}

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<ProfileRow, Insertable<ProfileRow, 'created_at' | 'updated_at'>>;
      goals: TableDef<GoalRow, Insertable<GoalRow, ServerDefaults>>;
      body_measurements: TableDef<
        BodyMeasurementRow, Insertable<BodyMeasurementRow, ObservationDefaults>
      >;
      metric_observations: TableDef<
        MetricObservationRow, Insertable<MetricObservationRow, ObservationDefaults>
      >;
      nutrition_logs: TableDef<
        NutritionLogRow, Insertable<NutritionLogRow, ObservationDefaults | 'logged_at'>
      >;
      sleep_records: TableDef<
        SleepRecordRow, Insertable<SleepRecordRow, ObservationDefaults | SleepExtras>
      >;
      cardio_sessions: TableDef<
        CardioSessionRow, Insertable<CardioSessionRow, SessionDefaults | CardioExtras>
      >;
      exercises: TableDef<ExerciseRow, Insertable<ExerciseRow, 'created_at' | 'updated_at'>>;
      workout_sessions: TableDef<
        WorkoutSessionRow, Insertable<WorkoutSessionRow, SessionDefaults>
      >;
      workout_sets: TableDef<WorkoutSetRow, Insertable<WorkoutSetRow, SetDefaults>>;
      sync_runs: TableDef<SyncRunRow, Insertable<SyncRunRow, SyncRunDefaults>>;
      daily_metrics: TableDef<DailyMetricsRow, Insertable<DailyMetricsRow, ServerDefaults>>;
      health_imports: TableDef<
        HealthImportRow, Insertable<HealthImportRow, 'id' | 'created_at'>
      >;
      system_events: TableDef<SystemEventRow, Insertable<SystemEventRow, 'id' | 'created_at'>>;
      context_exports: TableDef<
        ContextExportRow, Insertable<ContextExportRow, 'id' | 'created_at'>
      >;
      recommendations: TableDef<
        RecommendationRow, Insertable<RecommendationRow, 'id' | 'created_at'>
      >;
      google_health_connections: TableDef<
        GoogleHealthConnectionRow,
        Insertable<
          GoogleHealthConnectionRow,
          ServerDefaults | 'connected_at' | 'granted_scopes'
        >
      >;
      external_observations: TableDef<
        ExternalObservationRow,
        Insertable<ExternalObservationRow, ObservationDefaults | 'payload'>
      >;
      hr_zone_definitions: TableDef<
        HrZoneDefinitionRow, Insertable<HrZoneDefinitionRow, ServerDefaults>
      >;
      session_telemetry: TableDef<
        SessionTelemetryRow,
        Insertable<
          SessionTelemetryRow,
          ServerDefaults | 'zone_minutes' | 'provider_zone_minutes'
        >
      >;
      canonical_field_pins: TableDef<
        CanonicalFieldPinRow,
        Insertable<CanonicalFieldPinRow, 'id' | 'created_at' | 'pinned_at'>
      >;
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      data_source: DataSourceEnum;
      phase: PhaseEnum;
      confidence_level: ConfidenceEnum;
      session_type: SessionTypeEnum;
      cardio_type: CardioTypeEnum;
      metric_key: MetricKeyEnum;
      goal_type: GoalTypeEnum;
      recommendation_kind: RecommendationKindEnum;
      system_event_kind: SystemEventKindEnum;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
