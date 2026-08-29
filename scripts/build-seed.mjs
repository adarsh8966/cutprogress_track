/**
 * Regenerates supabase/migrations/0009_seed_exercises.sql from the catalog.
 * Run after changing data/exercises/catalog.json so the two cannot drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const catalog = JSON.parse(
  readFileSync(new URL('../data/exercises/catalog.json', import.meta.url), 'utf8'),
);

const quote = (value) =>
  value === null ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
const array = (values) =>
  values.length === 0
    ? "'{}'"
    : `array[${values.map((v) => quote(v)).join(', ')}]::text[]`;

const rows = catalog
  .map(
    (e) =>
      `  (${quote(e.exerciseId)}, ${quote(e.name)}, ${quote(e.primaryMuscleGroup)}, ` +
      `${quote(e.equipment)}, ${quote(e.nippardTier)}, ${array(e.muscleSubgroups)}, ` +
      `${quote(e.demonstrationUrl)}, ${e.active}, ${e.apartmentGym})`,
  )
  .join(',\n');

const sql = `-- 0009_seed_exercises.sql
-- Seeds the canonical exercise library (spec §10).
--
-- GENERATED FILE. Do not edit by hand: run \`node scripts/build-seed.mjs\`
-- after changing data/exercises/catalog.json.
--
-- Idempotent by design. exercise_id is a stable slug, so re-running this after
-- importing an updated catalog updates the reference rows in place and leaves
-- every historical workout_sets reference intact (spec §48: never delete
-- historical observations).
--
-- nippard_tier is null on every row: the tier ratings are not sourced in this
-- repository and are not invented here. See lib/health/catalog.ts.

insert into exercises
  (exercise_id, name, primary_muscle_group, equipment, nippard_tier,
   muscle_subgroups, demonstration_url, active, apartment_gym)
values
${rows}
on conflict (exercise_id) do update set
  name = excluded.name,
  primary_muscle_group = excluded.primary_muscle_group,
  equipment = excluded.equipment,
  nippard_tier = excluded.nippard_tier,
  muscle_subgroups = excluded.muscle_subgroups,
  demonstration_url = excluded.demonstration_url,
  active = excluded.active,
  apartment_gym = excluded.apartment_gym,
  updated_at = now();
`;

writeFileSync(
  new URL('../supabase/migrations/0009_seed_exercises.sql', import.meta.url),
  sql,
);
console.log(`wrote seed migration for ${catalog.length} exercises`);
