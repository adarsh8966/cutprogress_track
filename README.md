# CUT OS

A private, single-user fitness measurement and analytics platform.

The application is the measurement and analytics system. ChatGPT is the
reasoning and coaching layer. CUT OS does not try to be an opaque AI coach: it
records what happened, computes what the data supports, shows its working, and
produces a **Context Pack** you paste into ChatGPT for interpretation.

## What it does

- Tracks weight, waist, nutrition, steps, cardio, sleep and resistance training.
- Syncs resistance training from **Hevy** through its official API: workouts,
  exercises, sets, reps, load, RPE and notes, with new exercises added
  automatically. One-way and read-only; nothing is ever written back.
- Imports pasted summaries from Bevel, Google Health or your own notes - one day
  or a whole week at a time, including training and cardio sessions - with a
  mandatory review step before anything is stored.
- Computes moving averages, trends, adherence, plateau status, observed TDEE and
  a target-date forecast with a range rather than a single confident date.
- Generates a versioned Context Pack that states its own data quality first.

Every number it shows can answer "why?" - the method, the exact inputs, and the
confidence level are attached to the value itself.

## Setup

You need a Supabase project. Nothing else is required.

**1. Install**

```bash
npm install
```

**2. Create a Supabase project** at supabase.com, then copy the environment file:

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
Project Settings → API.

**3. Apply the migrations**

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

This creates the schema, the row-level-security policies, and seeds the
118-exercise catalog.

**4. Allow sign-up, create your account, then close the door**

CUT OS is single-user by design, but it does have a sign-up form at `/signup`
so you can create that one account without opening the dashboard. Supabase
refuses `signUp()` unless the project allows it, so in the Supabase dashboard:

- Authentication → Sign In / Providers → Email → turn **on** "Allow new users
  to sign up".
- Authentication → URL Configuration → **Redirect URLs** → add
  `http://localhost:3000/auth/confirm`, plus `https://<your-domain>/auth/confirm`
  if you deploy. The confirmation email will not come back to the app without
  this.

Then open `/signup`, create your account, and confirm the address if
"Confirm email" is on (it is, by default) — the link lands on `/auth/confirm`,
which exchanges it for a session and drops you on the dashboard.

**Once your account exists, turn "Allow new users to sign up" back off.** The
page stays, but Supabase will reject any further account. This is the only
thing standing between a public URL and a stranger creating an account: the
app cannot tell the owner apart from anyone else who reaches `/signup`. Their
data would be walled off by row-level security either way — every table is
keyed to `auth.uid()`, so a second account sees an empty app, never yours —
but an account you did not create is still an account you did not create.

If you would rather never open the door at all, the old route still works:
Authentication → Users → **Add user**, with the sign-up switch left off.

**5. Run it**

```bash
npm run dev
```

Sign in, then set your height, targets and timezone in Settings. The timezone
matters: every daily rollup uses it, so a workout logged at 11:30 PM lands on
the right day.

## Connecting Hevy (optional)

Training comes in automatically if you use Hevy.

1. Get your API key at hevy.com/settings?developer. **The API is a Hevy Pro
   feature.**
2. Put it in `.env.local` as `HEVY_API_KEY`, and in your deployment's
   environment variables. Never prefix it `NEXT_PUBLIC_`.
3. Open `/import`, press **Test connection**, then **Sync Hevy**.

The first sync reads your whole history; after that it asks Hevy only what has
changed. Syncing repeatedly is free and cannot duplicate anything — the
guarantee is a database constraint, not a check in the code.

**Hevy is the source for training and nothing else.** It never writes body
weight, measurements, steps, heart rate, HRV, sleep or nutrition, even though
its API exposes some of those. That is enforced by the shape of the code: the
client has no method for them and the mapper's output type has no field for
them, both asserted by tests.

To sync on a schedule as well, see the optional block in `.env.example`; the
button works without any of it.

## Daily use

- **During the day** — train in Hevy, and log in Bevel / Health as usual.
- **At night** — press Sync on Import for training, and paste the day's summary
  for everything else: review what the parser found, correct anything wrong, and
  confirm. Several days can go in at once; each is reviewed and imported as its
  own record.
- **Weekly** — open Review, then Context, generate a pack, and paste it into
  your ChatGPT project.

Pasting the same report twice is refused rather than duplicating the day.

## Design decisions worth knowing

**Missing data is not zero.** A day where protein was not recorded stores
`null`. Analytics filter it out and report the coverage they had, rather than
averaging in a zero. Where coverage is too thin, the answer is "not computable"
with the reason, not a confident-looking number.

**Nothing raw is ever overwritten or deleted.** Every measurement is an
observation, kept forever. A canonical one-row-per-day view is *derived* from
them by documented source-priority rules, and can be rebuilt from scratch at any
time. This is enforced by the database: the RLS policies grant no delete or
update permission on the measurement tables at all.

**A plateau needs adherence to back it.** Flat weight on half-logged intake
returns `INSUFFICIENT_DATA`, never `PLATEAU` — those two lead to opposite
decisions, and only one of them is supported by the data.

**Recommendations are candidates, not commands.** They come from a closed set of
templates, each carrying the evidence that produced it. The app never changes a
target on its own; when anything does change, it is written to an audit log with
its reason.

**Storage is metric; display is yours.** kg, cm, km, kcal and minutes
internally, converted only at the UI and parser boundaries.

## Not implemented

Stated plainly so nothing here implies more than exists:

- **Health Connect** — planned for a later version. It needs Android
  permissions and a Play Store health-data declaration. Not built, not tested,
  not claimed.
- **Bevel API** — there is no integration. Bevel data arrives by copy and paste.
  Bevel publishes no official API, and scraping one would mean holding an
  account credential for a service that never offered it. Hevy is integrated
  precisely because it does offer one.
- **Writing back to Hevy** — deliberately not built. The integration is one-way:
  Hevy → CUT OS. A correction made here never leaves for Hevy, which keeps
  ownership clear and makes a sync loop impossible.
- **Rest time between sets** — Hevy's workout payload does not carry it. Its
  routines carry a *planned* rest, which is a different measurement, and it is
  not imported as though it were the rest actually taken.
- **Trained ML models** — deliberately absent. The analytics are deterministic
  statistics, which is where nearly all the value is at this data volume. See
  `docs/ml.md` for the roadmap and the thresholds a model has to clear before
  it ships.

## Development

```bash
npm run verify      # typecheck + lint + tests + production build
npm run test        # pure analytics, the parser and importer, and PGlite integration
npm run dev
```

Migrations and RLS policies are tested against real PostgreSQL compiled to WASM
(PGlite), so the SQL and the policy logic are exercised without Docker or a
hosted project.

See `CLAUDE.md` for the working agreement and `docs/` for architecture, the data
model, and every analytics formula written out.

## Privacy

- Row-level security on every user-owned table, keyed to `auth.uid()`.
- No photos of any kind — no upload path, no storage, no computer vision.
- **No third-party credential is stored in the database.** The one credential
  this app holds — a Hevy API key, issued by Hevy for its own public API — lives
  in a server-side environment variable, is read only by a `server-only` module,
  and is never returned to the browser, written to a table, or included in a log
  line or an error message. A database backup carries no key to any account.
- No password or scraped session for any other service, ever.
- The service-role key is never used in client code and never in a
  `NEXT_PUBLIC_` variable.
