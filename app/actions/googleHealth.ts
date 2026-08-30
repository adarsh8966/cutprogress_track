'use server';

/**
 * The Google Health integration's server actions (spec §34, §41).
 *
 * Mirrors app/actions/hevy.ts: guard, authenticate, build the client, run the
 * engine, revalidate. The engine constructs no Supabase client of its own and
 * is handed the signed-in user's, so every read and write runs under that
 * user's RLS policies.
 *
 * NOTHING HERE RETURNS A CREDENTIAL. The connection status is built from
 * toConnectionState(), a shape with no ciphertext field on it - a type that
 * cannot carry a secret cannot leak one, which is a better guarantee than
 * remembering to strip fields at each call site.
 */
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import {
  isGoogleHealthConfigured, readGoogleHealthEnv,
} from '@/lib/integrations/googleHealth/env';
import {
  createAccessTokenProvider, toConnectionState, openToken, revokeToken,
  NotConnectedError, OAuthExchangeError, type ConnectionState,
} from '@/lib/integrations/googleHealth/oauth';
import { createGoogleHealthClient } from '@/lib/integrations/googleHealth/client';
import {
  runGoogleHealthSync, GOOGLE_HEALTH_PROVIDER, DEFAULT_BACKFILL_DAYS,
  type GoogleHealthSyncSummary,
} from '@/lib/integrations/googleHealth/sync';
import { zonesFromMax, estimatedMaxHeartRate } from '@/lib/analytics/zones';

const TOUCHED = [
  '/settings', '/import', '/dashboard', '/progress', '/recovery', '/training', '/context',
];

function failed(message: string): GoogleHealthSyncSummary {
  return {
    ok: false, status: 'FAILED', message, runId: null,
    recordsFound: 0, recordsCreated: 0, recordsUpdated: 0, recordsUnchanged: 0,
    recordsWithdrawn: 0, recordsFailed: 0, sessionsCorrelated: 0,
    warnings: [], byDataType: [], unmappedTypes: [],
    cursorBefore: null, cursorAfter: null, backfillComplete: false,
  };
}

/** The connection as the UI may see it. Never carries a token. */
export async function getGoogleHealthConnection(): Promise<ConnectionState> {
  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return toConnectionState(null);

  const { data } = await supabase
    .from('google_health_connections')
    .select('*')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  return toConnectionState(data ?? null);
}

/**
 * Reads one small thing, to prove the stored credential still works.
 *
 * Separate from syncing on purpose: "is this connection alive?" and "fetch a
 * year of history" are different questions with different costs, and a user
 * debugging a failed sync should be able to ask the cheap one.
 */
export async function testGoogleHealthConnection(): Promise<{
  ok: boolean; message: string; healthUserId: string | null;
}> {
  if (!isGoogleHealthConfigured()) {
    return { ok: false, message: 'Google Health is not configured.', healthUserId: null };
  }

  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Not signed in.', healthUserId: null };

  try {
    const env = readGoogleHealthEnv();
    const api = createGoogleHealthClient({
      accessToken: createAccessTokenProvider(supabase, auth.user.id),
      baseUrl: env.apiBaseUrl,
    });
    const identity = await api.getIdentity();
    return {
      ok: true,
      message: 'Connected. Google accepted the stored authorisation.',
      healthUserId: identity.healthUserId ?? identity.fitbitUserId ?? null,
    };
  } catch (error) {
    const message = error instanceof NotConnectedError
      ? error.message
      : error instanceof OAuthExchangeError
        ? error.userMessage
        : error instanceof Error ? error.message : String(error);
    return { ok: false, message, healthUserId: null };
  }
}

export async function syncGoogleHealth(): Promise<GoogleHealthSyncSummary> {
  if (!isGoogleHealthConfigured()) {
    return failed(
      'Google Health is not configured. Set GOOGLE_HEALTH_CLIENT_ID, '
      + 'GOOGLE_HEALTH_CLIENT_SECRET and GOOGLE_HEALTH_TOKEN_KEY.',
    );
  }

  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return failed('Not signed in.');

  const connection = await supabase
    .from('google_health_connections')
    .select('*')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (connection.error) {
    return failed(`Could not read the connection: ${connection.error.message}`);
  }
  if (!connection.data || connection.data.revoked_at !== null) {
    return failed('Google Health is not connected. Connect it from Settings first.');
  }

  try {
    const env = readGoogleHealthEnv();
    const api = createGoogleHealthClient({
      accessToken: createAccessTokenProvider(supabase, auth.user.id),
      baseUrl: env.apiBaseUrl,
    });

    const summary = await runGoogleHealthSync(supabase, auth.user.id, {
      api,
      trigger: 'MANUAL',
      grantedScopes: connection.data.granted_scopes ?? [],
      backfillDays: DEFAULT_BACKFILL_DAYS,
    });

    for (const path of TOUCHED) revalidatePath(path);
    return summary;
  } catch (error) {
    const message = error instanceof NotConnectedError
      ? error.message
      : error instanceof OAuthExchangeError
        ? error.userMessage
        : error instanceof Error ? error.message : String(error);
    return failed(message);
  }
}

/**
 * Disconnects.
 *
 * The credential is DESTROYED - the ciphertext, its nonce and its tag are all
 * nulled - and the row is kept with revoked_at set. That is the honest pair of
 * facts: this account was connected, and it is not any more. Every measurement
 * already imported stays exactly where it is; disconnecting a source is not a
 * reason to delete what it observed.
 *
 * Google is asked to forget the grant too, best-effort. Disconnecting must
 * succeed whether or not Google is reachable - the alternative is a user who
 * cannot remove a connection because a third party is down.
 */
