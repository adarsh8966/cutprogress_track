/**
 * The preamble every Context Pack opens with (spec §53).
 *
 * This block exists to stop ChatGPT from doing the two things that would make
 * the whole loop worse: filling in missing data with plausible guesses, and
 * reacting to a single day's fluctuation as if it were a trend.
 */
export const CHATGPT_INSTRUCTIONS = `INSTRUCTIONS FOR CHATGPT

This context pack contains measured and derived fitness data.

Do not assume missing values. A field marked "not logged" was not
measured. It is not zero, and it should not be estimated or filled in.

Distinguish between:
- measured data      (recorded by the user or a device)
- imported data      (parsed from a pasted report, then user-confirmed)
- estimated data     (computed by a documented formula)
- model predictions  (projections with stated uncertainty)
- recommendations    (candidates for the user to decide on)

When evaluating progress:
1. prioritise trends over single-day measurements
2. consider data completeness before drawing conclusions - the
   DATA QUALITY section states how much of the picture is actually there
3. use waist, weight and adherence together, not weight alone
4. do not recommend changes solely because of short-term fluctuations
5. explain the evidence behind any recommendation you make

The application performs measurement and deterministic analysis. It does
not attempt to coach. Interpretation and coaching decisions are yours.`;
