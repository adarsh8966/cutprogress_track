'use server';

/**
 * Context Pack generation and persistence (spec §30, §43).
 *
 * The pack is generated from live data on request and stored with its schema
 * version and a content hash, so a pack handed to ChatGPT months ago can still
 * be produced and interpreted exactly as it was.
 */
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { getAnalyticsWindow } from '@/lib/data/queries';
import { generateContextPack, type ContextPack } from '@/lib/context/generate';
import { contentHash } from '@/lib/health/idempotency';
import { DEFAULT_PROFILE } from '@/lib/defaults';

export interface ContextResult {
  ok: boolean;
  message: string;
  pack?: ContextPack;
}

/** Builds the pack without storing it, for preview. */
export async function buildContextPack(): Promise<ContextResult> {
  const { profile, end, metrics, sets, sessions, cardio } = await getAnalyticsWindow();
  if (metrics.length === 0) {
    return {
      ok: false,
      message:
        'There is no data to build a context pack from yet. Log a weight or import a ' +
        'report first.',
    };
  }

  const pack = generateContextPack({
    generatedFor: end,
    profile: profile ?? DEFAULT_PROFILE,
    days: metrics,
    sets,
    sessions,
    cardio: cardio.map((c) => ({
      date: c.date,
      type: c.type,
      durationMinutes: c.durationMinutes,
      distanceKm: c.distanceKm,
      hrZone: c.hrZone,
    })),
  });

  return { ok: true, message: 'Context pack generated.', pack };
}

/** Builds the pack and records it in context_exports (spec §30). */
export async function generateAndStoreContextPack(): Promise<ContextResult> {
  const result = await buildContextPack();
  if (!result.ok || !result.pack) return result;

  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Not signed in.' };

  const pack = result.pack;
  const { error } = await supabase.from('context_exports').insert({
    user_id: auth.user.id,
    context_version: pack.version,
    generated_for_date: pack.generatedFor,
    body: pack.body,
    content_hash: contentHash(pack.body),
    data_quality_score: pack.dataQualityScore,
    analytics_version: pack.analyticsVersion,
    parameters: pack.parameters,
  });
  if (error) return { ok: false, message: error.message };

  await supabase.from('system_events').insert({
    user_id: auth.user.id,
    kind: 'CONTEXT_EXPORTED',
    summary: `Context pack v${pack.version} generated for ${pack.generatedFor}.`,
    detail: {
      dataQualityScore: pack.dataQualityScore,
      analyticsVersion: pack.analyticsVersion,
    },
    previous_value: null,
    new_value: null,
    reason: 'User generated a context pack.',
    status: 'RECORDED',
  });

  revalidatePath('/context');
  return { ok: true, message: 'Context pack generated and saved.', pack };
}
