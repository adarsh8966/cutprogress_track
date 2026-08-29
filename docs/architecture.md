# Architecture

```
Next.js 16 (App Router, React 19, TypeScript strict)
  ├── app/            routes + server actions
  ├── components/     UI, charts, forms
  └── lib/            PURE core - no I/O, no Supabase imports
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

The service-role key is not used anywhere in the application. It has a
commented-out slot in `.env.example` for a future Edge Function, with a warning
attached.

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
