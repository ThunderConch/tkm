import { DEFAULT_LEVEL_POLICY } from './level-compression.js';
import { getRestrictedSpeciesSeed } from './restricted-species.js';
import type {
  BattlePolicy,
  CheatPolicy,
  PartyPolicy,
  PvpGeneration,
  RulesetKey,
  RulesetRepository,
  RulesetSummary,
  SpecialLimits,
} from './ruleset-types.js';

const UPDATED_AT = '2026-04-11T06:00:00Z';

const DEFAULT_PARTY_POLICY: PartyPolicy = {
  size: 6,
  activePartySlotsPerPlayer: 1,
  speciesDupClause: true,
};

const DEFAULT_SPECIAL_LIMITS: SpecialLimits = {
  legendaryMythicalTotal: 2,
  restrictedTotal: 1,
};

const DEFAULT_BATTLE_POLICY: BattlePolicy = {
  format: 'single',
  teamPreview: false,
  leadSelection: 'slot1_auto',
  replacementSelection: 'manual',
  actionTimeoutSeconds: 45,
};

const DEFAULT_CHEAT_POLICY: CheatPolicy = {
  requireCleanSave: true,
  allowCheatFlaggedSave: false,
  growthSnapshotRequired: true,
};

function createRulesetSummary(generation: PvpGeneration): RulesetSummary {
  return {
    generation,
    rulesetKey: `tkm-friendly-${generation}-v1`,
    status: 'active',
    party: DEFAULT_PARTY_POLICY,
    specialLimits: DEFAULT_SPECIAL_LIMITS,
    levelPolicy: DEFAULT_LEVEL_POLICY,
    battlePolicy: DEFAULT_BATTLE_POLICY,
    cheatPolicy: DEFAULT_CHEAT_POLICY,
    updatedAt: UPDATED_AT,
  };
}

const ACTIVE_RULESETS: Record<PvpGeneration, RulesetSummary> = {
  gen1: createRulesetSummary('gen1'),
  gen2: createRulesetSummary('gen2'),
  gen3: createRulesetSummary('gen3'),
  gen4: createRulesetSummary('gen4'),
  gen5: createRulesetSummary('gen5'),
  gen6: createRulesetSummary('gen6'),
  gen7: createRulesetSummary('gen7'),
  gen8: createRulesetSummary('gen8'),
  gen9: createRulesetSummary('gen9'),
};

const RESTRICTED_SPECIES_BY_RULESET_KEY = Object.fromEntries(
  (Object.keys(ACTIVE_RULESETS) as PvpGeneration[]).map((generation) => [
    ACTIVE_RULESETS[generation].rulesetKey,
    getRestrictedSpeciesSeed(generation),
  ]),
) as Record<RulesetKey, readonly number[]>;

export class StaticRulesetRepository implements RulesetRepository {
  getActiveRulesetByGeneration(generation: PvpGeneration): RulesetSummary | undefined {
    return ACTIVE_RULESETS[generation];
  }

  getRestrictedSpeciesIdsByRulesetKey(rulesetKey: RulesetKey): readonly number[] | undefined {
    return RESTRICTED_SPECIES_BY_RULESET_KEY[rulesetKey];
  }
}

export function createStaticRulesetRepository(): RulesetRepository {
  return new StaticRulesetRepository();
}
