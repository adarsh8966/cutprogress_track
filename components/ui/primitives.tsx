/**
 * Shared display primitives.
 *
 * Two conventions are enforced here rather than repeated per page:
 *
 *  - A null measurement renders as "not logged", never as 0 or a dash that
 *    could be mistaken for zero (spec §33).
 *  - A status colour never appears without its label, because red and green are
 *    close to indistinguishable under deuteranopia (spec §49 and the data-viz
 *    accessibility rule).
 */
import type { ReactNode } from 'react';

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
