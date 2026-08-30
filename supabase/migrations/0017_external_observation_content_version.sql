--------------------------------------------------------------------------------
-- 0017 - a version for a record the provider does not version.
--
-- WHAT WENT WRONG. 0016 keyed idempotency on the provider's own updated_at:
--
--   unique (user_id, provider, data_type, external_id,
--           coalesce(external_updated_at, '-infinity'))
--
-- and that is right for a record that carries one. The first real sync showed
-- that most do not. Google's aggregation endpoints return a day's steps,
-- distance and calories with no updateTime at all, so every version of those
-- records is NULL, every version therefore matches, and the second read of a
-- day is refused as a duplicate of the first.
--
-- Refused is the safe direction - nothing duplicates - but it is not correct:
-- TODAY is still accumulating. A sync at nine in the morning stores a partial
-- step count, and every sync after it is turned away by this index, so the day
-- keeps that partial figure permanently. A wrong number that looks settled is
-- worse than a missing one, and this system's whole premise is that a stored
-- measurement can be trusted.
--
-- SO THE CONTENT BECOMES THE VERSION. content_version is a digest of the data
-- point exactly as it arrived (identity.ts). Folding it into the same index
-- keeps all three of 0016's properties and repairs the fourth:
--
--   * a byte-identical re-read digests the same and is still refused outright,
--     so re-syncing a window is still free and still the database's decision
--     rather than the application's;
--   * a REVISED record digests differently and gets through, as a new row
--     beside the old one, which the writer then supersedes - a correction, in
--     the same shape every other correction in this schema takes;
--   * every version that ever arrived still keeps its own row;
--   * and a data type with no updateTime is no longer exempt from all of it.
--
-- WHY NOT MAKE IT NOT NULL. Rows written before this migration have no digest
-- and there is no honest way to compute one for them: the digest is taken over
-- a canonical rendering of the payload that this SQL cannot reproduce
-- byte-for-byte, and guessing would be worse than admitting the gap. They stay
-- NULL, they coalesce to '' in the index exactly as before, and the first sync
-- that re-reads one writes a fresh row and supersedes it. Same value, new row,
-- nothing lost - and after that pass every record can be told from a revision
-- of itself.
--
-- THE OTHER HALF OF THE SAME FIX lives in the application, and is worth naming
-- here because it explains what external_id now holds. Google documents
-- DataPoint.name as supported for only a subset of data types; for the rest the
-- field is absent, and CUT OS mints its own identity from the data type, the
-- recording source and the measurement's time. Those ids are prefixed
-- `cutos:1/` and can never be confused with a Google resource name, which
-- always begins `users/`. Both are external identities and both are stable;
-- only one of them is the provider's.
--
-- Re-appliable, like every migration here: the column add is guarded, and the
-- index is dropped and recreated rather than created conditionally, so
-- re-running the whole set converges on this definition rather than leaving
-- 0016's in place.
--------------------------------------------------------------------------------

alter table external_observations
  add column if not exists content_version text;

comment on column external_observations.content_version is
  'A digest of the data point as the provider sent it, so a record with no updateTime still has a version. NULL only on rows written before 0017.';

comment on column external_observations.external_id is
  'The provider''s own id where it sends one (Google resource names begin users/), and otherwise a deterministic CUT OS identity prefixed cutos:1/ minted from the data type, recording source and measurement time.';

--------------------------------------------------------------------------------
-- The idempotency index, with the content version alongside the provider's.
--
-- coalesce on both, and for the same reason 0016 gave for the first one: in
-- PostgreSQL every NULL is distinct from every other NULL, so a nullable column
-- in a unique index does not constrain the rows that leave it null - which is
-- precisely the hole this migration exists to close, and it would be absurd to
-- reopen it in the fix.
--------------------------------------------------------------------------------
drop index if exists external_observations_identity_idx;

create unique index external_observations_identity_idx
  on external_observations (
    user_id, provider, data_type, external_id,
    coalesce(external_updated_at, '-infinity'::timestamptz),
    coalesce(content_version, '')
  );
