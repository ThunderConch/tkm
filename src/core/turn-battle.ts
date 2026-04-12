import { t } from '../i18n/index.js';
import { getTypeEffectiveness } from './type-chart.js';
import {
  applyStatChange,
  createStatStages,
  getAccEvaMultiplier,
  getStatMultiplier,
  resetStatStages,
} from './stat-stages.js';
import type {
  BaseStats,
  MoveData,
  BattleMove,
  BattlePokemon,
  BattleTeam,
  BattleState,
  TurnAction,
  TurnResult,
} from './types.js';
import {
  getParalysisSpeedMultiplier,
  getBurnAttackMultiplier,
  checkSleepSkip,
  checkFreezeSkip,
  checkParalysisSkip,
  applyEndOfTurnEffects,
  rollMoveEffect,
  tryApplyStatus,
} from './status-effects.js';
import {
  addVolatileStatus,
  applyLeechSeedEndOfTurn,
  clearVolatileStatuses,
  checkConfusionSkip,
  checkFlinchSkip,
} from './volatile-status.js';

// ── Stat Calculation ──

/** Simplified mainline HP formula (no IVs/EVs). */
export function calculateHp(baseHp: number, level: number): number {
  return Math.floor((2 * baseHp * level) / 100) + level + 10;
}

/** Simplified mainline stat formula (no IVs/EVs). */
export function calculateStat(baseStat: number, level: number): number {
  return Math.floor((2 * baseStat * level) / 100) + 5;
}

// ── BattlePokemon Factory ──

export interface CreateBattlePokemonInput {
  id: number;
  types: string[];
  level: number;
  baseStats: BaseStats;
  displayName?: string;
}

export function createBattlePokemon(
  input: CreateBattlePokemonInput,
  moves: MoveData[],
): BattlePokemon {
  const { id, types, level, baseStats } = input;
  const maxHp = calculateHp(baseStats.hp, level);

  const spAttackBase = baseStats.sp_attack ?? baseStats.attack;
  const spDefenseBase = baseStats.sp_defense ?? baseStats.defense;

  return {
    id,
    name: String(id),
    displayName: input.displayName ?? String(id),
    types,
    level,
    maxHp,
    currentHp: maxHp,
    attack: calculateStat(baseStats.attack, level),
    defense: calculateStat(baseStats.defense, level),
    spAttack: calculateStat(spAttackBase, level),
    spDefense: calculateStat(spDefenseBase, level),
    speed: calculateStat(baseStats.speed, level),
    moves: moves.map((m) => ({ data: m, currentPp: m.pp })),
    fainted: false,
    statusCondition: null,
    toxicCounter: 0,
    sleepCounter: 0,
    volatileStatuses: [],
    statStages: createStatStages(),
  };
}

// ── Damage Calculation ──

export function calculateDamage(
  attacker: BattlePokemon,
  defender: BattlePokemon,
  move: BattleMove,
): number {
  const power = move.data.power;
  if (!power || power <= 0) return 0;

  const isPhysical = move.data.category === 'physical';
  const attackStat = isPhysical ? attacker.attack : attacker.spAttack;
  const defenseStat = isPhysical ? defender.defense : defender.spDefense;
  const attackStage = isPhysical ? attacker.statStages.attack : attacker.statStages.spAttack;
  const defenseStage = isPhysical ? defender.statStages.defense : defender.statStages.spDefense;

  const effectiveAttack =
    attackStat *
    getStatMultiplier(attackStage) *
    (isPhysical ? getBurnAttackMultiplier(attacker) : 1);
  const effectiveDefense = defenseStat * getStatMultiplier(defenseStage);
  const atk = Math.floor(effectiveAttack);
  const def = Math.max(1, Math.floor(effectiveDefense));

  const base = Math.floor(
    ((2 * attacker.level / 5 + 2) * power * atk) / def / 50 + 2,
  );
  const stab = attacker.types.includes(move.data.type) ? 1.5 : 1.0;

  let typeEff = 1.0;
  for (const defType of defender.types) {
    typeEff *= getTypeEffectiveness(move.data.type, defType);
  }

  // Type immunity: 0 damage bypasses minimum damage floor
  if (typeEff === 0) return 0;

  const random = 0.85 + Math.random() * 0.15;
  return Math.max(1, Math.floor(base * stab * typeEff * random));
}

// ── Effectiveness Message ──