export async function disconnectGoogleHealth(): Promise<{ ok: boolean; message: string }> {
  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Not signed in.' };

  const { data } = await supabase
    .from('google_health_connections')
    .select('*')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (data && isGoogleHealthConfigured()) {
    const env = readGoogleHealthEnv();
    const token = openToken({
      ciphertext: data.refresh_token_ciphertext ?? undefined,
      iv: data.refresh_token_iv ?? undefined,
      tag: data.refresh_token_tag ?? undefined,
    }, env.tokenKey);
    if (token !== null) await revokeToken(token);
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('google_health_connections')
    .update({
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_tag: null,
      access_token_expires_at: null,
      revoked_at: nowIso,
      last_error: null,
      updated_at: nowIso,
    })
    .eq('user_id', auth.user.id);

  if (error) return { ok: false, message: `Could not disconnect: ${error.message}` };

  await supabase.from('system_events').insert({
    user_id: auth.user.id,
    kind: 'PROVIDER_DISCONNECTED',
    summary: 'Google Health was disconnected.',
    detail: { provider: GOOGLE_HEALTH_PROVIDER },
    previous_value: null, new_value: null, reason: null, status: 'RECORDED',
  });

  for (const path of TOUCHED) revalidatePath(path);
  return {
    ok: true,
    message: 'Disconnected. The stored authorisation was destroyed; everything '
      + 'already imported is unchanged.',
  };
}

/**
 * Saves heart-rate zone boundaries from a maximum heart rate.
 *
 * The maximum is the one number a user can reasonably supply, and the five
 * zones follow from it by the conventional percentages. Whether it was measured
 * or estimated is recorded with it, so every zone figure downstream can say
 * which it was rather than presenting an estimate as a measurement.
 */
export async function saveHeartRateZones(formData: FormData): Promise<{
  ok: boolean; message: string;
}> {
  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Not signed in.' };

  const raw = String(formData.get('maxHeartRate') ?? '').trim();
  const measured = formData.get('measured') === 'on';

  if (raw === '') {
    const { error } = await supabase
      .from('hr_zone_definitions').delete().eq('user_id', auth.user.id);
    if (error) return { ok: false, message: `Could not clear the zones: ${error.message}` };
    for (const path of TOUCHED) revalidatePath(path);
    return {
      ok: true,
      message: 'Zone settings cleared. Zones will be derived from your recorded '
        + 'maximum heart rate, or from your age if there is none.',
    };
  }

  const maxHeartRate = Number(raw);
  if (!Number.isFinite(maxHeartRate) || maxHeartRate < 100 || maxHeartRate > 250) {
    return {
      ok: false,
      message: 'A maximum heart rate should be between 100 and 250 bpm.',
    };
  }

  const model = zonesFromMax(
    maxHeartRate,
    measured ? 'MEASURED_MAX' : 'MANUAL',
    measured
      ? `a measured maximum of ${maxHeartRate} bpm`
      : `a maximum of ${maxHeartRate} bpm that you entered`,
  );

  // Replaced wholesale rather than merged: five zones are one model, and a
  // half-updated set would put boundaries from two different maxima side by side.
  await supabase.from('hr_zone_definitions').delete().eq('user_id', auth.user.id);
  const { error } = await supabase.from('hr_zone_definitions').insert(
    model.definitions.map((zone) => ({
      user_id: auth.user!.id,
      zone: zone.zone,
      lower_bpm: zone.lowerBpm,
      upper_bpm: zone.upperBpm,
      method: model.method,
      max_heart_rate: maxHeartRate,
      derived_from: model.derivedFrom,
    })),
  );

  if (error) return { ok: false, message: `Could not save the zones: ${error.message}` };

  for (const path of TOUCHED) revalidatePath(path);
  return {
    ok: true,
    message: `Saved. Zone 2 is ${model.definitions[1]!.lowerBpm}–`
      + `${model.definitions[1]!.upperBpm} bpm.`,
  };
}

/**
 * The suggested maximum for the zone form: measured if there is one, otherwise
 * age-predicted, otherwise nothing.
 *
 * Returns the method as well as the number, because a form that pre-fills an
 * estimate without saying it is one invites the user to accept it as a fact
 * about their body.
 */
export async function suggestedMaxHeartRate(): Promise<{
  value: number | null; method: 'MEASURED_MAX' | 'ESTIMATED_MAX' | null; note: string;
}> {
  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { value: null, method: null, note: '' };

  const observed = await supabase
    .from('session_telemetry')
    .select('max_hr')
    .eq('user_id', auth.user.id)
    .not('max_hr', 'is', null)
    .order('max_hr', { ascending: false })
    .limit(1);

  const highest = observed.data?.[0]?.max_hr;
  if (highest != null && Number(highest) >= 120) {
    return {
      value: Math.round(Number(highest)),
      method: 'MEASURED_MAX',
      note: 'The highest heart rate recorded during one of your sessions. A '
        + 'training maximum is usually a little below a true maximum.',
    };
  }

  const profile = await supabase
    .from('profiles').select('date_of_birth').eq('id', auth.user.id).maybeSingle();
  const dob = profile.data?.date_of_birth;
  if (dob) {
    const age = Math.floor(
      (Date.now() - Date.parse(String(dob))) / (365.2425 * 24 * 3600 * 1000),
    );
    if (age > 0 && age < 120) {
      return {
        value: estimatedMaxHeartRate(age),
        method: 'ESTIMATED_MAX',
        note: `220 − ${age}. This is a population average and can be out by 10–20 bpm `
          + 'for one person. Replace it with a measured maximum if you have one.',
      };
    }
  }

  return {
    value: null, method: null,
    note: 'Set a date of birth in your profile, or record a workout with heart '
      + 'rate, and a starting point can be suggested here.',
  };
}
