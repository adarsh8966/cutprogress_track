/**
 * Shell for every signed-in page.
 *
 * Routes are dynamic because they read per-user data and must never be
 * prerendered at build time - which also keeps `next build` working on a
 * machine with no Supabase credentials.
 */
import { Nav } from '@/components/ui/Nav';
import { signOut } from '@/app/actions/auth';

export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Nav signOutAction={signOut} />
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
