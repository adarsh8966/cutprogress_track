# CUT OS

A private, single-user fitness measurement and analytics platform.

The application is the measurement and analytics system. ChatGPT is the
reasoning and coaching layer. CUT OS does not try to be an opaque AI coach: it
records what happened, computes what the data supports, shows its working, and
produces a **Context Pack** you paste into ChatGPT for interpretation.

## What it does

- Tracks weight, waist, nutrition, steps, cardio, sleep and resistance training.
- Imports pasted summaries from Bevel, Google Health or your own notes, with a
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

**4. Create your account, then close the door**

CUT OS is single-user by design and has no sign-up form. In the Supabase
dashboard:

- Authentication → Users → **Add user**, with your email and a password.
- Authentication → Sign In / Providers → Email → turn **off** "Allow new users
  to sign up".

**5. Run it**

```bash
npm run dev
```

Sign in, then set your height, targets and timezone in Settings. The timezone
matters: every daily rollup uses it, so a workout logged at 11:30 PM lands on
the right day.

## Daily use

- **During the day** — log in Bevel / Health / your training app as usual.
- **At night** — paste the day's summary into Import, review what the parser
  found, correct anything wrong, and confirm.
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
- **Bevel API** — there is no integration and no credentials are stored. Bevel
  data arrives by copy and paste. If Bevel publishes an official API, that is
  the point to build one.
- **Trained ML models** — deliberately absent. The analytics are deterministic
  statistics, which is where nearly all the value is at this data volume. See
  `docs/ml.md` for the roadmap and the thresholds a model has to clear before
  it ships.

## Development

```bash
npm run verify      # typecheck + lint + tests + production build
npm run test        # 187 tests: pure analytics, parser, and PGlite integration
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
- No third-party credentials stored anywhere.
- The service-role key is never used in client code and never in a
  `NEXT_PUBLIC_` variable.