export function getEffectivenessMessage(
  moveType: string,
  defenderTypes: string[],
): string | null {
  let eff = 1.0;
  for (const defType of defenderTypes) {
    eff *= getTypeEffectiveness(moveType, defType);
  }
  if (eff === 0) return 'effect_immune';
  if (eff >= 2.0) return 'effect_super';
  if (eff > 0 && eff <= 0.5) return 'effect_not_very';
  return null;
}

// ── Accuracy Check ──

export function checkAccuracy(
  attacker: BattlePokemon,
  defender: BattlePokemon,
  move: MoveData,
): boolean {
  if (move.accuracy === null) return true;
  const hitChance =
    move.accuracy *
    getAccEvaMultiplier(attacker.statStages.accuracy) /
    getAccEvaMultiplier(defender.statStages.evasion);
  return Math.random() * 100 < hitChance;
}

// ── Battle State Factory ──

export function createBattleState(
  playerTeam: BattlePokemon[],
  opponentTeam: BattlePokemon[],
): BattleState {
  return {
    player: { pokemon: playerTeam, activeIndex: 0 },
    opponent: { pokemon: opponentTeam, activeIndex: 0 },
    turn: 0,
    log: [],
    phase: 'select_action',
    winner: null,
  };
}

// ── Helpers ──

export function getActivePokemon(team: BattleTeam): BattlePokemon {
  return team.pokemon[team.activeIndex];
}

export function hasAlivePokemon(team: BattleTeam): boolean {
  return team.pokemon.some((p) => !p.fainted);
}

// ── Turn Resolution ──

interface ActionEntry {
  side: 'player' | 'opponent';
  action: TurnAction;
  pokemon: BattlePokemon;
}

function applyMoveStatChanges(
  attacker: BattlePokemon,
  defender: BattlePokemon,
  move: MoveData,
  messages: string[],
  moveTypeImmuneToDefender: boolean,
): void {
  for (const change of move.statChanges ?? []) {
    // Type-immune moves cannot debuff their immune target. Self-buff
    // changes are unaffected (they always land on the attacker).
    if (change.target === 'opponent' && moveTypeImmuneToDefender) continue;
    if (Math.random() * 100 >= change.chance) continue;
    const target = change.target === 'self' ? attacker : defender;
    applyStatChange(target, change.stat, change.stages, messages);
  }
}

function executeSwitch(
  team: BattleTeam,
  targetIndex: number,
  messages: string[],
  opposingTeam?: BattleTeam,
  ownSide?: 'player' | 'opponent',
): boolean {
  // Reject invalid switch targets — including no-op same-slot switches.
  // A same-slot switch must not reach the reset path below, otherwise it would
  // act as a free, priority cleanse for stat stages without leaving the field.
  if (
    targetIndex < 0 ||
    targetIndex >= team.pokemon.length ||
    team.pokemon[targetIndex].fainted ||
    targetIndex === team.activeIndex
  ) {
    return false;
  }
  const old = getActivePokemon(team);
  const departingSlot = team.activeIndex;
  clearVolatileStatuses(old);

  // Clear leech-seed markers on the opposing team that were seeded by the
  // departing Pokemon so healing cannot redirect to the replacement.
  if (opposingTeam && ownSide) {
    for (const opp of opposingTeam.pokemon) {
      opp.volatileStatuses = opp.volatileStatuses.filter(
        (entry) =>
          !(
            entry.type === 'leech_seed' &&
            entry.sourceSide === ownSide &&
            entry.sourceSlot === departingSlot
          ),
      );
    }
  }

  team.activeIndex = targetIndex;
  // Reset toxic counter when switching out
  if (old.statusCondition === 'badly_poisoned') {
    old.toxicCounter = 1;
  }
  const active = getActivePokemon(team);
  active.toxicCounter = active.statusCondition === 'badly_poisoned' ? active.toxicCounter : 0;
  resetStatStages(active);
  messages.push(t('battle.switch', { name: active.displayName }));
  return true;
}

export function applyBattleSwitch(
  team: BattleTeam,
  targetIndex: number,
  messages: string[],
  opposingTeam?: BattleTeam,
  ownSide?: 'player' | 'opponent',
): boolean {
  return executeSwitch(team, targetIndex, messages, opposingTeam, ownSide);
}

const STRUGGLE_MOVE: BattleMove = {
  data: {
    id: 0,
    name: 'struggle',
    nameKo: '발버둥',
    nameEn: 'Struggle',
    type: 'typeless',
    category: 'physical',
    power: 50,
    accuracy: 100,
    pp: 1,
  },
  currentPp: 1,
};

