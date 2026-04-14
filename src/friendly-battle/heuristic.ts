import { calculateDamage } from '../core/turn-battle.js';
import { getTypeEffectiveness } from '../core/type-chart.js';
import type { BattlePokemon, BattleState } from '../core/types.js';
import type { FriendlyBattleRole } from './contracts.js';
import type { DaemonAction } from './daemon-protocol.js';

function teamForRole(state: BattleState, role: FriendlyBattleRole): BattleState['player'] {
  return role === 'host' ? state.player : state.opponent;
}

function oppTeamForRole(state: BattleState, role: FriendlyBattleRole): BattleState['player'] {
  return role === 'host' ? state.opponent : state.player;
}

function countAlive(team: BattleState['player']): number {
  let n = 0;
  for (const p of team.pokemon) if (!p.fainted) n++;
  return n;
}

interface MoveScore {
  index: number;
  damage: number;
}

function bestMoveFor(attacker: BattlePokemon, defender: BattlePokemon): MoveScore | null {
  let best: MoveScore | null = null;
  for (let i = 0; i < attacker.moves.length; i++) {
    const move = attacker.moves[i];
    if (move.currentPp <= 0) continue;
    if (!move.data.power || move.data.power <= 0) continue;
    const damage = calculateDamage(attacker, defender, move);
    if (best === null || damage > best.damage) {
      best = { index: i, damage };
    }
  }
  return best;
}

function hasSuperEffectiveMove(attacker: BattlePokemon, defender: BattlePokemon): boolean {
  for (const move of attacker.moves) {
    if (move.currentPp <= 0) continue;
    if (!move.data.power || move.data.power <= 0) continue;
    let eff = 1;
    for (const defType of defender.types) {
      eff *= getTypeEffectiveness(move.data.type, defType);
    }
    if (eff >= 2) return true;
  }
  return false;
}

function bestBenchSwitch(
  team: BattleState['player'],
  oppActive: BattlePokemon,
): { pokemonIndex: number; damage: number } | null {
  // Weight each bench candidate's raw damage by its HP ratio so we never
  // willingly switch INTO a near-dead pokemon just because its stats give
  // higher nominal damage. A 20% HP bench mon is effectively useless on
  // the switch-in turn because it can be one-shot by the opponent's next
  // move — scaling by hp ratio captures that without inventing a new
  // survivability dimension. Tests that use full-HP bench mons (all the
  // PR48 unit tests) are unaffected because the ratio is 1.0.
  let best: { pokemonIndex: number; damage: number } | null = null;
  for (let i = 0; i < team.pokemon.length; i++) {
    if (i === team.activeIndex) continue;
    const bench = team.pokemon[i];
    if (bench.fainted) continue;
    const score = bestMoveFor(bench, oppActive);
    if (!score) continue;
    const hpRatio = bench.maxHp > 0 ? bench.currentHp / bench.maxHp : 0;
    const effective = score.damage * hpRatio;
    if (best === null || effective > best.damage) {
      best = { pokemonIndex: i, damage: effective };
    }
  }
  return best;
}

export function pickHeuristicAction(state: BattleState, role: FriendlyBattleRole): DaemonAction {
  const my = teamForRole(state, role);
  const opp = oppTeamForRole(state, role);
  const myActive = my.pokemon[my.activeIndex];
  const oppActive = opp.pokemon[opp.activeIndex];

  if (!myActive || !oppActive) {
    return { kind: 'move', index: 0 };
  }

  // Forced switch: if the active pokemon is already fainted, the battle
  // adapter is in awaiting_fainted_switch phase and will reject ANY move
  // choice. We MUST return a switch action. Pick the best non-fainted
  // bench member by effective damage (HP-weighted). If somehow no bench
  // is available (shouldn't happen — battle would have ended) fall
  // through to the legacy path so the caller at least gets a valid shape.
  if (myActive.fainted) {
    const forcedSwitch = bestBenchSwitch(my, oppActive);
    if (forcedSwitch) {
      return { kind: 'switch', pokemonIndex: forcedSwitch.pokemonIndex };
    }
    return { kind: 'move', index: 0 };
  }

  const myAliveCount = countAlive(my);
  const oppAliveCount = countAlive(opp);
  const hpPct = (myActive.currentHp / myActive.maxHp) * 100;

  if (
    myAliveCount === 1 &&
    !myActive.fainted &&
    hpPct < 10 &&
    oppAliveCount >= 3 &&
    !hasSuperEffectiveMove(myActive, oppActive)
  ) {
    return { kind: 'surrender' };
  }

  const myBest = bestMoveFor(myActive, oppActive);

  if (hpPct < 20) {
    const bench = bestBenchSwitch(my, oppActive);
    if (bench && (myBest === null || bench.damage > myBest.damage)) {
      return { kind: 'switch', pokemonIndex: bench.pokemonIndex };
    }
  }

  const oppBest = bestMoveFor(oppActive, myActive);
  if (myBest && oppBest && oppBest.damage > myBest.damage * 2) {
    const bench = bestBenchSwitch(my, oppActive);
    if (bench && bench.damage >= myBest.damage * 1.5) {
      return { kind: 'switch', pokemonIndex: bench.pokemonIndex };
    }
  }

  if (myBest) {
    return { kind: 'move', index: myBest.index };
  }
  return { kind: 'move', index: 0 };
}
