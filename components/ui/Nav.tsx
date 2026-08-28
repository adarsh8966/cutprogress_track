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
  { href: '/progress', label: 'Progress' },
  { href: '/training', label: 'Training' },
  { href: '/nutrition', label: 'Nutrition' },
  { href: '/recovery', label: 'Recovery' },
  { href: '/review', label: 'Review' },
  { href: '/import', label: 'Import' },
  { href: '/context', label: 'Context' },
  { href: '/settings', label: 'Settings' },
];

export function Nav({ signOutAction }: { signOutAction: () => Promise<void> }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ground/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Link
          href="/dashboard"
          className="text-sm font-medium tracking-[0.18em] text-ink"
        >
          CUT OS
        </Link>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`text-xs transition-colors ${
                  active ? 'text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <form action={signOutAction} className="ml-auto">
          <button
            type="submit"
            className="text-xs text-ink-faint transition-colors hover:text-ink-muted"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