function executeMove(
  attackerSide: 'player' | 'opponent',
  state: BattleState,
  moveIndex: number,
  messages: string[],
  attackerMovedFirst: boolean,
): { defenderFainted: boolean } {
  const attackerTeam = state[attackerSide];
  const defenderSide = attackerSide === 'player' ? 'opponent' : 'player';
  const defenderTeam = state[defenderSide];

  const attacker = getActivePokemon(attackerTeam);
  const defender = getActivePokemon(defenderTeam);

  // Skip if attacker already fainted
  if (attacker.fainted) return { defenderFainted: false };

  // Determine move (struggle if no PP) BEFORE paralysis check.
  // Struggle is mandatory — if the attacker has no usable PP we must run its
  // recoil path regardless of status. Only chosen (non-Struggle) moves can be
  // skipped by full paralysis, so the PP-decrement invariant holds.
  let move: BattleMove;
  let isStruggle = false;

  const hasUsableMoves = attacker.moves.some((m) => m.currentPp > 0);
  if (!hasUsableMoves) {
    move = STRUGGLE_MOVE;
    isStruggle = true;
    messages.push(`${attacker.displayName}은(는) 발버둥쳤다!`);
  } else if (moveIndex < 0 || moveIndex >= attacker.moves.length) {
    // Invalid moveIndex → treat as struggle
    move = STRUGGLE_MOVE;
    isStruggle = true;
    messages.push(`${attacker.displayName}은(는) 발버둥쳤다!`);
  } else {
    const chosen = attacker.moves[moveIndex];
    if (chosen.currentPp <= 0) {
      // Requested move has 0 PP → struggle
      move = STRUGGLE_MOVE;
      isStruggle = true;
      messages.push(`${attacker.displayName}은(는) 발버둥쳤다!`);
    } else {
      move = chosen;
      // Defer PP decrement + move announcement until after paralysis check so
      // that a fully paralyzed turn does not waste PP on the chosen move.
    }
  }

  if (checkFlinchSkip(attacker, messages)) {
    return { defenderFainted: false };
  }

  // Sleep and freeze are full incapacitation in mainline — they stop the turn
  // even when Struggle would otherwise be forced. Paralysis is only a partial
  // skip, so it keeps the Struggle bypass to preserve the no-PP invariant.
  if (checkSleepSkip(attacker, messages)) {
    return { defenderFainted: false };
  }

  if (checkFreezeSkip(attacker, move, messages)) {
    return { defenderFainted: false };
  }

  if (!isStruggle && checkParalysisSkip(attacker, messages)) {
    return { defenderFainted: false };
  }

  if (checkConfusionSkip(attacker, messages)) {
    return { defenderFainted: false };
  }

  // Announce and consume PP for the chosen move (Struggle was already
  // announced above and has no persistent PP).
  if (!isStruggle) {
    move.currentPp--;
    messages.push(`${attacker.displayName}의 ${move.data.nameKo}!`);
  }

  const moveEffect = move.data.moveEffect;
  if (move.data.power === 0 && moveEffect?.type === 'heal') {
    if (attacker.currentHp === attacker.maxHp) {
      messages.push(t('move.heal.fail', { name: attacker.displayName }));
      return { defenderFainted: false };
    }

    const healAmount = Math.floor(attacker.maxHp * moveEffect.fraction);
    attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + healAmount);
    messages.push(t('move.heal.success', { name: attacker.displayName }));
    return { defenderFainted: false };
  }

  if (move.data.power === 0 && moveEffect?.type === 'rest') {
    if (attacker.currentHp === attacker.maxHp && attacker.statusCondition === null) {
      messages.push(t('move.heal.fail', { name: attacker.displayName }));
      return { defenderFainted: false };
    }

    attacker.currentHp = attacker.maxHp;
    attacker.toxicCounter = 0;
    attacker.statusCondition = 'sleep';
    attacker.sleepCounter = 2;
    messages.push(t('status.sleep.inflicted', { name: attacker.displayName }));
    messages.push(t('move.rest.success', { name: attacker.displayName }));
    return { defenderFainted: false };
  }

  // Move-type effectiveness — computed BEFORE accuracy so type-immune debuff
  // moves report immunity instead of missing (e.g., Screech vs Ghost). The
  // mainline order resolves immunity before the accuracy roll.
  const effMsg = getEffectivenessMessage(move.data.type, defender.types);
  const moveTypeImmune = effMsg === 'effect_immune';

  // Early-return: a type-immune zero-power stat-change move with NO self-buff
  // component (e.g., growl/screech/tail-whip into Ghost) cannot land at all.
  // Skip the accuracy gate so the user-visible log says "no effect" instead
  // of "miss". Moves that also include self-buff changes still need to run
  // through applyMoveStatChanges, which gates opponent changes per-target.
  const allChanges = move.data.statChanges ?? [];
  const hasOpponentChange = allChanges.some((c) => c.target === 'opponent');
  const hasSelfChange = allChanges.some((c) => c.target === 'self');
  if (
    moveTypeImmune &&
    move.data.power === 0 &&
    hasOpponentChange &&
    !hasSelfChange
  ) {
    messages.push('효과가 없는 듯하다...');
    return { defenderFainted: false };
  }

  // Accuracy check
  if (!checkAccuracy(attacker, defender, move.data)) {
    messages.push(t('battle.miss', { name: attacker.displayName }));
    return { defenderFainted: false };
  }

  // Fire-type thaw: only damaging fire hits thaw the defender. A non-damaging
  // fire status move (e.g. will-o-wisp) must not thaw a frozen target, or it
  // would then apply a new burn status in the same action.
  if (
    defender.statusCondition === 'freeze' &&
    move.data.type === 'fire' &&
    move.data.power > 0 &&
    !moveTypeImmune
  ) {
    defender.statusCondition = null;
    messages.push(t('status.freeze.thawed', { name: defender.displayName }));
  }

  const defenderHpBefore = defender.currentHp;
  const damage = calculateDamage(attacker, defender, move);
  defender.currentHp = Math.max(0, defender.currentHp - damage);
  const damageDealt = defenderHpBefore - defender.currentHp;

  // Struggle recoil: 1/4 max HP
  if (isStruggle) {
    const recoil = Math.max(1, Math.floor(attacker.maxHp / 4));
    attacker.currentHp = Math.max(0, attacker.currentHp - recoil);
    if (attacker.currentHp <= 0) {
      attacker.fainted = true;
    }
  }

  // Effectiveness messages
  if (effMsg === 'effect_super') messages.push('효과가 굉장했다!');
  else if (effMsg === 'effect_not_very') messages.push('효과가 별로인 듯하다...');
  else if (effMsg === 'effect_immune') messages.push('효과가 없는 듯하다...');

  if (damageDealt > 0 && moveEffect?.type === 'recoil') {
    const recoil = Math.max(1, Math.floor(damageDealt * moveEffect.fraction));
    attacker.currentHp = Math.max(0, attacker.currentHp - recoil);
    if (attacker.currentHp <= 0) {
      attacker.fainted = true;
    }
    messages.push(t('move.recoil', { name: attacker.displayName }));
  }

  if (damageDealt > 0 && moveEffect?.type === 'drain') {
    const heal = Math.max(1, Math.floor(damageDealt * moveEffect.fraction));
    attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + heal);
    messages.push(t('move.drain', { name: attacker.displayName }));
  }

  // Faint check
  if (defender.currentHp <= 0) {
    defender.fainted = true;
    messages.push(`${defender.displayName}은(는) 쓰러졌다!`);
    return { defenderFainted: true };
  }

  if (move.data.power > 0 && damage > 0 && !defender.fainted) {
    applyMoveStatChanges(attacker, defender, move.data, messages, moveTypeImmune);
  }

  if (move.data.power === 0) {
    applyMoveStatChanges(attacker, defender, move.data, messages, moveTypeImmune);
  }

  if (!defender.fainted && move.data.volatileEffect && !moveTypeImmune) {
    const { type, chance } = move.data.volatileEffect;
    const shouldApply =
      Math.random() * 100 < chance &&
      (type !== 'flinch' || attackerMovedFirst);
    if (shouldApply) {
      addVolatileStatus(
        defender,
        {
          type,
          ...(type === 'leech_seed'
            ? { sourceSide: attackerSide, sourceSlot: attackerTeam.activeIndex }
            : {}),
        },
        messages,
      );
    }
  }

  // Roll secondary effect — blocked if the move type has no effect on the defender
  // (e.g., Thunder Wave vs Ground-type should not paralyze).
  if (!defender.fainted && move.data.effect && !moveTypeImmune) {
    rollMoveEffect(move.data, defender, messages);
  }

  return { defenderFainted: false };
}

