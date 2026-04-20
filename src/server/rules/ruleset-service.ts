import { computeEffectiveLevel as computeEffectiveLevelWithPolicy } from './level-compression.js';
import { createStaticRulesetRepository } from './ruleset-repository.js';
import { isPvpGeneration } from './ruleset-types.js';
import type { PvpGeneration, RulesetRepository, RulesetSummary } from './ruleset-types.js';

function parseGeneration(generation: string): PvpGeneration {
  if (!isPvpGeneration(generation)) {
    throw new Error(`Unsupported PvP generation: ${generation}`);
  }

  return generation;
}

function normalizeSpeciesId(speciesId: number | string): number {
  const parsedSpeciesId = typeof speciesId === 'string' ? Number(speciesId) : speciesId;

  if (!Number.isInteger(parsedSpeciesId) || parsedSpeciesId < 1) {
    throw new Error(`Species ID must be a positive integer: ${speciesId}`);
  }

  return parsedSpeciesId;
}

export class RulesetService {
  constructor(private readonly repository: RulesetRepository = createStaticRulesetRepository()) {}

  getRulesetByGeneration(generation: string): RulesetSummary {
    const parsedGeneration = parseGeneration(generation);
    const ruleset = this.repository.getActiveRulesetByGeneration(parsedGeneration);

    if (!ruleset) {
      throw new Error(`No active PvP ruleset configured for generation: ${generation}`);
    }

    return ruleset;
  }

  getRestrictedSpeciesIds(generation: string): readonly number[] {
    const ruleset = this.getRulesetByGeneration(generation);
    return this.repository.getRestrictedSpeciesIdsByRulesetKey(ruleset.rulesetKey) ?? [];
  }

  isRestrictedSpecies(generation: string, speciesId: number | string): boolean {
    const normalizedSpeciesId = normalizeSpeciesId(speciesId);
    return this.getRestrictedSpeciesIds(generation).includes(normalizedSpeciesId);
  }

  computeEffectiveLevel(actualLevel: number, generation: string): number {
    const ruleset = this.getRulesetByGeneration(generation);
    return computeEffectiveLevelWithPolicy(actualLevel, ruleset.levelPolicy);
  }
}

const defaultRulesetService = new RulesetService();

export function getRulesetByGeneration(generation: string): RulesetSummary {
  return defaultRulesetService.getRulesetByGeneration(generation);
}

export function getRestrictedSpeciesIds(generation: string): readonly number[] {
  return defaultRulesetService.getRestrictedSpeciesIds(generation);
}

export function isRestrictedSpecies(generation: string, speciesId: number | string): boolean {
  return defaultRulesetService.isRestrictedSpecies(generation, speciesId);
}

export function computeGenerationEffectiveLevel(actualLevel: number, generation: string): number {
  return defaultRulesetService.computeEffectiveLevel(actualLevel, generation);
}
