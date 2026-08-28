# Context Pack format

**Schema version 1.0** (`CONTEXT_VERSION` in `lib/context/generate.ts`).

Plain text, generated from live data, stored in `context_exports` with its
version, content hash and the parameters in force when it was produced.

## Section order

```
FITNESS CONTEXT PACK          header: date, context version, analytics version
INSTRUCTIONS FOR CHATGPT      the do-not-assume preamble
DATA QUALITY                  score, per-input coverage table
USER PROFILE
GOALS AND TARGETS
CURRENT STATE                 latest + 7/14/30-day averages, distance to target
WEIGHT TREND                  rate, R², direction, confidence
WAIST TREND
NUTRITION                     targets, averages, days logged / missing
ACTIVITY                      steps, zone 2, cardio and running totals
TRAINING                      sessions, volume, RIR/RPE, sets per muscle group
RECOVERY                      sleep, resting HR, HRV, rest days
ADHERENCE                     the seven components
RECENT DETAIL (14 DAYS)       per-day table
SUMMARY WINDOWS               30 / 60 / 90-day aggregates
MONTHLY HISTORY               everything older, by month
ANALYTICS                     TDEE, plateau verdict, projected date range
SYSTEM-DETECTED ISSUES
RECOMMENDATION CANDIDATES     each with its evidence
RECENT EVENTS                 optional user notes
QUESTIONS FOR CHATGPT
```

## Design rules

**Data quality comes before the data.** The reader is calibrated before it sees
a single number, so a LOW score produces hedged coaching rather than confident
coaching about a half-imagined picture.

**Missing values are written out.** A field that was not measured reads
`not logged`, and the detail table states explicitly that `-` does not mean
zero. Omitting the field would invite the model to fill it in.

**Compression is layered** (spec §31): 14 days of full daily detail, then
30/60/90-day summary statistics, then monthly summaries for everything older.
Recent texture plus long-term trajectory, without a blob no model reads well.

**Derived figures carry confidence.** Every computed value prints
`[confidence: high|moderate|low]`, or `not computable` with the reason.

**Recommendations are labelled as candidates**, with the evidence that produced
them, and the pack says the coaching call belongs to the reader.

## Versioning

`CONTEXT_VERSION` changes when the section structure changes. Every export
stores the version it was generated under plus a SHA-256 of the body, so a pack
handed over months ago stays interpretable and an identical regeneration is
recognisable.

The generator has a snapshot test
(`tests/unit/__snapshots__/context-pack.txt`) built from a fixed synthetic
dataset that deliberately contains gaps, weekly-cadence waist measurements and
unlogged days. Any change to the format shows up as a reviewable diff, and the
snapshot is scanned for language that would violate the safety rules.
