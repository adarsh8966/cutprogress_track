# Google Health

The successor to the Fitbit Web API, which is turned down in September 2026.
It is CUT OS's source for activity, recovery, sleep and body composition - the
half of the model that, until now, could only be typed in or pasted.

```
Google Health API
  → client.ts       read-only surface, injected fetch, classified errors, retries
  → registry.ts     PURE: data type → canonical destination (the one mapping table)
  → mapper.ts       PURE: provider JSON → normalised observations, in metric units
  → writer.ts       external_observations + the tables CUT OS already has
  → correlate.ts    PURE: workout ↔ recording, by interval overlap
  → telemetry.ts    heart rate and zone minutes, per session
  → sync.ts         runs, windows, checkpoints, partial failure
  → rebuildDailyMetrics
  → the canonical layer, every page, and the Context Pack
```

Nothing downstream of the writer knows Google Health exists. Weight lands in
`body_measurements`, steps and heart-rate summaries in `metric_observations`,
sleep in `sleep_records`, an unmatched activity in `cardio_sessions` - the same
tables the manual logger and the paste importer write.

## Scopes

Four, and only four. All Google Health scopes are classified **Restricted**,
which means a third-party security review before the app can serve more than
100 users.

| Scope | What it buys |
|---|---|
| `.activity_and_fitness.readonly` | steps, distance, floors, active minutes, active zone minutes, calories burned, VO2 max, exercise sessions |
| `.health_metrics_and_measurements.readonly` | weight, body fat, resting HR, HRV, heart-rate samples, respiratory rate, blood oxygen, sleep skin temperature |
| `.sleep.readonly` | sleep sessions and their stages |
| `.location.readonly` | the GPS track of an outdoor session, as TCX |

They live in `lib/integrations/googleHealth/scopes.ts` with a plain-English
reason each, which is the text the consent explanation in Settings is built
from. Nothing else in the codebase names a scope string.

**Deliberately not requested**, each for a stated reason:

- `.nutrition.readonly` — nutrition intake is entered by hand and stays that
  way. This also puts `hydration-log` out of reach, which is a real cost and
  the right trade.
- `.ecg.readonly`, `.irn.readonly` — clinical signals with no destination here.
- `.profile.readonly`, `.settings.readonly` — CUT OS already has a date of
  birth, and reads no device settings.
- every `.writeonly` — this integration never writes to Google. There is no
  write scope and no write method, so a write is not something that can be done
  by mistake.

## Data types

Each row is one entry in `registry.ts`. "Destination" is the canonical field the
value becomes.

### Activity and fitness

| Data type | Read via | Destination |
|---|---|---|
| `steps` | dailyRollUp | `daily_metrics.steps` |
| `distance` | dailyRollUp | `distance_km` (mm → km) |
| `floors` | dailyRollUp | `floors` |
| `active-minutes` | dailyRollUp | `active_minutes` |
| `active-zone-minutes` | dailyRollUp | `active_zone_minutes` |
| `active-energy-burned` | dailyRollUp | `active_calories` |
| `total-calories` | dailyRollUp | `total_calories_burned` |
| `vo2-max`, `daily-vo2-max`, `run-vo2-max` | list | `vo2_max` |
| `exercise` | list | correlated with training, or a session of its own |
| `time-in-heart-rate-zone` | list | zone evidence (telemetry) |
| `sedentary-period` | dailyRollUp | **stored, not yet mapped** |
| `activity-level`, `swim-lengths-data` | list | **stored, not yet mapped** |

### Health metrics

| Data type | Read via | Destination |
|---|---|---|
| `weight` | list | `body_measurements.weight_kg` |
| `body-fat` | list | `body_fat_pct` |
| `daily-resting-heart-rate` | list | `resting_heart_rate` |
| `daily-heart-rate-variability`, `heart-rate-variability` | list | `hrv_ms` (rmssd) |
| `heart-rate` | list | session telemetry and zone minutes |
| `daily-heart-rate-zones` | list | zone evidence |
| `daily-respiratory-rate`, `respiratory-rate-sleep-summary` | list | `respiratory_rate` |
| `daily-oxygen-saturation`, `oxygen-saturation` | list | `oxygen_saturation_pct` |
| `daily-sleep-temperature-derivations` | list | `sleep_records.temperature_delta_c` |

