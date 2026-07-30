/**
 * Fitted evaluation weights: score = FIT_WEIGHTS · (the feature basis of
 * src/ai/features.ts). Cheap slots only; the verified ones are 0.
 *
 * GENERATED FILE — written by `npx tsx scripts/train-eval.ts --fit G3,G4 --out src/ai/eval-fit.ts`.
 * Edit the trainer, never this.
 *
 * Provenance: logistic regression on 229863 self-play positions (data/selfplay-v2,
 * 2026-07-30), config core+G3+G4, 3 training seeds.
 * Val loss 0.66610 against 0.69225 for the shipped hand eval
 * at its best temperature. Rescaled to the hand eval's score range over quiet
 * positions (|hand| < 1000), which cannot change move ordering.
 */
import { FEATURE_COUNT } from './features'

// prettier-ignore
export const FIT_WEIGHTS = Float64Array.from([
  25.5917, // tempo
  0.0000, // loop_sum
  0.0000, // line_max
  134.5856, // two_threat
  0.0000, // fork_count
  44.7932, // loop_d1
  21.3091, // loop_d2
  -5.0905, // loop_d3
  -40.0941, // loop_far
  -26.5856, // loop_blocked
  2.5536, // line1_s3
  -3.6112, // line1_s45
  13.8928, // line1_s6
  19.5704, // line1_s7
  8.8379, // line1_s8
  29.6112, // line2_s3
  30.6390, // line2_s45
  73.8448, // line2_s6
  23.0666, // line_double
  0.0000, // tracks
  0.0000, // waiter_blockable
  0.0000, // waiter_open
])

if (FIT_WEIGHTS.length !== FEATURE_COUNT) {
  throw new Error(`FIT_WEIGHTS has ${FIT_WEIGHTS.length} entries but FEATURE_COUNT is ${FEATURE_COUNT}`)
}
