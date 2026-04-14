import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStatStages } from '../src/core/stat-stages.js';
import type { BattlePokemon, BattleState, MoveData } from '../src/core/types.js';
import { pickHeuristicAction } from '../src/friendly-battle/heuristic.js';

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

function makeState(input: {
  host: BattlePokemon[];
  guest: BattlePokemon[];
  hostActiveIndex?: number;
  guestActiveIndex?: number;
}): BattleState {
  return {
    player: {
      pokemon: input.host,
      activeIndex: input.hostActiveIndex ?? 0,
      hazards: { spikes: 0, stealthRock: false },
      screens: { reflect: 0, lightScreen: 0 },
    },
    opponent: {
      pokemon: input.guest,
      activeIndex: input.guestActiveIndex ?? 0,
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

function withFixedRandom<T>(value: number, fn: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('friendly-battle heuristic picker', () => {
  it('surrenders when last mon is under 10 percent, opponent has three alive, and no super-effective move exists', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          currentHp: 9,
          maxHp: 100,
          moves: [{ data: makeMoveData({ type: 'normal', power: 40 }), currentPp: 35 }],
        }),
      ],
      guest: [
        makeBattlePokemon({ types: ['steel'], displayName: 'Opp 1' }),
        makeBattlePokemon({ displayName: 'Opp 2', id: 2, name: '2' }),
        makeBattlePokemon({ displayName: 'Opp 3', id: 3, name: '3' }),
      ],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'surrender' });
  });

  it('does not surrender at exactly 10 percent hp', () => {
    const state = makeState({
      host: [makeBattlePokemon({ currentHp: 10, maxHp: 100 })],
      guest: [
        makeBattlePokemon({ displayName: 'Opp 1' }),
        makeBattlePokemon({ displayName: 'Opp 2', id: 2, name: '2' }),
        makeBattlePokemon({ displayName: 'Opp 3', id: 3, name: '3' }),
      ],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'surrender' });
  });

  it('does not surrender if a super-effective move is available', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          currentHp: 5,
          maxHp: 100,
          moves: [{ data: makeMoveData({ type: 'water', power: 40 }), currentPp: 35 }],
        }),
      ],
      guest: [
        makeBattlePokemon({ types: ['rock'], displayName: 'Opp 1' }),
        makeBattlePokemon({ displayName: 'Opp 2', id: 2, name: '2' }),
        makeBattlePokemon({ displayName: 'Opp 3', id: 3, name: '3' }),
      ],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'surrender' });
  });

  it('does not surrender if opponent has fewer than three alive', () => {
    const fainted = makeBattlePokemon({ fainted: true, currentHp: 0 });
    const state = makeState({
      host: [makeBattlePokemon({ currentHp: 5, maxHp: 100 })],
      guest: [makeBattlePokemon(), fainted, fainted],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'surrender' });
  });

  it('switches on hp-emergency when a bench mon has a stronger move profile', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          currentHp: 19,
          maxHp: 100,
          moves: [{ data: makeMoveData({ type: 'normal', power: 30 }), currentPp: 35 }],
        }),
        makeBattlePokemon({
          id: 2,
          name: '2',
          displayName: 'Bench Ace',
          types: ['electric'],
          spAttack: 120,
          moves: [{ data: makeMoveData({ type: 'electric', category: 'special', power: 90 }), currentPp: 35 }],
        }),
      ],
      guest: [makeBattlePokemon({ types: ['water'], displayName: 'Water Opp' })],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'switch', pokemonIndex: 1 });
  });

  it('does not hp-emergency switch when no better bench exists', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          currentHp: 15,
          maxHp: 100,
          types: ['electric'],
          spAttack: 110,
          moves: [{ data: makeMoveData({ type: 'electric', category: 'special', power: 90 }), currentPp: 35 }],
        }),
        makeBattlePokemon({
          id: 2,
          name: '2',
          displayName: 'Bench Worse',
          moves: [{ data: makeMoveData({ type: 'normal', power: 35 }), currentPp: 35 }],
        }),
      ],
      guest: [makeBattlePokemon({ types: ['water'] })],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'switch', pokemonIndex: 1 });
  });

  it('does not hp-emergency switch with no bench', () => {
    const state = makeState({
      host: [makeBattlePokemon({ currentHp: 15, maxHp: 100 })],
      guest: [makeBattlePokemon()],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 0 });
  });

  it('does not hp-emergency switch at exactly 20 percent hp', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({ currentHp: 20, maxHp: 100 }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Bench' }),
      ],
      guest: [makeBattlePokemon()],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'switch', pokemonIndex: 1 });
  });

  it('switches on type disadvantage when opponent threatens double the damage and bench is 1.5x better', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [{ data: makeMoveData({ type: 'grass', category: 'special', power: 40 }), currentPp: 35 }],
          spAttack: 60,
        }),
        makeBattlePokemon({
          id: 2,
          name: '2',
          displayName: 'Bench Fire',
          types: ['fire'],
          spAttack: 120,
          moves: [{ data: makeMoveData({ type: 'fire', category: 'special', power: 90 }), currentPp: 35 }],
        }),
      ],
      guest: [
        makeBattlePokemon({
          types: ['grass'],
          attack: 120,
          moves: [{ data: makeMoveData({ type: 'fire', power: 90 }), currentPp: 35 }],
        }),
      ],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'switch', pokemonIndex: 1 });
  });

  it('does not type-disadvantage switch when bench improvement is below 1.5x', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [{ data: makeMoveData({ type: 'grass', category: 'special', power: 60 }), currentPp: 35 }],
          spAttack: 70,
        }),
        makeBattlePokemon({
          id: 2,
          name: '2',
          displayName: 'Bench Slightly Better',
          moves: [{ data: makeMoveData({ type: 'grass', category: 'special', power: 70 }), currentPp: 35 }],
          spAttack: 75,
        }),
      ],
      guest: [
        makeBattlePokemon({
          attack: 120,
          moves: [{ data: makeMoveData({ type: 'fire', power: 90 }), currentPp: 35 }],
        }),
      ],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'switch', pokemonIndex: 1 });
  });

  it('picks the highest expected damage move by default', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [
            { data: makeMoveData({ type: 'normal', power: 40 }), currentPp: 35 },
            { data: makeMoveData({ id: 2, name: 'thunderbolt', type: 'electric', category: 'special', power: 90 }), currentPp: 15 },
          ],
          spAttack: 110,
        }),
      ],
      guest: [makeBattlePokemon({ types: ['water'] })],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 1 });
  });

  it('ignores zero-pp moves when usable alternatives exist', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [
            { data: makeMoveData({ type: 'electric', category: 'special', power: 120 }), currentPp: 0 },
            { data: makeMoveData({ id: 2, name: 'swift', type: 'normal', power: 60 }), currentPp: 20 },
          ],
          spAttack: 110,
        }),
      ],
      guest: [makeBattlePokemon({ types: ['water'] })],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 1 });
  });

  it('falls through to move index 0 when all pp is exhausted so engine can struggle', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [
            { data: makeMoveData({ id: 1 }), currentPp: 0 },
            { data: makeMoveData({ id: 2, name: 'swift' }), currentPp: 0 },
          ],
        }),
      ],
      guest: [makeBattlePokemon()],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 0 });
  });

  it('returns a valid move index within range', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [
            { data: makeMoveData({ id: 1 }), currentPp: 10 },
            { data: makeMoveData({ id: 2, name: 'swift' }), currentPp: 10 },
            { data: makeMoveData({ id: 3, name: 'bite' }), currentPp: 10 },
          ],
        }),
      ],
      guest: [makeBattlePokemon()],
    });

    const action = withFixedRandom(0.5, () => pickHeuristicAction(state, 'host'));
    assert.equal(action.kind, 'move');
    assert.ok(action.index >= 0 && action.index < 3);
  });

  it('uses the guest side when role is guest', () => {
    const state = makeState({
      host: [makeBattlePokemon({ types: ['water'] })],
      guest: [
        makeBattlePokemon({
          types: ['electric'],
          spAttack: 120,
          moves: [{ data: makeMoveData({ type: 'electric', category: 'special', power: 90 }), currentPp: 35 }],
        }),
      ],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'guest')), { kind: 'move', index: 0 });
  });

  it('does not switch to the active slot', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({ currentHp: 15, maxHp: 100 }),
        makeBattlePokemon({ id: 2, name: '2', fainted: true, currentHp: 0 }),
      ],
      guest: [makeBattlePokemon()],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 0 });
  });

  it('handles all-types-resisted cases by still choosing the best available move', () => {
    // Both moves are resisted 0.25x against dragon/fire (grass vs dragon 0.5 * grass vs fire 0.5;
    // fire vs dragon 0.5 * fire vs fire 0.5). Same type multiplier, so raw power wins → fire (index 1).
    const state = makeState({
      host: [
        makeBattlePokemon({
          moves: [
            { data: makeMoveData({ type: 'grass', category: 'special', power: 40 }), currentPp: 35 },
            { data: makeMoveData({ id: 2, type: 'fire', category: 'special', power: 60 }), currentPp: 35 },
          ],
          spAttack: 90,
        }),
      ],
      guest: [makeBattlePokemon({ types: ['dragon', 'fire'] })],
    });

    assert.deepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'move', index: 1 });
  });

  it('returns a switch action when the active pokemon is already fainted (forced switch)', () => {
    // Regression: PR48 visual QA found that host-side heuristic on guest's
    // forced switch was returning a move action (because HP%=0 < 20 hit the
    // emergency-switch branch but bench damage was less than the fainted
    // mon's theoretical damage), which the battle-adapter rejected with
    // "Friendly battle is waiting for a switch choice", aborting the battle.
    // pickHeuristicAction must short-circuit on fainted active and always
    // return a switch.
    const state = makeState({
      host: [
        makeBattlePokemon({ fainted: true, currentHp: 0, maxHp: 316, displayName: 'Fainted Ace', spAttack: 140 }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Bench Survivor', currentHp: 226, maxHp: 270 }),
      ],
      guest: [makeBattlePokemon({ displayName: 'Opp' })],
    });

    const action = withFixedRandom(0.5, () => pickHeuristicAction(state, 'host'));
    assert.equal(action.kind, 'switch');
    if (action.kind === 'switch') {
      assert.equal(action.pokemonIndex, 1);
    }
  });

  it('skips near-dead bench mons when evaluating hp-emergency switch', () => {
    // Regression: PR48 visual QA found the daemon switching from a healthy
    // active into a 21 HP bench mon (near-death Dialga) because bestBenchSwitch
    // picked the highest raw-damage bench regardless of HP. bestBenchSwitch
    // now weights damage by HP ratio, so a 21/316 bench (~7%) contributes
    // only 7% of its damage as effective score and loses to a full-HP bench.
    const state = makeState({
      host: [
        // Active is healthy but grass vs grass — low damage vs opp
        makeBattlePokemon({
          currentHp: 19,
          maxHp: 100,
          moves: [{ data: makeMoveData({ type: 'grass', category: 'special', power: 40 }), currentPp: 35 }],
          spAttack: 60,
        }),
        // Near-dead but high raw damage
        makeBattlePokemon({
          id: 2,
          name: '2',
          displayName: 'Dying Ace',
          currentHp: 21,
          maxHp: 316,
          types: ['dragon'],
          spAttack: 140,
          moves: [{ data: makeMoveData({ type: 'dragon', category: 'special', power: 90 }), currentPp: 10 }],
        }),
        // Healthy with decent damage
        makeBattlePokemon({
          id: 3,
          name: '3',
          displayName: 'Healthy Bench',
          currentHp: 226,
          maxHp: 270,
          types: ['ground'],
          attack: 110,
          moves: [{ data: makeMoveData({ type: 'ground', category: 'physical', power: 90 }), currentPp: 10 }],
        }),
      ],
      guest: [makeBattlePokemon({ types: ['water'], displayName: 'Water Opp' })],
    });

    const action = withFixedRandom(0.5, () => pickHeuristicAction(state, 'host'));
    // Must NOT pick the dying ace (index 1)
    assert.notDeepEqual(action, { kind: 'switch', pokemonIndex: 1 });
  });

  it('does not surrender when more than one allied pokemon remains alive', () => {
    const state = makeState({
      host: [
        makeBattlePokemon({ currentHp: 5, maxHp: 100 }),
        makeBattlePokemon({ id: 2, name: '2', displayName: 'Bench Alive' }),
      ],
      guest: [
        makeBattlePokemon(),
        makeBattlePokemon({ id: 2, name: '2' }),
        makeBattlePokemon({ id: 3, name: '3' }),
      ],
    });

    assert.notDeepEqual(withFixedRandom(0.5, () => pickHeuristicAction(state, 'host')), { kind: 'surrender' });
  });
});