### Sleep

`sleep` (list) → `sleep_records`, with `rem_minutes`, `deep_minutes`,
`light_minutes`, `awake_minutes` and `short_awakenings`.

Duration is time **asleep**, not time in bed: awake stages are excluded. Short
awakenings are **counted, not summed in** — the API's own guidance is that they
overlap the surrounding stages rather than partitioning the night, so adding
them would count the same minutes twice. A night is attributed to the morning
it ended on, which is what `sleep_records.local_date` has always meant.

A classic (non-staged) log leaves the stage columns **null**, which means "this
device does not measure stages" and not "you had no REM sleep".

## OAuth

```
Settings → Connect
  → /auth/google-health/start      state nonce in an httpOnly cookie
  → accounts.google.com            access_type=offline&prompt=consent
  → /auth/google-health/callback   validate state, exchange, encrypt, store
  → /settings?google_health=connected
```

Both routes live under `/auth`, which `middleware.ts` already treats as public —
the callback has to be reachable without a session, because Google redirects a
browser to it carrying no cookie of ours. The start route guards itself.

`prompt=consent` is always sent. Google issues a refresh token only on the
*first* authorisation by default, so without it a reconnection after an expiry
returns an access token and no way to renew it.

**Failure is never silent.** Declined consent, a state mismatch, a spent code,
partial consent, a missing refresh token and a failed save each produce their
own sentence on the Settings page.

### The credential

The refresh token is encrypted with **AES-256-GCM** before it is stored:
ciphertext, nonce and authentication tag in three columns on
`google_health_connections`, and the key only in `GOOGLE_HEALTH_TOKEN_KEY`.
A copy of the database is therefore not a way into anyone's Google account.
Nothing about it is ever returned to the browser — the shape the UI receives
(`ConnectionState`) has no field that could carry one.

Access tokens are refreshed **on demand**, once per run, cached in the closure —
which is what the documentation asks for instead of a scheduled batch refresh.
A refusal with `invalid_grant` marks the connection revoked so the UI can say
exactly that.

## Synchronisation

`runGoogleHealthSync(supabase, userId, { api, trigger, grantedScopes, ... })`.
Constructs no Supabase client; takes the caller's, plus an explicit `userId`.

Google's filters range over **when a measurement was taken**, not when it was
written, so there is no way to ask "what changed?". What makes that survivable
is that every write is keyed: an unchanged record is refused by a unique index,
so re-reading a window is nearly free.

- **Backfill** — 365 days by default, chunked to the documented ceilings (14
  days for `heart-rate`, `active-minutes`, `total-calories`,
  `calories-in-heart-rate-zone`; 90 for the rest), **newest window first** so
  the dashboard fills while the rest arrives. Each completed `(data type,
  window)` is checkpointed into `sync_runs.detail`, so an interrupted backfill
  resumes rather than restarting.
- **Incremental** — a rolling 3-day re-read, because a watch that has been off
  the charger delivers its backlog dated to when it was *measured*.
- **Partial failure** — one data type failing costs that data type and nothing
  else. A refused *credential* fails the run, because the remaining twenty would
  fail identically.
- **Retries** — exponential backoff on 429 and 5xx, honouring `Retry-After`,
  capped at 30s.
- **Concurrency** — the partial unique index on `sync_runs` refuses a second
  `RUNNING` row.

Triggered by a **Sync** button. Nothing runs in the browser; the browser presses.

`options.windows` is the webhook-shaped seam: a notification handler would call
the same function with the intervals from the payload and nothing else changes.

### Why there is no webhook

A webhook arrives with no cookie session, so it has no user for RLS to key on,
and the only way to give it write access is the service-role key — which this
codebase deliberately removed (`tests/unit/service-role-absence.test.ts` fails
the build if one returns). Adding one back is a change to the security model.

Registering a subscriber also needs a Google Cloud service account with a Google
Health IAM role, an endpoint verification handshake, and Tink signature
verification on every notification. For one person whose device syncs every 15
minutes anyway, the latency saved does not pay for that surface. The seam is
there if it ever does.

