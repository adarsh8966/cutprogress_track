/**
 * A section that opens when you ask it to, and not before.
 *
 * NATIVE <details>, DELIBERATELY. The visual language here is the chevron from
 * Quick Entry's Group; the mechanism is not. A useState toggle would make
 * every page that uses this a client component - on Training, that means
 * serialising every workout, nested Derived<T> and all, across the RSC
 * boundary to power a triangle. <details> costs nothing, works with
 * JavaScript off, is focusable, and toggles on both Enter and Space with the
 * expanded state exposed to assistive technology without a line of ARIA.
 *
 * THERE IS NO `open` PROP. Closed by default is the whole point of this
 * component, so it is a property of the component rather than a convention
 * every caller has to remember. Something that needs to start open is a
 * decision someone should have to write down.
 *
 * There is no `name` either. The exclusive-accordion attribute closes the
 * sibling you were reading; comparing two workouts side by side is a real
 * thing to want, so this never does that to you.
 *
 * The body stays in the DOM while closed - the same trade Quick Entry
 * documents for `hidden`. On Training that is roughly a thousand static lines
 * of set detail at ninety days. If it ever costs enough to notice, the fix is
 * to cap the list, not to move this to client state.
 */
import type { ReactNode } from 'react';

export function Disclosure({
  summary,
  children,
  variant = 'row',
  className = '',
}: {
  /** The collapsed row: what is worth reading before opening it. */
  summary: ReactNode;
  children: ReactNode;
  /** `row` sits in a divided list; `card` is a bordered section of its own. */
  variant?: 'row' | 'card';
  className?: string;
}) {
  const shell = variant === 'card' ? 'rounded-lg border border-line bg-surface' : '';
  const head = variant === 'card' ? 'px-5 py-4' : 'py-3';
  const body =
    variant === 'card' ? 'border-t border-line px-5 py-5' : 'pb-4 pl-6 pr-1';

  return (
    <details className={['group', shell, className].filter(Boolean).join(' ')}>
      {/*
        `list-none` removes the marker in Chrome and Firefox and
        ::-webkit-details-marker removes it in Safari. Both are needed; either
        one alone leaves a stray triangle next to the chevron on one engine.
        min-h-11 is the 44px touch target - this is the only control on the
        page and it is used on a phone.
      */}
      <summary
        className={`flex min-h-11 cursor-pointer list-none items-center gap-3 ${head} [&::-webkit-details-marker]:hidden`}
      >
        <span
          aria-hidden
          className="shrink-0 text-ink-faint transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      <div className={body}>{children}</div>
    </details>
  );
}

/** A collapsed section with the card title every other section carries. */
export function DisclosureSection({
  title,
  sub,
  children,
}: {
  title: string;
  /** A word about what is inside, read before deciding to open it. */
  sub?: string;
  children: ReactNode;
}) {
  return (
    <Disclosure
      variant="card"
      summary={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            {title}
          </span>
          {sub && <span className="text-[11px] text-ink-faint">{sub}</span>}
        </span>
      }
    >
      {children}
    </Disclosure>
  );
}
