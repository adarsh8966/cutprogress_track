# Machine learning

**There is no trained model in this system, and that is the correct state.**

## Why not

Most of the useful intelligence here is deterministic statistics. Whether 205 is
greater than 204, whether protein was 140 g, whether a workout was completed —
that is database logic. A model that answers those questions is worse than a
comparison operator, not better.

The current analytics are a moving average, a least-squares fit, a coefficient
of variation, and an energy-balance identity. Those are not placeholders waiting
to be replaced. They are the right tools, they are inspectable, and at this data
volume they will outperform anything learned.

## Where ML could genuinely help, later

| Model | Job | Realistic threshold |
|---|---|---|
| Weight trajectory | forecast the next 4-8 weeks | ~6 months of near-daily weights |
| Observed TDEE | personal maintenance intake | ~3 months at >80% intake logging |
| Plateau probability | continuous score, not a verdict | several labelled plateaus |
| Target-date prediction | calibrated intervals | a full completed cut |
| Adherence risk | flag a likely miss before it happens | ~6 months of behaviour |

Every one of these needs data this user does not have yet on day one.

## The bar a model must clear

A model ships only if it **beats the deterministic baseline on held-out data**.
The baselines are the ones already implemented:

- weight trajectory → the 28-day least-squares extrapolation
- observed TDEE → the shrinkage estimator in `lib/analytics/tdee.ts`
- plateau → the four-condition rule in `lib/analytics/plateau.ts`

Measure, do not assert: weight-prediction MAE, TDEE estimation error, plateau
precision and recall. If the model does not beat the baseline, the baseline
stays. "The ML model is accurate" is not a claim this project accepts without
the numbers behind it.

## Versioning

Any prediction must record `model_name`, `model_version`, the prediction,
confidence, `generated_at` and the features used — the same discipline the
deterministic analytics already follow, where `ANALYTICS_VERSION` is stamped on
every review, recommendation and Context Pack.

## Pipeline shape, when it exists

```
Postgres → feature extraction → feature table → training set
        → model → evaluation vs baseline → prediction
        → recommendation candidate (never an applied change)
```

Note the last step. A model produces a *candidate with evidence*, which the user
and ChatGPT decide on. It does not change a target. That constraint holds for
the deterministic engine today and does not relax for a learned one.

## Hard safety constraint

Recommendations are drawn from a closed enum of templates
(`recommendation_kind`). A model may select among them and supply evidence; it
may not generate a new one. This is what structurally prevents an unsafe
protocol from being emitted — the templates for it do not exist.