## Identity

A data point has one of two external identities, and which one is legible from
the id itself.

**Google's, where Google sends one.** `DataPoint.name` —
`users/{uid}/dataTypes/{type}/dataPoints/{id}` — stored verbatim.

**CUT OS's own, where it does not.** Google documents `name` as supported for a
subset of identifiable data types only; for most types, the steps response among
them, a point carries a `dataSource` and a body and nothing else. Requiring the
field is what made the first real sync reject well-formed responses. So one is
minted, from the facts that identify the observation:

```
cutos:1/google-health/<dataType>/<timing>/s=<platform>~<recordingMethod>~<manufacturer>~<device>[/k=<discriminators>]

cutos:1/google-health/steps/i=2026-08-29T04:00:00.000Z..2026-08-30T04:00:00.000Z/s=FITBIT~AUTOMATICALLY_RECORDED~-~-
cutos:1/google-health/daily-resting-heart-rate/d=2026-08-29/s=FITBIT~-~-~-
```

- `timing` is `t=<instant>`, `i=<start>..<end>` or `d=<date>` — the most
  specific thing the record actually said, and no more.
- every part of the source is optional and renders as `-` when absent, so a
  response with no device metadata still mints a stable id.
- `k=` carries the registry's `identity` discriminators, for the types where a
  time and a source are not unique. `time-in-heart-rate-zone` returns one point
  per zone over one interval; without the zone name four of five would collide
  and be silently refused by the index.
- the scheme is **versioned** because changing the format is a data migration:
  every id ever minted is stored, and a v1 id has to keep meaning what it meant.
- the measurement is deliberately **not** part of the identity. A revised step
  count must be a correction to one observation, not a second observation of the
  same day.

A Google resource name always begins `users/`, so the two can never be confused
— `isDerivedExternalId` in `identity.ts` is the one place that decides.

## Idempotency

`external_observations` is the ledger, and its unique index is the guarantee:

```sql
unique (user_id, provider, data_type, external_id,
        coalesce(external_updated_at, '-infinity'),
        coalesce(content_version, ''))
```

- an **unchanged** record is refused outright — which is what makes re-syncing
  free
- an **edited** record has a different version, so it gets through as a new row
- **every version** that ever arrived keeps its row, so the table is the
  measurement's history and not only its latest state

`coalesce`, not a bare column: in PostgreSQL every NULL is distinct, so a
nullable column in a unique index does not constrain the rows that leave it
null — and a data type whose payload carries no `updateTime` would silently
lose the guarantee.

**`content_version` (0017) is why that last sentence is not still true.** It is
a digest of the data point exactly as it arrived, and it exists because
`external_updated_at` is absent far more often than the design assumed: the
aggregation endpoints send no `updateTime` at all. Every version was then NULL,
every version matched, and the second read of a day was refused as a duplicate
of the first — so **today**, still accumulating, would keep whatever partial
figure the morning's sync happened to see. A wrong number that looks settled is
worse than a missing one.

With the digest in the key, a byte-identical re-read is still refused and a
revised value arrives as a correction. The digest is taken over a canonical
rendering (object keys sorted at every depth, array order preserved) of the
**raw** point — not of the parsed one, or adding a field to the response schema
would change every record's version and re-import a year as corrections.

Rows written before 0017 have no digest, and there is no honest way to compute
one for them. They stay NULL, and the first sync that re-reads one writes a
fresh row and supersedes it: same value, new row, nothing lost.

## A malformed point costs one point

Parsing is per data point, not per page. The envelope — `dataPoints`,
`nextPageToken` — is still validated strictly, because getting it wrong breaks
pagination silently. Each point is then validated on its own, and one that
cannot be read is reported beside the ones that could.

This was the other half of the same bug. The failure was at the envelope, so a
single unreadable element threw away the whole window, and the sync then
abandoned the rest of that data type. One optional field cost most of a year.

Warnings are aggregated by data type and kind
(`lib/integrations/googleHealth/warnings.ts`): one sentence, one worked example
and a count, rather than a line per record. A systematic failure across twenty
data types used to render as the same 300-character validation dump twenty
times, in the panel and again in `sync_runs.error`.

