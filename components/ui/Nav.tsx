'use client';

/**
 * Primary navigation. Typography-only, no icons: the spec's design language is
 * "Apple Health meets Linear meets a serious quant dashboard", and an icon rail
 * would add chrome without adding information.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  // Resolves to /day/<today> server-side: the date depends on the profile's
  // timezone, so the browser's clock must not decide it (spec §40).
  { href: '/today', label: 'Today' },
  { href: '/progress', label: 'Progress' },
  { href: '/training', label: 'Training' },
  { href: '/nutrition', label: 'Nutrition' },
  { href: '/recovery', label: 'Recovery' },
  { href: '/review', label: 'Review' },
  { href: '/quick', label: 'Quick entry' },
  { href: '/import', label: 'Import' },
  { href: '/context', label: 'Context' },
  { href: '/settings', label: 'Settings' },
];

export function Nav({ signOutAction }: { signOutAction: () => Promise<void> }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ground/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-x-4 px-5 py-2 sm:flex-wrap sm:gap-x-6 sm:py-3">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium tracking-[0.18em] text-ink sm:min-h-0"
        >
          CUT OS
        </Link>
        {/*
          Ten links do not fit across a 320px phone. Wrapping them made three
          cramped rows of 16px targets; scrolling the row sideways keeps one
          line, keeps the order, and gives every link a full-height target.
          On sm and up there is room to wrap as before.
        */}
        <nav
          className="-mx-5 flex flex-1 items-center gap-x-5 overflow-x-auto px-5
                     [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
                     sm:mx-0 sm:flex-none sm:flex-wrap sm:gap-y-1 sm:overflow-visible sm:px-0"
        >
          {LINKS.map((link) => {
            // /today forwards to /day/<date>, so it stays the current page
            // once you are on one.
            const active = pathname === link.href
              || (link.href === '/today' && pathname.startsWith('/day/'));
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-xs transition-colors sm:min-h-0 ${
                  active ? 'text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <form action={signOutAction} className="shrink-0 sm:ml-auto">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center whitespace-nowrap text-xs text-ink-faint transition-colors hover:text-ink-muted sm:min-h-0"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
