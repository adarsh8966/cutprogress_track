/**
 * Email confirmation landing (spec §34).
 *
 * Where the link in Supabase's confirmation email ends up. Two shapes arrive
 * here and both are accepted:
 *
 *  - ?code=...            the default template, which sends the user through
 *                         Supabase's own /auth/v1/verify first and comes back
 *                         with a PKCE code to exchange.
 *  - ?token_hash=&type=   a template customised to point straight here, as
 *                         Supabase's Next.js SSR guide suggests.
 *
 * Cookies are attached to the redirect explicitly. NextResponse.redirect()
 * builds a fresh response, so a session written during the exchange would
 * otherwise be dropped and the confirmed user would land back on /login - the
 * same trap middleware.ts documents.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { isSupabaseConfigured, readPublicEnv } from '@/lib/supabase/env';
import type { Database } from '@/lib/supabase/types';

/** Sends the visitor back to sign in with something to read. */
function failed(request: NextRequest, reason: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('error', reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isSupabaseConfigured()) return failed(request, 'unconfigured');

  const { url, anonKey } = readPublicEnv();
  const written: { name: string; value: string; options: object }[] = [];

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        // Includes the PKCE code verifier written when the account was created.
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        written.push(...cookiesToSet);
      },
    },
  });

  const code = request.nextUrl.searchParams.get('code');
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type') as EmailOtpType | null;

  let confirmed = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    confirmed = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    confirmed = !error;
  } else {
    return failed(request, 'confirmation_link');
  }

  const destination = request.nextUrl.clone();
  destination.search = '';
  if (confirmed) {
    destination.pathname = '/dashboard';
  } else {
    destination.pathname = '/login';
    destination.searchParams.set('error', 'confirmation_link');
  }

  const response = NextResponse.redirect(destination);
  for (const { name, value, options } of written) {
    response.cookies.set(name, value, options);
  }
  return response;
}