A **corrected** record is a new observation that supersedes its predecessor,
never an update: the observation tables grant no UPDATE on their measurement
columns. Both rows survive; one counts. `sleep_records` and `cardio_sessions`
carry external identity with a **partial** unique index (`where superseded_at is
null`), so a superseded predecessor does not keep hold of the identity its
replacement needs.

## Provenance

Every value can answer:

| Question | Where |
|---|---|
| Where did this come from? | `daily_metrics.provenance[field].source` |
| Which provider record? | `external_observations.external_id` |
| Is that identity Google's or ours? | the `cutos:1/` prefix — see **Identity** |
| Which version of it? | `external_updated_at`, and `content_version` |
| What did the provider actually send? | `external_observations.payload` |
| When was it measured? | `observed_at` / `interval_start` / `local_date` |
| When did CUT OS receive it? | `external_observations.created_at` |
| Was it corrected? | a live row with a superseded predecessor |
| Is it the active value? | `superseded_at is null`, and the resolver |

## Source precedence

Resolution is **recency-first**: the newest observation for a day wins, and
source priority only breaks a tie between two readings of the same instant.
That rule is right, and it was arrived at the hard way.

It has one consequence a connected provider makes real: an imported measurement
recorded *later in the day* than a manual correction is, by that rule, the newer
observation. So a manual observation **pins** the fields it carried for that
date (`canonical_field_pins`), and the resolver then considers only
hand-authored observations for a pinned field.

The imported observation is still written, still carries its provenance, and is
shown on `/day/[date]` as *your entry* with one click to lift the pin. A pin
changes which observation is canonical and nothing else.

## Workout correlation

`correlate.ts`, pure and deterministic. No language model: "did these two
records describe the same workout?" is a question about overlapping intervals,
with an arithmetic answer that is the same every time, can be explained in one
sentence, and costs nothing.

Score, in order of weight: **overlap** (60%) of the shorter session — below 50%
nothing else can rescue the pair — then **edge proximity** (20%, ±5 min
tolerance), **duration similarity** (15%) and **type agreement** (5%, never
sufficient alone).

The brief's example: `10:00 → 11:05` against `10:01:14 → 11:04:37` overlaps 98%
and matches. Two workouts on one day stay two workouts — only overlap gets a
pair past the floor, and each side is used at most once, so a morning push and
an evening run cannot claim the same physiology. Sessions crossing midnight are
compared as instants, never as dates.

A matched recording does **not** become a session of its own — that would double
the day's training. An unmatched one does: a walk that was never in Hevy must
not vanish. Cardio types go to `cardio_sessions`, everything else to
`workout_sessions`; the list is explicit in `mapper.ts` because the two
destinations feed different analytics.

## Heart rate and Zone 2

`lib/analytics/zones.ts`, pure, returning `Derived<T>`.

Two methods, and the difference is always reported:

- **From samples** — integrate the time between consecutive readings against the
  user's own boundaries. The real answer, and the only one that can say
  "22 minutes". Gaps longer than 3 minutes are left **uncounted** rather than
  attributed, because integrating across an off-wrist hole would report more
  Zone 2 than the workout was long. `coverage` says how much of the session
  that left.
- **From the provider's bands** — Fitbit's Fat Burn / Cardio / Peak, used only
  when there are no samples, mapped onto zones 2/3/4. Never better than MODERATE
  confidence, because the boundaries are Google's, not the user's.

And a third outcome that is not a method: **no heart rate means unavailable, not
zero**. A session nobody measured did not contain zero minutes of Zone 2.

Nothing in the file reads a workout's title. "Zone 2 Ride" is a label somebody
typed; a session called "Upper Body" can contain more Zone 2 than one called
"Cardio".

Zone boundaries come from `hr_zone_definitions`, in preference order: the user's
saved settings, then a **measured** maximum from recorded heart rate, then
`220 − age` **labelled ESTIMATED** — a model parameter, not a measurement — then
nothing. `daily_metrics.zone2_minutes` sums cardio zone-2 minutes *and*
per-session computed minutes, so a lifting session with a cardio block is finally
representable.

