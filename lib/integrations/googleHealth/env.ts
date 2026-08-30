import 'server-only';

/**
 * Google Health credentials (spec §34, §37).
 *
 * Read LAZILY and at request time, never at module scope - the rule
 * lib/supabase/env.ts sets and lib/integrations/hevy/env.ts follows, for the
 * same two reasons: `next build` has to succeed on a machine with no
 * credentials, and a missing variable has to surface as a sentence someone can
 * act on rather than a stack trace during static generation.
 *
 * WHY THIS IS NOT SIMPLY HEVY'S FILE AGAIN. Hevy needed one static API key, so
 * "no third-party credential is stored in the database" cost nothing: the key
 * lived in an environment variable and the promise held. OAuth cannot work that
 * way. A refresh token is issued per user, at consent time, and is revocable by
 * that user from their Google account - none of which an environment variable
 * can express. So the credential is stored, and the promise narrows to
 * something still worth making:
 *
 *   - the refresh token is encrypted at rest, AES-256-GCM
 *   - the key that decrypts it is in the environment and never in the database,
 *     so a database backup carries no usable credential
 *   - neither the token nor the key is ever returned to the browser, written
 *     into a sync_runs row, or put in a message a user reads
 *
 * The client secret and the token key are read only here, and this file is
 * `server-only`: a client component that imports it fails the build rather than
 * shipping a secret to a browser. Neither is ever prefixed NEXT_PUBLIC_ -
 * anything so prefixed is inlined into the browser bundle by Next.
 */

export interface GoogleHealthEnv {
  clientId: string;
  clientSecret: string;
  /** 32 bytes, base64 or hex, for AES-256-GCM. */
  tokenKey: Buffer;
  redirectUri: string;
  apiBaseUrl: string;
}

/** The documented API host. */
export const GOOGLE_HEALTH_API_BASE_URL = 'https://health.googleapis.com';
/** Google's OAuth 2.0 endpoints, as the documentation gives them. */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** The path Google redirects back to. Under /auth, which middleware lets through. */
export const CALLBACK_PATH = '/auth/google-health/callback';

export class MissingGoogleHealthConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Google Health is not configured. Missing: ${missing.join(', ')}. `
      + 'Set these in .env.local and in your deployment’s environment '
      + 'variables. None may be prefixed NEXT_PUBLIC_: anything so prefixed is '
      + 'inlined into the browser bundle by Next.',
    );
    this.name = 'MissingGoogleHealthConfigError';
    this.missing = missing;
  }
}

/**
 * Turns the configured key into 32 bytes, or explains why it could not.
 *
 * Accepts base64 or hex because both are what a `openssl rand` incantation
 * produces and neither is more correct. A key of the wrong length is refused
 * rather than padded: silently stretching 16 bytes to 32 would produce a cipher
 * that works, encrypts real tokens, and is not the algorithm anyone chose.
 */
export function parseTokenKey(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]{64}$/.test(raw.trim());
  const key = hex
    ? Buffer.from(raw.trim(), 'hex')
    : Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(
      'GOOGLE_HEALTH_TOKEN_KEY must decode to exactly 32 bytes for AES-256-GCM. '
      + `It decoded to ${key.length}. Generate one with: `
      + 'openssl rand -base64 32',
    );
  }
  return key;
}

/**
 * Where Google should send the user back to.
 *
 * Whatever this resolves to must be listed verbatim as an Authorized redirect
 * URI in the Google Cloud OAuth client, so it is derived from one explicit
 * variable rather than from request headers: behind a proxy the headers are not
 * a reliable guide to the public URL, and a redirect_uri that does not match
 * the registered one to the character is refused by Google with an error the
 * user cannot act on.
 */
export function readRedirectUri(): string {
  const explicit = process.env.GOOGLE_HEALTH_REDIRECT_URI;
  if (explicit) return explicit;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) return `${site.replace(/\/+$/, '')}${CALLBACK_PATH}`;
  return `http://localhost:3000${CALLBACK_PATH}`;
}

export function readGoogleHealthEnv(): GoogleHealthEnv {
  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  const tokenKeyRaw = process.env.GOOGLE_HEALTH_TOKEN_KEY;

  const missing: string[] = [];
  if (!clientId) missing.push('GOOGLE_HEALTH_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_HEALTH_CLIENT_SECRET');
  if (!tokenKeyRaw) missing.push('GOOGLE_HEALTH_TOKEN_KEY');
  if (missing.length > 0) throw new MissingGoogleHealthConfigError(missing);

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    tokenKey: parseTokenKey(tokenKeyRaw!),
    redirectUri: readRedirectUri(),
    apiBaseUrl: process.env.GOOGLE_HEALTH_API_BASE_URL || GOOGLE_HEALTH_API_BASE_URL,
  };
}

/**
 * Whether a connection could be attempted at all.
 *
 * Reads presence and never value, so nothing about a secret reaches a caller.
 * Used to keep "not configured", "not connected" and "the sync failed" three
 * different sentences on screen instead of one unhelpful one.
 */
export function isGoogleHealthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_HEALTH_CLIENT_ID
    && process.env.GOOGLE_HEALTH_CLIENT_SECRET
    && process.env.GOOGLE_HEALTH_TOKEN_KEY,
  );
}
