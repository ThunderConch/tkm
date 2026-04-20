import type { PvpGeneration } from './ruleset-types.js';

const RESTRICTED_SPECIES_BY_GENERATION: Record<PvpGeneration, readonly number[]> = {
  gen1: [150],
  gen2: [249, 250],
  gen3: [382, 383, 384],
  gen4: [483, 484, 486, 487, 493],
  gen5: [643, 644, 646],
  gen6: [716, 717],
  gen7: [791, 792, 800],
  gen8: [888, 889, 890],
  gen9: [1007, 1008],
};

export function getRestrictedSpeciesSeed(generation: PvpGeneration): readonly number[] {
  return RESTRICTED_SPECIES_BY_GENERATION[generation];
}
