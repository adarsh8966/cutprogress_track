/**
 * Hevy payloads and a fake Hevy, for the tests that drive the real sync.
 *
 * The shapes are the ones in the published API documentation. The fake serves
 * them over the same injected `fetch` the real client takes, so the code under
 * test is the actual client, the actual mapper and the actual writer - not a
 * stand-in for any of them.
 */
import type { HevyWorkout } from '@/lib/integrations/hevy/types';

export interface FixtureSet {
  index: number;
  type?: string | null;
  weight_kg?: number | null;
  reps?: number | null;
  rpe?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
}

export interface FixtureExercise {
  index: number;
  title: string;
  notes?: string | null;
  exercise_template_id: string;
  supersets_id?: number | null;
  sets: FixtureSet[];
}

export function hevyWorkout(overrides: Partial<{
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  updated_at: string;
  exercises: FixtureExercise[];
}> = {}): Record<string, unknown> {
  return {
    id: 'workout-push-1',
    title: 'Push Day',
    routine_id: null,
    description: 'Felt really strong today. Increased incline DB press.',
    start_time: '2026-08-29T22:00:00Z',
    end_time: '2026-08-29T23:04:00Z',
    updated_at: '2026-08-29T23:05:00Z',
    created_at: '2026-08-29T22:00:00Z',
    exercises: [
      {
        index: 0,
        title: 'Incline Dumbbell Press',
        notes: 'Went up 5 lb and it moved well.',
        exercise_template_id: 'TPL-INCLINE-DB',
        supersets_id: null,
        sets: [
          { index: 0, type: 'normal', weight_kg: 31.75, reps: 10, rpe: 7 },
          { index: 1, type: 'normal', weight_kg: 34, reps: 9, rpe: 8 },
          { index: 2, type: 'normal', weight_kg: 34, reps: 8, rpe: 9 },
        ],
      },
      {
        index: 1,
        title: 'Cable Lateral Raise',
        notes: null,
        exercise_template_id: 'TPL-CABLE-LAT-RAISE',
        supersets_id: null,
        sets: [
          { index: 0, type: 'warmup', weight_kg: 5, reps: 15, rpe: null },
          { index: 1, type: 'normal', weight_kg: 9, reps: 15, rpe: 8 },
        ],
      },
    ],
    ...overrides,
  };
}

export const TEMPLATES = [
  {
    id: 'TPL-INCLINE-DB',
    title: 'Incline Dumbbell Press',
    type: 'weight_reps',
    primary_muscle_group: 'chest',
    secondary_muscle_groups: ['triceps'],
    equipment_category: 'dumbbell',
    is_custom: false,
  },
  {
    id: 'TPL-CABLE-LAT-RAISE',
    title: 'Cable Lateral Raise',
    type: 'weight_reps',
    primary_muscle_group: 'shoulders',
    secondary_muscle_groups: [],
    equipment_category: 'cable',
    is_custom: false,
  },
];

export type HevyEvent =
  | { type: 'updated'; workout: Record<string, unknown> }
  | { type: 'deleted'; id: string; deleted_at?: string | null };

/**
 * A fake Hevy, served over `fetch`.
 *
 * `events` are handed back NEWEST FIRST, which is the ordering the API
 * documents and the ordering the sync has to cope with. `pageSize` is honoured
 * so paging is exercised rather than assumed.
 */
export function fakeHevy(options: {
  events: HevyEvent[];
  templates?: typeof TEMPLATES;
  onRequest?: (url: string) => void;
  failTemplates?: boolean;
}) {
  const templates = options.templates ?? TEMPLATES;

  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    options.onRequest?.(url.pathname + url.search);

    if (url.pathname === '/v1/workouts/events') {
      const since = url.searchParams.get('since') ?? '1970-01-01T00:00:00Z';
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '5');

      const visible = options.events.filter((event) => {
        const at = event.type === 'updated'
          ? String(event.workout.updated_at)
          : event.deleted_at ?? '1970-01-01T00:00:00Z';
        return Date.parse(at) >= Date.parse(since);
      });

      const start = (page - 1) * pageSize;
      return json({
        page,
        page_count: Math.max(1, Math.ceil(visible.length / pageSize)),
        events: visible.slice(start, start + pageSize),
      });
    }

    if (url.pathname === '/v1/exercise_templates') {
      if (options.failTemplates) return new Response('nope', { status: 500 });
      return json({ page: 1, page_count: 1, exercise_templates: templates });
    }

    if (url.pathname.startsWith('/v1/exercise_templates/')) {
      if (options.failTemplates) return new Response('nope', { status: 500 });
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      const found = templates.find((t) => t.id === id);
      return found ? json(found) : new Response('not found', { status: 404 });
    }

    if (url.pathname === '/v1/workouts/count') {
      return json({ workout_count: options.events.length });
    }

    if (url.pathname === '/v1/user/info') {
      return json({ data: { id: 'hevy-user', name: 'Test User', url: null } });
    }

    return new Response(`unexpected path ${url.pathname}`, { status: 404 });
  };

  return impl as unknown as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The documented workout, typed, for tests that map without going near HTTP. */
export function typedWorkout(overrides: Parameters<typeof hevyWorkout>[0] = {}) {
  return hevyWorkout(overrides) as unknown as HevyWorkout;
}
