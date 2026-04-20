export const SUPPORTED_PVP_GENERATIONS = [
  'gen1',
  'gen2',
  'gen3',
  'gen4',
  'gen5',
  'gen6',
  'gen7',
  'gen8',
  'gen9',
] as const;

export type PvpGeneration = (typeof SUPPORTED_PVP_GENERATIONS)[number];

export type RulesetStatus = 'active';
export type BattleFormat = 'single';
export type LeadSelectionMode = 'slot1_auto';
export type ReplacementSelectionMode = 'manual';
export type LevelDisplayMode = 'actual-level-visible';
export type EffectiveFormulaKey = 'soft-cap-after-50-v1';

export type RulesetKey = `tkm-friendly-${PvpGeneration}-v${number}`;

export interface PartyPolicy {
  size: number;
  activePartySlotsPerPlayer: number;
  speciesDupClause: boolean;
}

export interface SpecialLimits {
  legendaryMythicalTotal: number;
  restrictedTotal: number;
}

export interface LevelPolicy {
  displayMode: LevelDisplayMode;
  effectiveFormulaKey: EffectiveFormulaKey;
  softCapStartsAt: number;
  effectiveLevelCap: number;
}

export interface BattlePolicy {
  format: BattleFormat;
  teamPreview: boolean;
  leadSelection: LeadSelectionMode;
  replacementSelection: ReplacementSelectionMode;
  actionTimeoutSeconds: number;
}

export interface CheatPolicy {
  requireCleanSave: boolean;
  allowCheatFlaggedSave: boolean;
  growthSnapshotRequired: boolean;
}

export interface RulesetSummary {
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  status: RulesetStatus;
  party: PartyPolicy;
  specialLimits: SpecialLimits;
  levelPolicy: LevelPolicy;
  battlePolicy: BattlePolicy;
  cheatPolicy: CheatPolicy;
  updatedAt: string;
}

export interface RulesetRepository {
  getActiveRulesetByGeneration(generation: PvpGeneration): RulesetSummary | undefined;
  getRestrictedSpeciesIdsByRulesetKey(rulesetKey: RulesetKey): readonly number[] | undefined;
}

export function isPvpGeneration(value: string): value is PvpGeneration {
  return (SUPPORTED_PVP_GENERATIONS as readonly string[]).includes(value);
}
