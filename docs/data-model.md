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
| `cardio_sessions` | type, duration, distance, average and maximum HR, HR zone, calories |
| `workout_sessions` / `workout_sets` | sessions with title, duration, average and maximum HR and calories; set-level data with exercise order, notes, RPE and set type |
| `health_imports` | the original pasted text, verbatim and forever |

These are never updated and never deleted. That is enforced in `0008_rls.sql` by
granting no such policy — with RLS on and no delete policy, a delete is refused
regardless of what the application asks for. A correction is a new observation
that supersedes the old one by source priority and recency.

`workout_sessions` and `workout_sets` are the exception: they permit update,
because a workout is authored over the course of a session and a rep count gets
corrected mid-set. They still permit no delete.

**Supersession** (`0011`). `daily_metrics` sums a day's sessions rather than
resolving them, so re-importing a day to correct a duration used to make it the
total of both readings — 58 + 65 = 123 minutes. Both session tables now carry
`superseded_at` / `superseded_by`: a correction is a NEW row, exactly as
elsewhere in the raw layer, and the row it replaces is marked rather than
touched. Aggregates and every read count only rows where `superseded_at is
null`, so the day totals 65; nothing is deleted and the replaced observation
keeps every value it recorded.

`cardio_sessions` stays an immutable observation. Its update privilege is
granted **per column** — `superseded_at` and `superseded_by` only — so a
`duration_minutes` rewrite is refused outright by Postgres. RLS and the column
grant are both required, and both are tested.

**External identity** (`0014`). `workout_sessions` and `exercises` carry
`external_source` / `external_id`, with a partial UNIQUE index on each. On
sessions that index IS the idempotency guarantee: at most one CUT OS session can
ever exist per Hevy workout, so re-syncing updates the row that is there and the
58 + 65 = 123 arithmetic `0011` exists to prevent is unreachable on that path.
On exercises it makes "have I seen this movement before?" a lookup rather than a
search — and permanent, so renaming an exercise at the source cannot fork it.

`workout_sets` gained the same supersession pair (`0014`): a set removed at the
source is marked, not deleted, and one that comes back is restored rather than
duplicated. Both rules are read in `joinLoggedSets` (`lib/data/rows.ts`), which
also excludes the sets of a **withdrawn session** — a session's withdrawal is
not recorded on each of its sets, so the sets have to be excluded by their
parent.

`exercises` can now be written by a signed-in user, but only barely: the insert
policy requires `external_source is not null`, so an exercise can be created
from an external source and the seeded catalog cannot be added to by hand. The
update privilege is granted on `external_source` / `external_id` **alone**, so
an existing catalog row can be *adopted* (linked to its Hevy template) while its
name, muscle group and equipment stay exactly as the seed wrote them. RLS on
this table is deliberately **not** forced: `0009` is an upsert run by the
migration owner, and forcing it would subject every future re-seed to the policy
above.

`sync_runs` records one row per synchronisation attempt — status, times, counts,
warnings, error and cursor. Never deleted (the privilege is withheld outright, a
step stronger than the observation tables' missing policy), and a partial unique
index refuses a second `RUNNING` row per provider, so a second press — another
tab, an impatient double click — is turned away by the database rather than
racing the first.

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
SHA-256 over the normalised paste text plus the target date.

**For an external record the key is different, because the record has an
identity of its own**: `sha256(source:externalId:updatedAt)`. That one fact does
three jobs, all enforced by the same constraint — an unchanged workout is
refused (which is what makes re-syncing free), an edited one gets through
because its version differs, and every version that ever arrived keeps its own
row, so `health_imports` is the workout's history and not only its latest state.
The row holds the provider's response body verbatim (§17), before parsing
dropped anything the schema did not model. Normalisation
ignores whitespace, case and blank lines — so a re-copied report is recognised —
but not digits, so a genuinely edited value imports as new data.

The uniqueness is a database constraint, not an application check, so it cannot
be raced past.

**The key is per day, not per paste.** A paste describing a week becomes seven
`health_imports` rows, each hashed over its own lines. That is what makes
re-pasting the week after correcting one day import the corrected day and refuse
the other six, instead of duplicating all seven. A single-day paste is one
record whose text is the whole input, so its key is unchanged.

An import row is written `PENDING` before any observation is, and only updated
to `CONFIRMED` once every domain write has succeeded. A row left `PENDING` is an
import whose raw text was preserved but whose data did not land — visible in the
list on `/import`.

## What the importer writes

Per session, the review screen offers **ADD / REPLACE / KEEP**. ADD is the
default and the old behaviour; REPLACE writes the new row and supersedes the one
it names; KEEP writes nothing for that session.

## Where session data is read

`workout_sessions` is read by `getWorkoutSessions` (Training, and the
`/training/[sessionId]` detail page) and by `rebuildDailyMetrics`. Before that
query existed, the Training page's only training read was `getLoggedSets`, which
selects from `workout_sets` and inner-joins upward — so a session with no sets
produced no rows and an imported workout was invisible on the page named after
it, while still being counted in `daily_metrics`, adherence and the Context
Pack. Session-level and exercise-level reads are separate and both are wired.

`app/actions/import.ts` fans one confirmed day out across the raw layer:
`body_measurements`, `nutrition_logs`, `metric_observations`, `sleep_records`,
one `workout_sessions` row per training block and one `cardio_sessions` row per
cardio block, all tagged with the `import_id` that produced them. It then calls
`rebuildRange` for the days it wrote.

Two fields the parser understands are deliberately **not** stored: pace and
speed, both fully determined by `distance_km` and `duration_minutes`. The review
screen names them rather than showing a value it cannot keep.
