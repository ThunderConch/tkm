# Battle System Specification

> 전투 시스템 기술 명세: 승률 공식, EV, 타입 상성, 파티 멀티플라이어

관련 문서: [@PRD-concept.md](PRD-concept.md) | [@spec-progression.md](spec-progression.md)

소스: `src/core/battle.ts`, `src/core/type-chart.ts`, `src/core/items.ts`

## 1. Win Rate Formula

### 1.1 Overview

```
rawWinRate = typeMultiplier × levelFactor × statFactor × evFactor
winRate = clamp(0.03, 0.95, rawWinRate)
```

4개의 독립 팩터가 곱셈으로 결합된다. 최종 승률은 항상 3%~95% 범위.

### 1.2 Type Multiplier

```typescript
// Step 1: Raw type matchup (dual-type stacking)
rawType = Π(effectiveness[atkType][defType]) for all attacker/defender type pairs

// 1.5x = super effective
// 1.0x = neutral
// 0.67x = not effective
// 0.25x = immune

// Step 2: Dampening (compress extreme dual-type stacking)
typeMultiplier = 1 + (rawType - 1) × 0.4
```

**Dampening 예시:**

| 상황 | rawType | 감쇠 후 |
|------|---------|---------|
| 중립 | 1.00 | 1.00 |
| 단일 유리 | 1.50 | 1.20 |
| 이중 유리 | 2.25 | 1.50 |
| 극단 유리 (Fire/Fighting vs Grass/Steel) | 5.06 | 2.62 |
| 단일 불리 | 0.67 | 0.87 |
| 면역 | 0.25 | 0.70 |

감쇠는 극단적 타입 상성이 전투를 일방적으로 결정하는 것을 방지한다.

### 1.3 Level Factor

```typescript
levelDiff = attackerLevel - defenderLevel
avgLevel = (attackerLevel + defenderLevel) / 2
levelFactor = sigmoid(levelDiff / (2 + avgLevel × 0.1))

// sigmoid(x) = 1 / (1 + exp(-x))
```

**특성:**
- 저레벨: 급경사 (Lv.1 vs Lv.5 ≈ 15%)
- 고레벨: 완만 (Lv.51 vs Lv.55 ≈ 37%)
- 동레벨: 항상 0.5 (50%)

**레벨 차이별 승률 (중립 타입, 동일 스탯):**

| 공격자 | 방어자 | levelFactor | 대략 승률 |
|--------|--------|-------------|----------|
| 1 | 5 | 0.15 | ~15% |
| 5 | 10 | 0.22 | ~22% |
| 10 | 10 | 0.50 | ~50% |
| 20 | 10 | 0.88 | ~88% |
| 40 | 20 | 0.83 | ~83% |
| 50 | 55 | 0.37 | ~37% |

### 1.4 Stat Factor

```typescript
statRatio = (attacker.attack + attacker.speed) / max(1, defender.defense + defender.speed)
statFactor = clamp(0.5, 1.5, statRatio)
```

- 공격 측: attack + speed (공세 지표)
- 방어 측: defense + speed (방어 지표)
- 범위: 0.5x ~ 1.5x
- 동일 스탯: 1.0x

### 1.5 EV Factor

```typescript
evFactor = 1.0 + (attackerEv / 252) × 0.252
```

| EV | evFactor |
|----|----------|
| 0 | 1.000x |
| 50 | 1.050x |
| 100 | 1.100x |
| 126 | 1.126x |
| 200 | 1.200x |
| 252 | 1.252x |

**설계 의도:**
- 단일 값 (스탯별 분리 아님)
- 전투 승리로만 획득 (+1/승리, 파티 전원)
- 상한 252 (원작 동일)
- 최대 25.2% 보정 — 타입/레벨보다 작은 영향력
- `evFactor = 1 + (ev/252) * 0.252`는 ev=252일 때 정확히 1.252

## 2. Party Multiplier

### 2.1 개요

파티 멀티플라이어는 다인 파티의 전투력 보너스를 계산한다.

```typescript
const PARTY_GEO_RATIO = 0.337;

// 각 파티원의 전투력 점수 계산
for each member in party:
  score = relativeCombatPower(member vs wild)

// 점수 내림차순 정렬
scores.sort(descending)

// 기하급수 가중치 합산
multiplier = Σ (score[i] / bestScore) × PARTY_GEO_RATIO^i

// 범위 제한
multiplier = clamp(1.0, 1.5, multiplier)
```

### 2.2 기하급수 가중치

```
1위: × 1.000   (r^0)
2위: × 0.337   (r^1)
3위: × 0.114   (r^2)
4위: × 0.038   (r^3)
5위: × 0.013   (r^4)
6위: × 0.004   (r^5)
```

6인 동일 전력 파티: `1 + 0.337 + 0.114 + 0.038 + 0.013 + 0.004 ≈ 1.506 → 1.5`

### 2.3 Best Fighter Selection

`selectBattlePokemon()`은 파티 중 야생 포켓몬에 대해 가장 높은 전투력 점수를 가진 포켓몬을 선택한다. 전투력 점수는 `relativeCombatPower()`로 계산되며, `calculateWinRate()`와 동일한 3요소(타입/레벨/스탯)를 사용한다.

## 3. Battle XP Reward

```typescript
base = 50
levelBonus = wildLevel × 3
typeBonus = typeDisadvantage ? 20 : 0
rarityBonus = { common: 0, uncommon: 30, rare: 80, legendary: 200, mythical: 500 }

totalXp = (base + levelBonus + typeBonus + rarityBonus) × xpBonusMultiplier
```

- 승리 시에만 XP 지급
- 파티 전원 동일 XP 수령 (분배 아님)
- 타입 불리 보너스: 불리한 상성으로 이기면 +20

## 4. Item Drop

```typescript
if (won) dropChance = 0.20;   // 승리 시 20%
else     dropChance = 0.05;   // 패배 시 5%

if (Math.random() < dropChance) addItem(state, 'pokeball', 1);
```

## 5. Poké Ball Catch-Gating

```typescript
// 승리 + 미포획 + 몬스터볼 보유 → 포획 (볼 1개 소비)
// 승리 + 미포획 + 볼 미보유 → 포획 불가 (도감 seen + XP만)
// 승리 + 이미 포획 → 볼 소비 없음
if (won && !alreadyCaught && getItemCount(state, 'pokeball') > 0) {
  useItem(state, 'pokeball');
  markCaught(state, wildName);
}
```

## 6. Battle Result

```typescript
interface BattleResult {
  won: boolean;
  winRate: number;
  xpReward: number;
  wildPokemon: string;
  wildLevel: number;
  attacker: string;
  typeMultiplier: number;
  partyMultiplier: number;
  caught: boolean;
  itemDrop: string | null;
}
```

## 7. Edge Cases

| 상황 | 처리 |
|------|------|
| 파티가 비어있음 | 전투 발생하지 않음 (resolveBattle → null) |
| 야생 포켓몬이 DB에 없음 | resolveBattle → null |
| EV가 undefined (구버전 세이브) | `?? 0` 폴백, 마이그레이션으로 0 설정 |
| 동일 포켓몬 재포획 | 무시 (이미 state.pokemon에 있으면 스킵) |
| 극단적 레벨 차이 (Lv.1 vs Lv.100) | sigmoid 감쇠 + clamp [0.03, 0.95] |
