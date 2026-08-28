'use server';

/**
 * Authentication actions (spec §34).
 *
 * Sign-in only. There is no sign-up path in the application: CUT OS is a
 * private, single-user system, and public signup is disabled in the Supabase
 * dashboard (Authentication -> Providers -> Email -> "Allow new users to sign
 * up"). The single account is created there once. See README.
 */
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';

const credentialsSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export interface AuthResult {
  ok: boolean;
  message: string;
}

export async function signIn(formData: FormData): Promise<AuthResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid credentials.' };
  }

  const supabase = await createActionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Deliberately not distinguishing "no such user" from "wrong password".
    return { ok: false, message: 'Those credentials were not accepted.' };
  }

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Signed in.' };
}

export async function signOut(): Promise<void> {
  const supabase = await createActionClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}
