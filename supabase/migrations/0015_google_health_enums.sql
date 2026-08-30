-- 0015_google_health_enums.sql
-- The metric vocabulary Google Health brings with it.
--
-- VALUES ONLY, ALONE IN THEIR OWN FILE, for exactly the reason 0013 gives:
-- PostgreSQL permits ALTER TYPE ... ADD VALUE inside a transaction (12+) as
-- long as the new value is not USED in that same transaction, and
-- `supabase db push` may batch migrations into one. Keeping the additions
-- separate means 0016 - or anything added to it later - can reference these
-- freely without the batch failing.
--
-- NO NEW data_source VALUE. 'GOOGLE_HEALTH' has been in the enum since 0001 and
-- ranked in DEFAULT_SOURCE_PRIORITY ever since; it has simply never had a
-- writer. This migration gives its measurements somewhere to land.
--
-- WHY THESE AND NOT MORE. Every value below has a canonical column in
-- daily_metrics after 0016 and a reader after that. A metric_key with no
-- METRIC_FIELD entry in lib/data/canonicalise.ts is stored and then silently
-- never resolved - which is what already happens to WORKOUT_MINUTES and
-- CARDIO_MINUTES, whose daily values are summed from sessions instead. Adding
-- a key here without wiring it through is how a measurement becomes invisible.

alter type metric_key add value if not exists 'DISTANCE_KM';
alter type metric_key add value if not exists 'FLOORS';
alter type metric_key add value if not exists 'ACTIVE_MINUTES';
alter type metric_key add value if not exists 'ACTIVE_ZONE_MINUTES';
alter type metric_key add value if not exists 'SEDENTARY_MINUTES';
alter type metric_key add value if not exists 'VO2_MAX';
alter type metric_key add value if not exists 'BODY_FAT_PCT';
alter type metric_key add value if not exists 'RESPIRATORY_RATE';
alter type metric_key add value if not exists 'OXYGEN_SATURATION_PCT';

-- Spec §41. Connecting or disconnecting a provider changes where the app's
-- numbers come from, which is exactly what the audit log is for.
alter type system_event_kind add value if not exists 'PROVIDER_CONNECTED';
alter type system_event_kind add value if not exists 'PROVIDER_DISCONNECTED';
alter type system_event_kind add value if not exists 'CANONICAL_FIELD_PINNED';
alter type system_event_kind add value if not exists 'CANONICAL_FIELD_UNPINNED';
