# Data model

Three layers, in `supabase/migrations/`.

## Raw (append-only)

Every row is an observation: something measured or reported at a point in time,
by a named source.

| Table | Holds |
|---|---|
| `body_measurements` | weight, waist |
| `metric_observations` | steps, active calories, resting HR, HRV |
| `nutrition_logs` / `nutrition_items` | per-day macros; optional per-food detail |
| `sleep_records` | duration, score |
| `cardio_sessions` | type, duration, distance, HR zone |
| `workout_sessions` / `workout_sets` | sessions and set-level data |
| `health_imports` | the original pasted text, verbatim and forever |

These are never updated and never deleted. That is enforced in `0008_rls.sql` by
granting no such policy — with RLS on and no delete policy, a delete is refused
regardless of what the application asks for. A correction is a new observation
that supersedes the old one by source priority and recency.

`workout_sessions` and `workout_sets` are the exception: they permit update,
because a workout is authored over the course of a session and a rep count gets
corrected mid-set. They still permit no delete.

## Canonical

`daily_metrics` — one resolved row per user per local date. Every measurement
column is nullable, and `null` means *not logged*, never zero.

A `provenance` JSONB column records, per field:

```json
{ "weightKg": { "source": "MANUAL", "confidence": "HIGH",
                "observation_id": "…", "candidates": 3 } }
```

Chosen over 15 parallel `*_source` columns for readability. Validated in
TypeScript by `lib/normalization/canonical.ts`.

**Conflict resolution.** Three sources can disagree about this morning's weight.
None is deleted and none silently wins:

1. higher-priority source wins — default `MANUAL < HEALTH_CONNECT <
   GOOGLE_HEALTH < BEVEL < IMPORT_TEXT < OTHER < ESTIMATED`, configurable per
   user in `data_sources`
2. within a source, the most recent observation wins

Confidence reflects *agreement*, not source rank: HIGH when candidates agree
within 0.5%, MODERATE within 2%, LOW beyond that — a material disagreement is
surfaced for the user to look at rather than resolved silently.

Aggregates (cardio minutes, training sessions) are **summed**, not resolved: a
day with no sessions is `null`, a day whose sessions sum to zero is `0`.

## Derived

`daily_scores`, `weekly_reviews`, `monthly_reviews`, `recommendations`,
`context_exports`, `system_events`.

Each stores the code version that produced it, so a recommendation or an export
can be explained months later.

Two structural guarantees:

- `recommendations.kind` is a **closed enum**. There is no free-text generation
  path, so the system cannot emit an arbitrary or unsafe dieting protocol.
- A check constraint rejects a recommendation with an empty `evidence` object.
  A conclusion without its evidence cannot be stored.

`system_events` and `context_exports` are append-only: the audit log and the
record of what was handed to ChatGPT are not rewritable.

## Units

Storage is metric throughout — kg, cm, km, kcal, minutes — and the unit is in
the column name (`weight_kg`, `waist_cm`, `distance_km`) so a mismatch is
visible in the schema. Conversion happens only at the UI and parser boundaries,
in `lib/normalization/units.ts`.

## Dates

`local_date` is the calendar date of the observation in the **profile's
timezone**, computed at write time. It is stored rather than derived on read
because the profile timezone can change and a past observation must keep the day
it was actually recorded under. A workout at 23:30 belongs to that day, not to
tomorrow.

## Idempotency

`health_imports.idempotency_key` is `UNIQUE (user_id, key)`, where the key is
SHA-256 over the normalised paste text plus the target date. Normalisation
ignores whitespace, case and blank lines — so a re-copied report is recognised —
but not digits, so a genuinely edited value imports as new data.

The uniqueness is a database constraint, not an application check, so it cannot
be raced past.
