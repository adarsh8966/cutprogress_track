/**
 * Shared display primitives.
 *
 * Two conventions are enforced here rather than repeated per page:
 *
 *  - A null measurement renders as "not logged", never as 0 or a dash that
 *    could be mistaken for zero (spec §33).
 *  - A figure that could not be COMPUTED does not borrow that sentence. See
 *    DerivedFigure: "not logged" is a claim about the data, and making it about
 *    a value that was merely too sparse to average tells the user their
 *    measurements were never recorded.
 *  - A status colour never appears without its label, because red and green are
 *    close to indistinguishable under deuteranopia (spec §49 and the data-viz
 *    accessibility rule).
 */
import type { ReactNode } from 'react';
import type { Derived } from '@/lib/types';
import { stateOf } from '@/lib/types';
import type { MetricReading } from '@/lib/analytics/reading';
import { coverageNote } from '@/lib/analytics/reading';

export type Status = 'good' | 'warn' | 'bad' | 'neutral';

const STATUS_COLOR: Record<Status, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-ink-faint',
};

const STATUS_TEXT: Record<Status, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  neutral: 'text-ink-muted',
};

/** Status is colour PLUS a word. The word is not optional. */
export function StatusDot({ status, label }: { status: Status; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[status]}`} />
      <span className={`text-xs ${STATUS_TEXT[status]}`}>{label}</span>
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-line bg-surface p-5 ${className}`}
    >
      {(title || action) && (
        <header className="mb-4 flex items-baseline justify-between gap-4">
          {title && (
            <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * A headline figure. `value` of null renders "not logged" in muted type rather
 * than a zero or an empty space.
 */
export function Figure({
  value,
  unit,
  label,
  sub,
  size = 'md',
}: {
  value: string | null;
  unit?: string;
  label?: string;
  sub?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'hero';
}) {
  const sizes = {
    sm: 'text-xl',
    md: 'text-3xl',
    lg: 'text-5xl',
    hero: 'text-6xl sm:text-7xl',
  };

  return (
    <div>
      {label && (
        <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          {label}
        </div>
      )}
      {value === null ? (
        <div className="text-base text-ink-faint">not logged</div>
      ) : (
        <div className={`tabular font-light leading-none ${sizes[size]}`}>
          {value}
          {unit && (
            <span className="ml-1.5 text-[0.4em] font-normal tracking-wide text-ink-faint">
              {unit}
            </span>
          )}
        </div>
      )}
      {sub && <div className="mt-2 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

/** The label block a stateful figure shares with Figure. */
function FigureLabel({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
      {label}
    </div>
  );
}

/**
 * A headline figure backed by a Derived<T>, which is every computed number in
 * the app.
 *
 * THE DISTINCTION THIS EXISTS TO KEEP. `Derived.value === null` covers four
 * different facts, and they must not read the same:
 *
 *   NOT_LOGGED    nothing was ever measured   -> "not logged"
 *   INSUFFICIENT  too little of it            -> "not enough data" + the count
 *   UNAVAILABLE   cannot be computed at all   -> the reason, "no target set"
 *   UNKNOWN       the method did not say      -> the note, and no claim
 *
 * Collapsing the first two is how four days of imported resting heart rate and
 * HRV came to be reported as never recorded: the 30-day average correctly
 * refused to be computed from 13% coverage, and the refusal was then rendered
 * as absence. The gate was right; the sentence was wrong.
 *
 * Collapsing the third is how the Dashboard reported Training as "not logged"
 * on a day with a training session on it - adherence had no target to score
 * against, which Settings fixes and logging never will.
 *
 * The states come from stateOf(), so any calculation that reports its evidence
 * gets this behaviour without the page knowing anything about coverage.
 */
export function DerivedFigure<T>({
  derived,
  format,
  unit,
  label,
  sub,
  size = 'md',
}: {
  derived: Derived<T>;
  /** Canonical value -> display string. Units convert here, not upstream. */
  format: (value: T) => string;
  unit?: string;
  label?: string;
  sub?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'hero';
}) {
  const state = stateOf(derived);

  if (state === 'PRESENT') {
    return (
      <Figure
        value={format(derived.value!)}
        unit={unit}
        label={label}
        sub={sub}
        size={size}
      />
    );
  }

  // Measurements exist; this particular figure could not be built from them.
  // Naming the count is what makes the difference legible - and it points at
  // the fix, which is more days, not re-entering the data.
  if (state === 'INSUFFICIENT') {
    const days = derived.observations!;
    const window = derived.inputs.windowDays ?? derived.inputs.searchWindowDays;
    return (
      <div>
        <FigureLabel label={label} />
        <div className="text-base text-ink-faint">not enough data</div>
        <div className="mt-1 text-xs text-ink-faint">
          {days} day{days === 1 ? '' : 's'} logged
          {typeof window === 'number' ? ` of ${window}` : ''}
        </div>
        {sub && <div className="mt-2 text-xs text-ink-muted">{sub}</div>}
      </div>
    );
  }

  // Nothing about the data will change this one. Say what would.
  if (state === 'UNAVAILABLE' || state === 'UNKNOWN') {
    return (
      <div>
        <FigureLabel label={label} />
        <div className="text-base text-ink-faint">not available</div>
        {derived.notes[0] && (
          <div className="mt-1 text-xs leading-snug text-ink-faint">
            {derived.notes[0]}
          </div>
        )}
        {sub && <div className="mt-2 text-xs text-ink-muted">{sub}</div>}
      </div>
    );
  }

  // NOT_LOGGED: the only state the sentence "not logged" is true of. Figure
  // renders it.
  return <Figure value={null} unit={unit} label={label} sub={sub} size={size} />;
}

/**
 * A ratio against a target (spec §27's nutrition bars).
 * Renders nothing but a note when either side is unknown.
 */
export function Meter({
  value,
  target,
  label,
  unit = '',
  overIsFine = false,
}: {
  value: number | null;
  target: number | null;
  label: string;
  unit?: string;
  overIsFine?: boolean;
}) {
  const known = value !== null && target !== null && target > 0;
  const ratio = known ? value / target : 0;
  const clamped = Math.min(1, Math.max(0, ratio));

  // Over target is amber for a point target (calories) and fine for a floor
  // target (protein, fibre, steps).
  const status: Status = !known
    ? 'neutral'
    : overIsFine
      ? ratio >= 0.9
        ? 'good'
        : ratio >= 0.7
          ? 'warn'
          : 'bad'
      : ratio > 1.1
        ? 'warn'
        : ratio >= 0.9
          ? 'good'
          : 'warn';

  const fill = {
    good: 'bg-good',
    warn: 'bg-warn',
    bad: 'bg-bad',
    neutral: 'bg-line-strong',
  }[status];

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="tabular text-xs text-ink">
          {value === null ? (
            <span className="text-ink-faint">not logged</span>
          ) : (
            <>
              {formatNumber(value)}
              {target !== null && (
                <span className="text-ink-faint">
                  {' / '}
                  {formatNumber(target)}
                  {unit && ` ${unit}`}
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div
          className={`h-full rounded-full ${fill} transition-[width]`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A Meter backed by a MetricReading, which is the honest version of the one
 * above.
 *
 * WHAT WENT WRONG WITH THE PLAIN METER. Its callers passed
 * `trailingAverage(...).value` - a bare `number | null` - so everything the
 * calculation knew about WHY the value was null was discarded at the call site.
 * A Dashboard showing "Nutrition 28-day average: not logged" for a day whose
 * calories were imported, stored and displayed on the Nutrition page was the
 * result: the average was correctly refused for coverage, and the refusal was
 * rendered as absence.
 *
 * So this takes the whole reading. When the average clears its gate it renders
 * exactly as before. When it does not, it falls back to the latest value that
 * WAS recorded, dated, with the coverage under it and the shortfall named. The
 * gate is untouched; only the sentence changes.
 *
 * The bar tracks the target only when a real average backs it. A single day
 * measured against a 28-day target is not a fill level, so the insufficient
 * case shows the figure and the coverage without pretending to a ratio.
 *
 * AND `scale` IS NOT APPLIED TO THE LATEST READING. Cardio is stored per day
 * and shown per week, so the average is multiplied by seven - but multiplying
 * ONE day's forty-one minutes into "287 min/wk" would state a week of training
 * the user did not do. A single reading is reported as itself, in `latestUnit`.
 */
export function DerivedMeter({
  reading,
  target,
  label,
  unit = '',
  latestUnit,
  overIsFine = false,
  format = (v: number) => formatNumber(v),
  /** Multiplies the daily AVERAGE, e.g. minutes/day -> minutes/week. */
  scale = 1,
}: {
  reading: MetricReading;
  target: number | null;
  label: string;
  unit?: string;
  /** Unit for a single day's reading, when `unit` describes a scaled rate. */
  latestUnit?: string;
  overIsFine?: boolean;
  format?: (value: number) => string;
  scale?: number;
}) {
  const { average, latest, coverage } = reading;

  if (average.value !== null) {
    return (
      <Meter
        label={label}
        value={average.value * scale}
        target={target}
        unit={unit}
        overIsFine={overIsFine}
      />
    );
  }

  // Nothing was ever recorded in the window. This is the one case the words
  // "not logged" actually fit.
  if (latest.value === null) {
    return (
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-muted">{label}</span>
          <span className="tabular text-xs text-ink-faint">not logged</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised" />
        <div className="mt-1 text-[11px] text-ink-faint">
          {coverageNote(coverage)}
        </div>
      </div>
    );
  }

  // Measurements exist. Show the most recent one, say when it was taken, and
  // say plainly that it is not the average the heading asks for.
  const observedOn = latest.inputs.observedOn;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="tabular text-xs text-ink">
          {format(latest.value)}
          {(latestUnit ?? unit) && (
            <span className="text-ink-faint"> {latestUnit ?? unit}</span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised" />
      <div className="mt-1 space-y-0.5 text-[11px] leading-snug text-ink-faint">
        <div>
          {/* The date is not decoration: a figure that does not say when it
              was taken invites being read as today's. */}
          latest reading
          {typeof observedOn === 'string' ? `, measured ${observedOn}` : ''}
          {' · '}
          {coverageNote(coverage)}
        </div>
        <div>Not enough for a {reading.windowDays}-day average</div>
      </div>
    </div>
  );
}

export function formatNumber(value: number, decimals?: number): string {
  const places =
    decimals ??
    (Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-ink-faint">{children}</p>
  );
}
