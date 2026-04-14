import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStatStages } from '../src/core/stat-stages.js';
import type { BattlePokemon, BattleState, MoveData } from '../src/core/types.js';
import { accumulateFogState, deriveFogState } from '../src/friendly-battle/fog.js';
import type { FriendlyBattleBattleEvent } from '../src/friendly-battle/contracts.js';

function makeMoveData(overrides: Partial<MoveData> = {}): MoveData {
  return {
    id: 1,
    name: 'tackle',
    nameKo: '몸통박치기',
    nameEn: 'Tackle',
    type: 'normal',
    category: 'physical',
    power: 40,
    accuracy: 100,
    pp: 35,
    ...overrides,
  };
}

function makeBattlePokemon(overrides: Partial<BattlePokemon> = {}): BattlePokemon {
  return {
    id: 1,
    name: '1',
    displayName: 'Pokemon',
    types: ['normal'],
    level: 50,
    maxHp: 120,
    currentHp: 120,
    attack: 65,
    defense: 55,
    spAttack: 65,
    spDefense: 55,
    speed: 70,
    moves: [{ data: makeMoveData(), currentPp: 35 }],
    fainted: false,
    statusCondition: null,
    toxicCounter: 0,
    sleepCounter: 0,
    volatileStatuses: [],
    statStages: createStatStages(),
    ...overrides,
  };
}

function makeState(input: { host: BattlePokemon[]; guest: BattlePokemon[] }): BattleState {
  return {
    player: {
      pokemon: input.host,
      activeIndex: 0,
      hazards: { spikes: 0, stealthRock: false },
      screens: { reflect: 0, lightScreen: 0 },
    },
    opponent: {
      pokemon: input.guest,
      activeIndex: 0,
      hazards: { spikes: 0, stealthRock: false },
      screens: { reflect: 0, lightScreen: 0 },
    },
    turn: 1,
    weather: null,
    terrain: null,
    trickRoomTurns: 0,
    status: 'active',
    phase: 'select_action',
    winner: null,
  };
}

describe('friendly-battle fog state', () => {
  it('derives opponent active species, level, and hp percent for host', () => {
    const state = makeState({
      host: [makeBattlePokemon({ displayName: 'Host' })],
      guest: [makeBattlePokemon({ displayName: 'Gengar', level: 52, currentHp: 63, maxHp: 120 })],
    });

    const fog = deriveFogState(state, 'host');
    assert.deepEqual(fog.opponentActive.species, 'Gengar');
    assert.equal(fog.opponentActive.level, 52);
    assert.equal(fog.opponentActive.hpPercent, 53);
  });

  it('buckets hp percent as a rounded integer', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ currentHp: 1, maxHp: 3 })],
    });

    assert.equal(deriveFogState(state, 'host').opponentActive.hpPercent, 33);
  });

  it('surfaces visible status when present', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ statusCondition: 'burned' })],
    });

    assert.equal(deriveFogState(state, 'host').opponentActive.visibleStatus, 'burned');
  });

  it('starts with no revealed moves and hidden bench slots', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [
        makeBattlePokemon({ displayName: 'Lead' }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Bench 1' }),
        makeBattlePokemon({ id: 3, name: '3', displayName: 'Bench 2' }),
      ],
    });

    const fog = deriveFogState(state, 'host');
    assert.deepEqual(fog.opponentActive.revealedMoves, []);
    assert.deepEqual(fog.opponentBenchRevealed, []);
    assert.equal(fog.opponentBenchHidden, 2);
  });

  it('reflects the guest view when role is guest', () => {
    const state = makeState({
      host: [makeBattlePokemon({ displayName: 'Dialga' })],
      guest: [makeBattlePokemon({ displayName: 'Palkia' })],
    });

    assert.equal(deriveFogState(state, 'guest').opponentActive.species, 'Dialga');
  });

  it('accumulates revealed moves from turn messages', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ displayName: 'Gengar' })],
    });
    const previous = deriveFogState(state, 'host');
    const event: FriendlyBattleBattleEvent = {
      type: 'turn_resolved',
      turn: 1,
      messages: ['Gengar used Shadow Ball!', 'It was super effective!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    };

    const fog = accumulateFogState(previous, state, 'host', event);
    assert.deepEqual(fog.opponentActive.revealedMoves, ['Shadow Ball']);
  });

  it('deduplicates revealed moves across multiple turns', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ displayName: 'Gengar' })],
    });
    const base = deriveFogState(state, 'host');
    const once = accumulateFogState(base, state, 'host', {
      type: 'turn_resolved',
      turn: 1,
      messages: ['Gengar used Shadow Ball!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });
    const twice = accumulateFogState(once, state, 'host', {
      type: 'turn_resolved',
      turn: 2,
      messages: ['Gengar used Shadow Ball!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    assert.deepEqual(twice.opponentActive.revealedMoves, ['Shadow Ball']);
  });

  it('reveals a switched-in bench pokemon from turn messages', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [
        makeBattlePokemon({ displayName: 'Lead' }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Raichu', level: 44, currentHp: 50, maxHp: 80 }),
      ],
    });
    const base = deriveFogState(state, 'host');

    const fog = accumulateFogState(base, state, 'host', {
      type: 'turn_resolved',
      turn: 1,
      messages: ['Opponent sent out Raichu!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    assert.deepEqual(fog.opponentBenchRevealed, [{ species: 'Raichu', level: 44, hpPercent: 63 }]);
    assert.equal(fog.opponentBenchHidden, 0);
  });

  it('does not reveal the active species as bench history', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ displayName: 'Lead' })],
    });
    const base = deriveFogState(state, 'host');

    const fog = accumulateFogState(base, state, 'host', {
      type: 'turn_resolved',
      turn: 1,
      messages: ['Opponent sent out Lead!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    assert.deepEqual(fog.opponentBenchRevealed, []);
    assert.equal(fog.opponentBenchHidden, 0);
  });

  it('ignores unrelated messages during accumulation', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [makeBattlePokemon({ displayName: 'Lead' })],
    });
    const base = deriveFogState(state, 'host');

    const fog = accumulateFogState(base, state, 'host', {
      type: 'turn_resolved',
      turn: 1,
      messages: ['A critical hit!', 'Lead fainted!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    assert.deepEqual(fog, base);
  });

  it('preserves previously revealed bench entries while active pokemon changes', () => {
    const state = makeState({
      host: [makeBattlePokemon()],
      guest: [
        makeBattlePokemon({ displayName: 'Lead' }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Raichu', level: 44, currentHp: 50, maxHp: 80 }),
        makeBattlePokemon({ id: 3, name: '3', displayName: 'Snorlax', level: 46, currentHp: 120, maxHp: 160 }),
      ],
    });
    const base = deriveFogState(state, 'host');
    const afterFirstReveal = accumulateFogState(base, state, 'host', {
      type: 'turn_resolved',
      turn: 1,
      messages: ['Opponent sent out Raichu!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    const afterSecondReveal = accumulateFogState(afterFirstReveal, state, 'host', {
      type: 'turn_resolved',
      turn: 2,
      messages: ['Opponent sent out Snorlax!'],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });

    assert.deepEqual(afterSecondReveal.opponentBenchRevealed, [
      { species: 'Raichu', level: 44, hpPercent: 63 },
      { species: 'Snorlax', level: 46, hpPercent: 75 },
    ]);
    assert.equal(afterSecondReveal.opponentBenchHidden, 0);
  });
});