export function resolveTurn(
  state: BattleState,
  playerAction: TurnAction,
  opponentAction: TurnAction,
): TurnResult {
  const messages: string[] = [];
  let playerFainted = false;
  let opponentFainted = false;

  state.turn++;

  // Handle surrender
  if (playerAction.type === 'surrender') {
    messages.push('항복했다...');
    state.phase = 'battle_end';
    state.winner = 'opponent';
    return { messages, playerFainted: false, opponentFainted: false };
  }
  if (opponentAction.type === 'surrender') {
    messages.push('항복했다...');
    state.phase = 'battle_end';
    state.winner = 'player';
    return { messages, playerFainted: false, opponentFainted: false };
  }

  // Build action entries
  const entries: ActionEntry[] = [
    { side: 'player', action: playerAction, pokemon: getActivePokemon(state.player) },
    { side: 'opponent', action: opponentAction, pokemon: getActivePokemon(state.opponent) },
  ];

  // Determine order: switches before moves, then speed, then random tiebreak
  entries.sort((a, b) => {
    const aPriority = a.action.type === 'switch' ? 0 : 1;
    const bPriority = b.action.type === 'switch' ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Same priority → speed
    const aSpeed = Math.floor(
      a.pokemon.speed *
      getStatMultiplier(a.pokemon.statStages.speed) *
      getParalysisSpeedMultiplier(a.pokemon),
    );
    const bSpeed = Math.floor(
      b.pokemon.speed *
      getStatMultiplier(b.pokemon.statStages.speed) *
      getParalysisSpeedMultiplier(b.pokemon),
    );
    if (aSpeed !== bSpeed) return bSpeed - aSpeed;
    // Random tiebreak
    return Math.random() < 0.5 ? -1 : 1;
  });

  // Execute actions in order
  for (const [actionIndex, entry] of entries.entries()) {
    if (entry.action.type === 'switch') {
      const opposingSide = entry.side === 'player' ? 'opponent' : 'player';
      executeSwitch(
        state[entry.side],
        entry.action.pokemonIndex,
        messages,
        state[opposingSide],
        entry.side,
      );
    } else if (entry.action.type === 'move') {
      const result = executeMove(
        entry.side,
        state,
        entry.action.moveIndex,
        messages,
        actionIndex === 0,
      );
      if (entry.side === 'player' && result.defenderFainted) {
        opponentFainted = true;
      } else if (entry.side === 'opponent' && result.defenderFainted) {
        playerFainted = true;
      }
    }
  }

  // Check attacker faint from struggle recoil
  const playerActive = getActivePokemon(state.player);
  const opponentActive = getActivePokemon(state.opponent);
  if (playerActive.fainted) playerFainted = true;
  if (opponentActive.fainted) opponentFainted = true;

  // ── End-of-turn status effects ──
  // Skip post-turn damage once the battle is already decided — applying burn/poison
  // ticks after either side has no remaining Pokemon would mutate state past the
  // natural end of the match and could flip the winner.
  const battleOverAfterActions = !hasAlivePokemon(state.player) || !hasAlivePokemon(state.opponent);
  if (!battleOverAfterActions) {
    const statusMessages: string[] = [];
    if (!playerActive.fainted) {
      if (applyLeechSeedEndOfTurn(playerActive, state, statusMessages)) {
        playerFainted = true;
      }
    }
    if (!opponentActive.fainted) {
      if (applyLeechSeedEndOfTurn(opponentActive, state, statusMessages)) {
        opponentFainted = true;
      }
    }
    if (!playerActive.fainted) {
      if (applyEndOfTurnEffects(playerActive, statusMessages)) {
        playerFainted = true;
      }
    }
    if (!opponentActive.fainted) {
      if (applyEndOfTurnEffects(opponentActive, statusMessages)) {
        opponentFainted = true;
      }
    }
    messages.push(...statusMessages);
  }

  // Win/loss conditions
  const playerAlive = hasAlivePokemon(state.player);
  const opponentAlive = hasAlivePokemon(state.opponent);

  if (!playerAlive && !opponentAlive) {
    // Simultaneous double KO (e.g., both last mons faint to end-of-turn
    // burn/poison in the same turn). Mainline Pokemon gives this to the
    // opponent — the player "loses" because their last Pokemon did not
    // survive. We follow the same convention so post-turn trades cannot
    // flip into a false player victory.
    state.phase = 'battle_end';
    state.winner = 'opponent';
  } else if (!opponentAlive) {
    state.phase = 'battle_end';
    state.winner = 'player';
  } else if (!playerAlive) {
    state.phase = 'battle_end';
    state.winner = 'opponent';
  } else if (playerFainted) {
    // Player's active fainted but has more → fainted_switch
    state.phase = 'fainted_switch';
  } else if (opponentFainted) {
    // Opponent fainted but has more → stay select_action (AI switches externally)
    state.phase = 'select_action';
  } else {
    state.phase = 'select_action';
  }

  return { messages, playerFainted, opponentFainted };
}
