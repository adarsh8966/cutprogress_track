# Architecture

```
Next.js 16 (App Router, React 19, TypeScript strict)
  ├── app/            routes + server actions
  ├── components/     UI, charts, forms
  └── lib/            PURE core - no I/O, no Supabase imports
        ├── integrations/hevy/   external training, one-way
        ↓
Supabase
  ├── PostgreSQL      raw observations → canonical daily rows → derived output
  ├── Auth            cookie sessions via @supabase/ssr
  └── RLS             every user table, keyed to auth.uid()
```

## The pure core

Everything in `lib/analytics`, `lib/normalization`, `lib/validation`,
`lib/health` and `lib/context` is a pure function over plain TypeScript types.
No database client, no fetch. The two functions that need the current time
(`localToday`, `parseText`) take it as an injectable parameter defaulting to
`new Date()`, so every test pins it.

This is deliberate and load-bearing. It means the entire analytical engine — the
part where a mistake produces a wrong health conclusion — is testable without
credentials, without a network, and without fixtures that pretend to be a
database. 160 of the 187 tests need nothing but Node; the other 27 exercise the
database directly.

`lib/data/` and `app/actions/` are the only modules that touch Supabase.

## The data flow

```
RAW OBSERVATION          append-only, never updated, never deleted
      ↓
NORMALISATION            units → metric, timestamp → local date
      ↓
VALIDATION               Zod at every boundary; safety review on targets
      ↓
CANONICAL RESOLUTION     source priority → one value per field per day
      ↓                  + provenance: which source won, how confident
DAILY_METRICS            a rebuildable cache
      ↓
ANALYTICS                pure functions → Derived<T>
      ↓
CONTEXT PACK             versioned text for ChatGPT
```

Each arrow is a pure transformation of the layer above it, which is what makes
the whole chain re-derivable. If the parser turns out to be wrong six months
from now, the original pasted text is still in `health_imports` and everything
downstream can be rebuilt from it.

## Why the canonical layer is a cache

`daily_metrics` is not a source of truth. It is the output of running
`rebuildDailyMetrics()` over the raw layer for one date, and running it again
always produces the same answer. So:

- a resolver bug is fixable by re-running it, not by data recovery
- the source-priority rules can change and history re-resolves correctly
- deleting the whole table loses nothing

That is why it is the one table whose RLS policies permit deletion.

## Writes

Every server action follows the same four steps:

1. validate the input with Zod at the boundary
2. insert a raw observation — never update or delete an existing one
3. rebuild the canonical row for the affected date
4. revalidate the pages that read it

Values arrive in the user's display units and are converted to canonical units
once, at step 1.

## External integrations

`lib/integrations/hevy/` is one more writer into the existing path, not a
subsystem beside it. It reads Hevy's change feed, normalises, and writes
`workout_sessions`, `workout_sets`, `exercises` and `health_imports` — the same
tables the manual logger and the paste importer write — so a synced workout is
read, resolved and analysed by everything downstream exactly as any other.

```
Hevy API  →  client.ts   (read-only surface, Zod-validated, injected fetch)
          →  mapper.ts   (PURE: metres→km, instant→local date, range checks)
          →  writer.ts   (keyed upserts; supersession, never deletion)
          →  rebuildDailyMetrics  → the existing canonical layer and readers
```

Three properties are structural rather than conventional:

- **Read-only.** Every client method is a GET, and the methods that exist are
  the ones used. There is no method to write back, so a sync loop is not a bug
  that can be introduced by calling the wrong one.
- **Training only.** `NormalisedWorkout` has no field for body weight,
  measurements, steps, heart rate, HRV, sleep or nutrition, so a body value read
  from a payload is a value with nowhere to go. A source-level test also fails
  the build if any file in the directory names a health table.
- **Client-agnostic.** `sync.ts` and `writer.ts` construct no Supabase client;
  they take whichever one the caller is entitled to use and filter by an
  explicit `user_id` besides. That is what lets one engine serve both the
  RLS-backed Sync button and the scheduled route.

## Auth and RLS

Sessions live in cookies via `@supabase/ssr`, so Server Components, Route
Handlers and Server Actions all act as the signed-in user and every query runs
under that user's policies. Middleware refreshes the session and redirects
signed-out traffic, but **RLS is the actual boundary** — the middleware only
decides which page renders.

Middleware never redirects a Server Action call. Those POSTs carry the action id
in `next-action` and expect the action's return value back; a redirect makes the
browser replay the POST at the target, where the action does not run and the
caller is handed the wrong payload. They are refreshed and passed through — the
actions guard themselves, and RLS is the boundary either way.

Supabase reports a refused sign-in and a request that never reached an auth API
through the same `error`, and only the first carries a message written for a
person. `lib/supabase/auth-errors.ts` separates them on shape, never on wording:
an `AuthRetryableFetchError` or `AuthUnknownError`, or an error carrying neither
a status nor a code, did not come from a parsed auth response. The transport
case is logged for the operator and reported as `unavailable`; nothing else is
allowed into a message the user reads. Left unseparated it renders the JSON
parser's own complaint — `Unexpected token '<', "<!DOCTYPE "...` — as the
sign-up verdict whenever the endpoint answers with an HTML document.

The service-role key is used in exactly one place, and only when the optional
scheduled sync is configured: `app/api/hevy/sync/route.ts`. A cron request
carries no cookie session, so there is no user for RLS to key on — the route
authenticates itself with `CRON_SECRET` (compared in constant time), names the
account with `CUT_OS_OWNER_USER_ID`, and every query downstream filters by that
id explicitly, because RLS is not there to catch a mistake on that path.

`lib/supabase/admin.ts` is a **single-caller module**: exactly one file may
import it, and `tests/unit/admin-client-containment.test.ts` fails the build if
a second one does. With the variables unset the route answers 503 and changes
nothing, and the Sync button works entirely under RLS without touching it.

The schedule is **once a day** (09:00 UTC in `vercel.json`), which is what
Vercel's free Hobby plan allows. Cadence is a preference rather than a
correctness property: the sync is incremental and idempotent, so a daily run
misses nothing a later one cannot pick up, and the Sync button covers
immediacy. `tests/unit/cron-schedule.test.ts` holds the schedule to at most
daily — the build refuses an over-frequent one rather than the deployment being
rejected after the fact, which is how an hourly schedule shipped once already.

## Environment handling

Supabase configuration is read lazily, at request time, never at module scope.
This keeps `next build` working on a machine with no credentials — which is how
this project is built and tested — and turns a missing variable into a clear
message instead of a stack trace during static generation. Every authenticated
route is `force-dynamic`.

## Testing

| Layer | Tool | What it proves |
|---|---|---|
| Pure core | Vitest | formulas, unit conversion, timezone handling, the parser, the Context Pack (snapshot) |
| Database | PGlite | migrations apply, constraints hold, RLS isolates users, observations cannot be deleted, the seed loads |
| Routes | `next build` | every page compiles and renders |

PGlite is real PostgreSQL compiled to WASM, running in-process. It reproduces
the parts of Supabase the migrations depend on — the `auth` schema, `auth.uid()`,
and the `authenticated` role — so policies are exercised as written. It is not a
substitute for verifying a hosted deployment.
