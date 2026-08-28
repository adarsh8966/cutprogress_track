/**
 * Builds data/exercises/catalog.json.
 *
 * The catalog is written here rather than by hand so that ids, equipment names
 * and muscle-subgroup vocabularies stay consistent across ~120 entries.
 *
 * SOURCING RULE (spec §48: never fabricate data). `nippardTier` is left null on
 * every entry. The tier ratings come from Jeff Nippard's published catalog,
 * which is not present in this repository, and a guessed tier would be
 * indistinguishable from a sourced one. Running scripts/import-catalog.ts with
 * the real catalog fills them in. Likewise demonstrationUrl is null throughout.
 */
import { writeFileSync } from 'node:fs';

const APARTMENT = new Set(['Dumbbell', 'Cable', 'Smith Machine', 'Treadmill', 'Bodyweight', 'Bench']);

/** [name, primaryMuscleGroup, equipment, subgroups[]] */
const RAW = [
  // ---------------------------------------------------------------- Chest
  ['Machine Chest Press', 'Chest', 'Machine', ['Sternal Pectoralis', 'Triceps']],
  ['Smith Machine Bench Press', 'Chest', 'Smith Machine', ['Sternal Pectoralis', 'Triceps']],
  ['Smith Machine Incline Press', 'Chest', 'Smith Machine', ['Clavicular Pectoralis', 'Front Delts']],
  ['Dumbbell Bench Press', 'Chest', 'Dumbbell', ['Sternal Pectoralis', 'Triceps']],
  ['Dumbbell Incline Press', 'Chest', 'Dumbbell', ['Clavicular Pectoralis', 'Front Delts']],
  ['Dumbbell Flye', 'Chest', 'Dumbbell', ['Sternal Pectoralis']],
  ['Incline Dumbbell Flye', 'Chest', 'Dumbbell', ['Clavicular Pectoralis']],
  ['Cable Flye', 'Chest', 'Cable', ['Sternal Pectoralis']],
  ['Low-to-High Cable Flye', 'Chest', 'Cable', ['Clavicular Pectoralis']],
  ['High-to-Low Cable Flye', 'Chest', 'Cable', ['Costal Pectoralis']],
  ['Cable Chest Press', 'Chest', 'Cable', ['Sternal Pectoralis', 'Triceps']],
  ['Push-Up', 'Chest', 'Bodyweight', ['Sternal Pectoralis', 'Triceps']],
  ['Deficit Push-Up', 'Chest', 'Bodyweight', ['Sternal Pectoralis']],
  ['Dip', 'Chest', 'Bodyweight', ['Costal Pectoralis', 'Triceps']],
  ['Pec Deck', 'Chest', 'Machine', ['Sternal Pectoralis']],

  // ----------------------------------------------------------------- Back
  ['Pull-Up', 'Back', 'Bodyweight', ['Lats', 'Biceps']],
  ['Chin-Up', 'Back', 'Bodyweight', ['Lats', 'Biceps']],
  ['Neutral-Grip Pull-Up', 'Back', 'Bodyweight', ['Lats', 'Biceps']],
  ['Neutral-Grip Pulldown', 'Back', 'Cable', ['Lats', 'Biceps']],
  ['Lat Pulldown', 'Back', 'Cable', ['Lats', 'Biceps']],
  ['Wide-Grip Pulldown', 'Back', 'Cable', ['Lats', 'Teres Major']],
  ['Cable Row', 'Back', 'Cable', ['Mid Traps', 'Rhomboids', 'Lats']],
  ['Chest-Supported Row', 'Back', 'Machine', ['Mid Traps', 'Rhomboids']],
  ['Single-Arm Dumbbell Row', 'Back', 'Dumbbell', ['Lats', 'Mid Traps']],
  ['Chest-Supported Dumbbell Row', 'Back', 'Dumbbell', ['Mid Traps', 'Rhomboids']],
  ['Smith Machine Row', 'Back', 'Smith Machine', ['Mid Traps', 'Lats']],
  ['Straight-Arm Pulldown', 'Back', 'Cable', ['Lats']],
  ['Cable Pullover', 'Back', 'Cable', ['Lats']],
  ['Inverted Row', 'Back', 'Bodyweight', ['Mid Traps', 'Rhomboids']],
  ['Cable Face Pull', 'Back', 'Cable', ['Rear Delts', 'Mid Traps']],
  ['Dumbbell Shrug', 'Back', 'Dumbbell', ['Upper Traps']],
  ['Smith Machine Shrug', 'Back', 'Smith Machine', ['Upper Traps']],
  ['Cable Shrug', 'Back', 'Cable', ['Upper Traps']],
  ['Barbell Row', 'Back', 'Barbell', ['Mid Traps', 'Lats']],
  ['Seal Row', 'Back', 'Barbell', ['Mid Traps', 'Rhomboids']],

  // ------------------------------------------------------------ Shoulders
  ['Cable Lateral Raise', 'Shoulders', 'Cable', ['Side Delts']],
  ['Dumbbell Lateral Raise', 'Shoulders', 'Dumbbell', ['Side Delts']],
  ['Leaning Cable Lateral Raise', 'Shoulders', 'Cable', ['Side Delts']],
  ['Machine Lateral Raise', 'Shoulders', 'Machine', ['Side Delts']],
  ['Dumbbell Overhead Press', 'Shoulders', 'Dumbbell', ['Front Delts', 'Triceps']],
  ['Smith Machine Overhead Press', 'Shoulders', 'Smith Machine', ['Front Delts', 'Triceps']],
  ['Seated Dumbbell Press', 'Shoulders', 'Dumbbell', ['Front Delts', 'Triceps']],
  ['Reverse Pec Deck', 'Shoulders', 'Machine', ['Rear Delts']],
  ['Cable Reverse Flye', 'Shoulders', 'Cable', ['Rear Delts']],
  ['Dumbbell Reverse Flye', 'Shoulders', 'Dumbbell', ['Rear Delts']],
  ['Cable Upright Row', 'Shoulders', 'Cable', ['Side Delts', 'Upper Traps']],
  ['Dumbbell Front Raise', 'Shoulders', 'Dumbbell', ['Front Delts']],

  // --------------------------------------------------------------- Biceps
  ['Bayesian Cable Curl', 'Biceps', 'Cable', ['Long Head Biceps']],
  ['Cable Curl', 'Biceps', 'Cable', ['Biceps Brachii']],
  ['Dumbbell Curl', 'Biceps', 'Dumbbell', ['Biceps Brachii']],
  ['Incline Dumbbell Curl', 'Biceps', 'Dumbbell', ['Long Head Biceps']],
  ['Hammer Curl', 'Biceps', 'Dumbbell', ['Brachialis', 'Brachioradialis']],
  ['Cable Hammer Curl', 'Biceps', 'Cable', ['Brachialis', 'Brachioradialis']],
  ['Preacher Curl', 'Biceps', 'Dumbbell', ['Short Head Biceps']],
  ['Concentration Curl', 'Biceps', 'Dumbbell', ['Biceps Brachii']],
  ['Spider Curl', 'Biceps', 'Dumbbell', ['Short Head Biceps']],
  ['Reverse Curl', 'Biceps', 'Cable', ['Brachioradialis']],

  // -------------------------------------------------------------- Triceps
  ['Overhead Cable Triceps Extension', 'Triceps', 'Cable', ['Long Head Triceps']],
  ['Cable Triceps Pushdown', 'Triceps', 'Cable', ['Lateral Head Triceps']],
  ['Rope Triceps Pushdown', 'Triceps', 'Cable', ['Lateral Head Triceps']],
  ['Cross-Body Cable Extension', 'Triceps', 'Cable', ['Long Head Triceps']],
  ['Dumbbell Overhead Extension', 'Triceps', 'Dumbbell', ['Long Head Triceps']],
  ['Dumbbell Skull Crusher', 'Triceps', 'Dumbbell', ['Long Head Triceps']],
  ['Dumbbell Kickback', 'Triceps', 'Dumbbell', ['Lateral Head Triceps']],
  ['Close-Grip Smith Machine Press', 'Triceps', 'Smith Machine', ['Triceps', 'Sternal Pectoralis']],
  ['Bench Dip', 'Triceps', 'Bodyweight', ['Triceps']],

  // ------------------------------------------------------------- Quadriceps
  ['Hack Squat', 'Quadriceps', 'Machine', ['Vastus Lateralis', 'Rectus Femoris']],
  ['Smith Machine Squat', 'Quadriceps', 'Smith Machine', ['Vastus Lateralis', 'Glutes']],
  ['Smith Machine Front Squat', 'Quadriceps', 'Smith Machine', ['Rectus Femoris', 'Vastus Medialis']],
  ['Bulgarian Split Squat', 'Quadriceps', 'Dumbbell', ['Vastus Lateralis', 'Glutes']],
  ['Smith Machine Bulgarian Split Squat', 'Quadriceps', 'Smith Machine', ['Vastus Lateralis', 'Glutes']],
  ['Goblet Squat', 'Quadriceps', 'Dumbbell', ['Vastus Lateralis', 'Glutes']],
  ['Dumbbell Lunge', 'Quadriceps', 'Dumbbell', ['Vastus Lateralis', 'Glutes']],
  ['Walking Lunge', 'Quadriceps', 'Dumbbell', ['Vastus Lateralis', 'Glutes']],
  ['Reverse Lunge', 'Quadriceps', 'Dumbbell', ['Glutes', 'Vastus Lateralis']],
  ['Step-Up', 'Quadriceps', 'Dumbbell', ['Vastus Lateralis', 'Glutes']],
  ['Leg Extension', 'Quadriceps', 'Machine', ['Rectus Femoris', 'Vastus Medialis']],
  ['Leg Press', 'Quadriceps', 'Machine', ['Vastus Lateralis', 'Glutes']],
  ['Barbell Back Squat', 'Quadriceps', 'Barbell', ['Vastus Lateralis', 'Glutes']],
  ['Sissy Squat', 'Quadriceps', 'Bodyweight', ['Rectus Femoris']],

  // --------------------------------------------------------------- Hamstrings
  ['Romanian Deadlift', 'Hamstrings', 'Dumbbell', ['Biceps Femoris', 'Glutes']],
  ['Smith Machine Romanian Deadlift', 'Hamstrings', 'Smith Machine', ['Biceps Femoris', 'Glutes']],
  ['Seated Leg Curl', 'Hamstrings', 'Machine', ['Biceps Femoris', 'Semitendinosus']],
  ['Lying Leg Curl', 'Hamstrings', 'Machine', ['Biceps Femoris']],
  ['Single-Leg Romanian Deadlift', 'Hamstrings', 'Dumbbell', ['Biceps Femoris', 'Glutes']],
  ['Nordic Curl', 'Hamstrings', 'Bodyweight', ['Biceps Femoris']],
  ['Cable Pull-Through', 'Hamstrings', 'Cable', ['Glutes', 'Biceps Femoris']],
  ['Barbell Deadlift', 'Hamstrings', 'Barbell', ['Biceps Femoris', 'Glutes', 'Erectors']],

  // -------------------------------------------------------------- Glutes
  ['Hip Thrust', 'Glutes', 'Barbell', ['Gluteus Maximus']],
  ['Smith Machine Hip Thrust', 'Glutes', 'Smith Machine', ['Gluteus Maximus']],
  ['Dumbbell Hip Thrust', 'Glutes', 'Dumbbell', ['Gluteus Maximus']],
  ['Cable Kickback', 'Glutes', 'Cable', ['Gluteus Maximus']],
  ['Cable Hip Abduction', 'Glutes', 'Cable', ['Gluteus Medius']],
  ['Glute Bridge', 'Glutes', 'Bodyweight', ['Gluteus Maximus']],

  // -------------------------------------------------------------- Calves
  ['Smith Machine Calf Raise', 'Calves', 'Smith Machine', ['Gastrocnemius']],
  ['Standing Dumbbell Calf Raise', 'Calves', 'Dumbbell', ['Gastrocnemius']],
  ['Seated Calf Raise', 'Calves', 'Machine', ['Soleus']],
  ['Single-Leg Calf Raise', 'Calves', 'Bodyweight', ['Gastrocnemius']],

  // ----------------------------------------------------------------- Core
  ['Cable Crunch', 'Core', 'Cable', ['Rectus Abdominis']],
  ['Hanging Leg Raise', 'Core', 'Bodyweight', ['Lower Rectus Abdominis', 'Hip Flexors']],
  ['Hanging Knee Raise', 'Core', 'Bodyweight', ['Lower Rectus Abdominis']],
  ['Plank', 'Core', 'Bodyweight', ['Rectus Abdominis', 'Transverse Abdominis']],
  ['Cable Woodchop', 'Core', 'Cable', ['Obliques']],
  ['Dumbbell Side Bend', 'Core', 'Dumbbell', ['Obliques']],
  ['Ab Wheel Rollout', 'Core', 'Bodyweight', ['Rectus Abdominis']],
  ['Machine Crunch', 'Core', 'Machine', ['Rectus Abdominis']],
  ['Dead Bug', 'Core', 'Bodyweight', ['Transverse Abdominis']],
  ['Pallof Press', 'Core', 'Cable', ['Obliques', 'Transverse Abdominis']],

  // ------------------------------------------------------------- Forearms
  ['Cable Wrist Curl', 'Forearms', 'Cable', ['Wrist Flexors']],
  ['Dumbbell Wrist Curl', 'Forearms', 'Dumbbell', ['Wrist Flexors']],
  ['Dumbbell Reverse Wrist Curl', 'Forearms', 'Dumbbell', ['Wrist Extensors']],
  ['Farmer’s Carry', 'Forearms', 'Dumbbell', ['Grip', 'Upper Traps']],

  // --------------------------------------------------------------- Cardio
  ['Treadmill Incline Walk', 'Cardio', 'Treadmill', ['Cardiovascular']],
  ['Treadmill Run', 'Cardio', 'Treadmill', ['Cardiovascular']],
  ['Treadmill Walk', 'Cardio', 'Treadmill', ['Cardiovascular']],
  ['Stationary Bike', 'Cardio', 'Machine', ['Cardiovascular']],
  ['Rowing Machine', 'Cardio', 'Machine', ['Cardiovascular', 'Mid Traps']],
  ['Stair Climber', 'Cardio', 'Machine', ['Cardiovascular', 'Glutes']],
];

function slug(name) {
  return name
    .toLowerCase()
    .replace(/’/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const seen = new Set();
const catalog = RAW.map(([name, primaryMuscleGroup, equipment, muscleSubgroups]) => {
  const exerciseId = slug(name);
  if (seen.has(exerciseId)) throw new Error(`duplicate exercise id: ${exerciseId}`);
  seen.add(exerciseId);
  return {
    exerciseId,
    name,
    primaryMuscleGroup,
    equipment,
    // Left null deliberately: not sourced, so not invented. See header.
    nippardTier: null,
    muscleSubgroups,
    demonstrationUrl: null,
    active: true,
    apartmentGym: APARTMENT.has(equipment),
  };
}).sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));

writeFileSync(
  new URL('../data/exercises/catalog.json', import.meta.url),
  JSON.stringify(catalog, null, 2) + '\n',
);

const apartment = catalog.filter((e) => e.apartmentGym).length;
console.log(`wrote ${catalog.length} exercises (${apartment} performable in the apartment gym)`);