## Canonical readers, for the assistant

`lib/data/context/` — the one door the OpenAI layer will knock on.

`getDailyHealthContext` · `getRecoveryContext` · `getSleepContext` ·
`getTrainingContext` · `getWorkoutContext` · `getHeartRateContext` ·
`getZone2Context` · `getWeightTrend` · `getNutritionContext` ·
`getRecentFitnessContext` · `getFitnessContextForDateRange`

Three properties, each asserted by `tests/unit/ai-context-boundary.test.ts`:

1. **No provider name crosses the line** — not in a type, a field or a value.
2. **They are the readers the UI uses** — `getAnalyticsWindow` and the pure
   analytics, not a parallel path. One source of truth means the assistant and
   the screen cannot disagree.
3. **Nothing is copied** — no AI store, no duplicate history. Functions over the
   canonical model, scoped to a range.

Values arrive as `Derived<T>` with method, inputs, confidence and caveats, so
the model can say "your resting heart rate averaged 62 over 30 days, from 22
days of readings" rather than inventing a framing for a bare `62`. And
`FitnessContext.missing` names what is *absent*, because a model that cannot see
a gap will fill it.

## Google Cloud setup

1. **Project** — one Google Cloud project. Note the project **number** as well
   as the id; the subscriber endpoints want the number.
2. **Enable the API** — "Google Health API" on the API Library page.
3. **OAuth consent** — Google Auth Platform → Branding. User type **External**,
   publishing status **Testing**.
4. **Test user** — Audience → Test users → add your own Google account. This is
   the account whose Fitbit/Google Health data is read; do **not** create a
   separate CUT OS user for it.
5. **Scopes** — Data Access → Add or remove scopes → the four listed above.
6. **Client** — Credentials → Create credentials → OAuth client ID → **Web
   application**.
7. **Authorized redirect URIs** — exactly, character for character:
   - `http://localhost:3000/auth/google-health/callback`
   - `https://<your-vercel-domain>/auth/google-health/callback`
8. **Environment variables** — see `.env.example`. In Vercel, set
   `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_CLIENT_SECRET`,
   `GOOGLE_HEALTH_TOKEN_KEY` and `GOOGLE_HEALTH_REDIRECT_URI` for Production
   (and Preview, if you use it).
9. **Migrations** — `supabase db push` to apply `0015` and `0016`.

### Testing mode expires refresh tokens after seven days

Documented, and visible in the token response as
`refresh_token_expires_in: 604799`. Until the OAuth app is published you will
need to reconnect weekly. The app says so in as many words rather than
presenting the expiry as a mysterious failure.

## Limitations found in the supplied documentation

- The supplied copy is a rendered scrape with the **"Response" panes collapsed**.
  Concrete response JSON exists only for `exercise` (from the codelab),
  `active-energy-burned`, and a `sleep` write body. Other field names come from
  prose. The adapter is therefore tolerant and preserves raw payloads — and
  reads both `distanceMillimeters` (documented) and `distanceMillimiters`
  (observed).
- `floors` and `calories-in-heart-rate-zone` support no `list` operation.
  `total-calories` is listed rollup-only in the data-type table although the
  calories guide shows a `list` example; `dailyRollUp` is used.
- `users.pairedDevices` (last device sync time) needs a scope the documentation
  says users are not obliged to grant. Not used.
- The webhook page's scope→data-type list is narrower than its own
  supported-types list. Moot here — no webhook.
- `respiratory-rate` appears in device-compatibility lists but not in the master
  data-types table; only `daily-respiratory-rate` and
  `respiratory-rate-sleep-summary` are used.

## Adding a data type later

One entry in `registry.ts`. If the metric is new to CUT OS, also: a `metric_key`
value (alone in its own migration, per the `0013` note), a `daily_metrics`
column, a `METRIC_FIELD` entry in `lib/data/canonicalise.ts`, and a reader.

A supported type with no destination is not a problem — mark it `UNMAPPED` and
it is fetched, stored whole, and surfaced in Settings until somebody maps it.
Its history is then already on disk, so mapping it later needs no re-import of
a window the API may no longer return.
