import type { LevelPolicy } from './ruleset-types.js';

export const DEFAULT_LEVEL_POLICY: LevelPolicy = {
  displayMode: 'actual-level-visible',
  effectiveFormulaKey: 'soft-cap-after-50-v1',
  softCapStartsAt: 50,
  effectiveLevelCap: 60,
};

function normalizeActualLevel(actualLevel: number): number {
  if (!Number.isFinite(actualLevel) || !Number.isInteger(actualLevel) || actualLevel < 1) {
    throw new Error(`Actual level must be a positive integer: ${actualLevel}`);
  }

  return actualLevel;
}

export function softCapAfter50V1(
  actualLevel: number,
  softCapStartsAt = DEFAULT_LEVEL_POLICY.softCapStartsAt,
  effectiveLevelCap = DEFAULT_LEVEL_POLICY.effectiveLevelCap,
): number {
  const normalizedLevel = normalizeActualLevel(actualLevel);

  if (normalizedLevel <= softCapStartsAt) {
    return Math.min(normalizedLevel, effectiveLevelCap);
  }

  const compressedLevel = softCapStartsAt + Math.ceil((normalizedLevel - softCapStartsAt) / 5);
  return Math.min(compressedLevel, effectiveLevelCap);
}

export function computeEffectiveLevel(
  actualLevel: number,
  levelPolicy: LevelPolicy = DEFAULT_LEVEL_POLICY,
): number {
  switch (levelPolicy.effectiveFormulaKey) {
    case 'soft-cap-after-50-v1':
      return softCapAfter50V1(actualLevel, levelPolicy.softCapStartsAt, levelPolicy.effectiveLevelCap);
    default: {
      const exhaustiveCheck: never = levelPolicy.effectiveFormulaKey;
      throw new Error(`Unsupported effective level formula: ${exhaustiveCheck}`);
    }
  }
}
