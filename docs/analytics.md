# Analytics

Every calculation in `lib/analytics/` is a pure function returning `Derived<T>`:

```ts
{ value: T | null, method: string, inputs: Record<string, unknown>,
  confidence: 'HIGH' | 'MODERATE' | 'LOW' | 'INSUFFICIENT', notes: string[] }
```

`value: null` means *not computable from the data available*. It is never a
stand-in for zero. This document writes out every formula so a number in the app
can be checked by hand.

## The missing-data rule

A measurement that was not taken is `null`. `presentValues()` is the only
sanctioned way to drop nulls from a series, and it is paired with a coverage
measurement so the caller always knows what fraction of the window was real.

The mean of `[1, null, 3]` is **2**, not 1.33. If nulls became zeros, every
average in the system would be biased downward by however often the user forgot
to log. A measured `0` (zero cardio minutes on a rest day) is kept, because that
is a real observation.

## Moving averages

Trailing mean over the `n` calendar days ending on a date, over the days that
carry data.

**Coverage gate.** Below `MIN_COVERAGE` (0.5) the result is `null` with the
reason attached, rather than a "7-day average" computed from two days. Coverage
also sets confidence: ≥85% HIGH, ≥70% MODERATE, otherwise LOW.

## Trend

Ordinary least squares of value against day index over a trailing window.

```
slope   = Σ(x-x̄)(y-ȳ) / Σ(x-x̄)²
perWeek = slope × 7
R²      = 1 - SSres/SStot
SE      = √( SSres/(n-2) / Σ(x-x̄)² )
```

Fitted on **raw daily points, not the smoothed series**. Smoothing first and
regressing after understates the standard error, because a moving average makes
neighbouring points correlated and the fit look tighter than the data supports.

Minimum 5 points. The standard error is what makes the forecast honest.

**Window sizes differ by metric cadence.** Weight is daily and uses 28 days.
Waist is weekly and uses 84 days — a 28-day window can only ever hold four waist
measurements, below the minimum for a fit.

## Rate change

Compares the trend over the recent half of a window against the earlier half:
`ACCELERATING`, `STEADY`, `SLOWING`, `REVERSED`. The threshold is
`max(|earlier rate| × 0.25, 0.05)` — scale-free, with a floor so a near-zero
earlier rate does not make every comparison look enormous. Coarse by nature; it
is a prompt to look, not a conclusion.

## Plateau detection

A plateau requires **all four** of these over at least 14 days:

1. the 7-day weight average moved less than 0.45 kg (~1 lb) across the window
2. calorie intake was stable — coefficient of variation ≤ 0.15
3. activity was stable — step CV ≤ 0.25
4. nutrition was logged on **more than 85%** of days

The fourth is checked **first**, and failing it returns `INSUFFICIENT_DATA` — never
`PLATEAU`. Flat weight on half-logged intake is not evidence of a metabolic
plateau; it is evidence of not knowing what was eaten. The two lead to opposite
coaching decisions.

## TDEE

**Phase 1 — the prior.** Mifflin-St Jeor:

```
BMR = 10·weight_kg + 6.25·height_cm - 5·age + s     (s = +5 male, -161 female)
```

× an activity factor derived from *observed* steps (1.2 under 4k, rising to 1.65
above 13k) rather than a self-reported lifestyle bucket. This is a population
formula and is labelled as such everywhere it appears.

**Phase 2 — the observation.** Energy balance over the window:

```
TDEE_observed ≈ mean_intake - (Δweight_kg/day × 7700 kcal/kg)
```

7700 kcal/kg is the conventional figure for mixed tissue loss. It is an
approximation, and the app says so.

**Combining.** Precision weighting, so the observation earns influence as
well-logged days accumulate:

```
w    = n / (n + 21)
TDEE = w · observed + (1-w) · prior
SE   = √( (w·SE_obs)² + ((1-w)·prior·0.10)² )     where SE_obs = SE_slope × 7700
```

Below 14 well-logged days at 80% intake coverage, no observed component is
produced: the prior is reported alone, explicitly flagged as *not what your data
says*. No model is trained (see `ml.md`).

## Forecast

```
days_to_target = (target - fitted_current) / slope_per_day
```

Three dates, from the slope ±1 standard error: optimistic, best estimate,
conservative. Capped at 730 days.

Returns `null` when the trend is flat, or when it moves away from the target —
extrapolating a date from a slope that never reaches it would be fiction.

## Adherence

Scored **per day, then averaged** — not scored on the average. A 1,400 day and a
2,500 day must not cancel into a perfect score.

- Calorie adherence is **symmetric**: `max(0, 1 - |actual-target|/target)`.
  Under-eating misses the target as much as over-eating.
- Protein, fibre and steps are **floors**: `min(1, actual/target)`. Exceeding is
  not penalised.
- Training and cardio are measured against the weekly target pro-rated to the
  window.
- Logging adherence is the mean of nutrition and weight coverage.

Unlogged days lower **logging** adherence, not calorie adherence. A component
with no target set is excluded from the overall figure rather than scored zero.

## Data quality (0-100)

Weighted coverage: weight 25, nutrition 25, training 15, steps 15, sleep 10,
waist 10. Each is measured against how often that metric is *expected* — waist
scores full marks at weekly cadence, training at 5 days a week — so a correctly
followed routine is not penalised for not being daily.

≥80 HIGH, ≥55 MODERATE, otherwise LOW. Printed at the top of every Context Pack
so conclusions get calibrated before they are read.

## Nutrition score

Weighted adherence to the **user's own targets**, normalised over the points
that could actually be scored, with the full component breakdown always
returned. Default weights (all configurable): calories 30, protein 25, fibre 10,
logging completeness 10, fruit/veg 10, fat-carb balance 5, user-defined 10.

Fat/carb balance scores full marks anywhere from 20-60% of non-protein energy
from fat. A day is never marked down for its macro split alone. An unlogged day
is *unscoreable*, not a zero.

## Training

Training is measured on **two independent axes**, and they are never mixed.

**Session level** (`summariseSessions`, from `workout_sessions`) — a session
happened, for this long, at this heart rate, burning this much. True for every
recorded session, including one imported as a summary. Average heart rate is
weighted by duration, because a mean of session averages would let a 10-minute
session count as much as a 90-minute one, and it is taken only over the sessions
that reported one; the coverage is stated in the result's inputs.

**Exercise level** (`summariseTraining`, from `workout_sets`) — what was
performed inside a session. Volume, RIR, e1RM and progression all live here and
are **absent, never zero**, when no sets were logged.

A summary import carries the first and not the second, so nothing at the
exercise level is ever derived from a session: a "Pull, 58 min" record cannot
say which exercises were performed, and the system does not guess.

**e1RM (Epley):** `w × (1 + reps/30)`. Brzycki (`w × 36/(37-reps)`) is
implemented for cross-checking; the two agree within ~4% at 5 reps and diverge
past 8%, so only Epley is reported.

**Volume:** `weight × reps`, working sets only. Warm-ups are recorded but
excluded — otherwise adding warm-up sets would look like progress.

**Progression** compares the first and last session for an exercise, in order of
significance: added load → added reps → added volume. A ±2% band keeps rounding
noise from reading as progress. Fewer than two sessions returns
`INSUFFICIENT_DATA`.

## Reviews

Weekly change is measured **between the 7-day averages** at each end of the
week, not between two single weigh-ins — one morning reading can sit two pounds
from the truth on water alone.
