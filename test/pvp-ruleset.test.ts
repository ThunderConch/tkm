import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeEffectiveLevel,
  getRulesetByGeneration,
  isRestrictedSpecies,
} from '../src/server/rules/index.js';

test('gen4 ruleset 조회 성공', () => {
  const ruleset = getRulesetByGeneration('gen4');

  assert.equal(ruleset.generation, 'gen4');
  assert.equal(ruleset.rulesetKey, 'tkm-friendly-gen4-v1');
  assert.deepEqual(ruleset.specialLimits, {
    legendaryMythicalTotal: 2,
    restrictedTotal: 1,
  });
  assert.deepEqual(ruleset.battlePolicy, {
    format: 'single',
    teamPreview: false,
    leadSelection: 'slot1_auto',
    replacementSelection: 'manual',
    actionTimeoutSeconds: 45,
  });
  assert.deepEqual(ruleset.levelPolicy, {
    displayMode: 'actual-level-visible',
    effectiveFormulaKey: 'soft-cap-after-50-v1',
    softCapStartsAt: 50,
    effectiveLevelCap: 60,
  });
});

test('미지원 generation 조회 실패', () => {
  assert.throws(() => getRulesetByGeneration('gen10'), /Unsupported PvP generation: gen10/);
});

test('restricted species 포함 여부 판정 성공', () => {
  assert.equal(isRestrictedSpecies('gen4', 483), true);
  assert.equal(isRestrictedSpecies('gen4', 480), false);
});

test('soft-cap-after-50-v1 effective level 계산이 고정된다', () => {
  assert.equal(computeEffectiveLevel(1), 1);
  assert.equal(computeEffectiveLevel(50), 50);
  assert.equal(computeEffectiveLevel(51), 51);
  assert.equal(computeEffectiveLevel(60), 52);
  assert.equal(computeEffectiveLevel(72), 55);
  assert.equal(computeEffectiveLevel(100), 60);
});

test('어떤 실제 레벨도 effective level 60을 초과하지 않는다', () => {
  for (let actualLevel = 1; actualLevel <= 200; actualLevel += 1) {
    assert.ok(computeEffectiveLevel(actualLevel) <= 60, `level ${actualLevel} exceeded cap`);
  }
});
