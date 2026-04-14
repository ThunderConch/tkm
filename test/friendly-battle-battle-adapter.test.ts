import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initLocale } from '../src/i18n/index.js';
import { createStatStages } from '../src/core/stat-stages.js';
import type { BattlePokemon, MoveData } from '../src/core/types.js';
import {
  createFriendlyBattleBattleRuntime,
  submitFriendlyBattleChoice,
  toFriendlyBattleBattleRef,
} from '../src/friendly-battle/battle-adapter.js';

initLocale('ko');

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

/**
 * Strip the `liveState` field that battle-adapter now embeds into every
 * choices_requested event so the existing structural assertions in this
 * file stay focused on the wire-shape contract. The liveState payload is
 * exercised separately via daemon integration tests.
 */
const EVENTS_WITH_LIVE_STATE = new Set([
  'battle_initialized',
  'choices_requested',
  'turn_resolved',
]);

function stripLiveState<T extends { type?: string }>(events: T[]): T[] {
  return events.map((event) => {
    if (event && event.type && EVENTS_WITH_LIVE_STATE.has(event.type) && 'liveState' in event) {
      const { liveState: _liveState, ...rest } = event as Record<string, unknown>;
      return rest as unknown as T;
    }
    return event;
  });
}

function stripLiveStateFromEvent<T extends { type?: string }>(event: T): T {
  return stripLiveState([event])[0];
}

describe('friendly battle battle adapter', () => {
  it('creates a transport-independent runtime with initial battle events and cloned teams', () => {
    const hostTeam = [makeBattlePokemon({ displayName: 'Hostmon' })];
    const guestTeam = [makeBattlePokemon({ displayName: 'Guestmon' })];

    const { runtime, events } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam,
      guestTeam,
      startedAt: '2026-04-12T12:00:00.000Z',
    });

    assert.deepEqual(stripLiveState(events), [
      { type: 'battle_initialized', battleId: 'battle-1', turn: 0 },
      {
        type: 'choices_requested',
        turn: 1,
        waitingFor: ['host', 'guest'],
        phase: 'waiting_for_choices',
      },
    ]);

    runtime.state.player.pokemon[0].currentHp = 1;

    assert.equal(hostTeam[0].currentHp, 120);
    assert.notEqual(runtime.state.player.pokemon[0], hostTeam[0]);
    assert.deepEqual(toFriendlyBattleBattleRef(runtime), {
      layer: 'battle',
      battleId: 'battle-1',
      turn: 0,
      phase: 'waiting_for_choices',
      startedAt: '2026-04-12T12:00:00.000Z',
      endedAt: null,
    });
  });

  it('waits for the second side before resolving a turn', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'Hostmon' })],
      guestTeam: [makeBattlePokemon({ displayName: 'Guestmon' })],
    });

    const events = submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.deepEqual(events, []);
    assert.equal(runtime.pendingChoices.host?.choice.type, 'move');
    assert.equal(runtime.pendingChoices.guest, undefined);
    assert.equal(runtime.phase, 'waiting_for_choices');
  });

  it('resolves a full turn and requests the next pair of choices', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'Hostmon', speed: 90 })],
      guestTeam: [makeBattlePokemon({ displayName: 'Guestmon', speed: 40 })],
    });

    submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    const events = submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:02.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.equal(runtime.state.turn, 1);
    assert.equal(runtime.phase, 'waiting_for_choices');
    assert.deepEqual(stripLiveStateFromEvent(events[0]!), {
      type: 'turn_resolved',
      turn: 1,
      messages: events[0]?.type === 'turn_resolved' ? events[0].messages : [],
      waitingFor: ['host', 'guest'],
      nextPhase: 'waiting_for_choices',
      winner: null,
    });
    assert.ok(events[0]?.type === 'turn_resolved' && events[0].messages.length >= 2);
    assert.deepEqual(stripLiveStateFromEvent(events[1]!), {
      type: 'choices_requested',
      turn: 2,
      waitingFor: ['host', 'guest'],
      phase: 'waiting_for_choices',
    });
  });

  it('emits completion events when one side surrenders', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'Hostmon' })],
      guestTeam: [makeBattlePokemon({ displayName: 'Guestmon' })],
    });

    submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'surrender' },
    });

    const events = submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:02.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.equal(runtime.phase, 'completed');
    assert.equal(runtime.endedAt, '2026-04-12T12:00:02.000Z');
    assert.deepEqual(stripLiveState(events), [
      {
        type: 'turn_resolved',
        turn: 1,
        messages: ['항복했다...'],
        waitingFor: [],
        nextPhase: 'completed',
        winner: 'guest',
      },
      {
        type: 'battle_finished',
        winner: 'guest',
        reason: 'surrender',
      },
    ]);
  });

  it('handles fainted-switch flow without incrementing the battle turn twice', () => {
    const hostStrike = makeMoveData({ power: 200 });
    const guestPoke = makeBattlePokemon({
      displayName: 'GuestLead',
      currentHp: 20,
      maxHp: 20,
      defense: 10,
      spDefense: 10,
      speed: 30,
    });
    const guestBench = makeBattlePokemon({ displayName: 'GuestBench', id: 2, name: '2' });

    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'HostLead', speed: 100, moves: [{ data: hostStrike, currentPp: 35 }] })],
      guestTeam: [guestPoke, guestBench],
    });

    submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    const resolveEvents = submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:02.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.equal(runtime.state.turn, 1);
    assert.equal(runtime.phase, 'awaiting_fainted_switch');
    assert.deepEqual(stripLiveStateFromEvent(resolveEvents[0]!), {
      type: 'turn_resolved',
      turn: 1,
      messages: resolveEvents[0]?.type === 'turn_resolved' ? resolveEvents[0].messages : [],
      waitingFor: ['guest'],
      nextPhase: 'awaiting_fainted_switch',
      winner: null,
    });
    assert.ok(resolveEvents[0]?.type === 'turn_resolved' && resolveEvents[0].messages.some((message) => message.includes('쓰러졌다')));
    assert.deepEqual(stripLiveStateFromEvent(resolveEvents[1]!), {
      type: 'choices_requested',
      turn: 1,
      waitingFor: ['guest'],
      phase: 'awaiting_fainted_switch',
    });

    const switchEvents = submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:03.000Z',
      choice: { type: 'switch', pokemonIndex: 1 },
    });

    assert.equal(runtime.state.turn, 1);
    assert.equal(runtime.state.opponent.activeIndex, 1);
    assert.equal(runtime.phase, 'waiting_for_choices');
    assert.deepEqual(stripLiveState(switchEvents), [
      {
        type: 'turn_resolved',
        turn: 1,
        messages: ['GuestBench(으)로 교체!'],
        waitingFor: ['host', 'guest'],
        nextPhase: 'waiting_for_choices',
        winner: null,
      },
      {
        type: 'choices_requested',
        turn: 2,
        waitingFor: ['host', 'guest'],
        phase: 'waiting_for_choices',
      },
    ]);
  });

  it('rejects move submissions while a fainted switch is pending', () => {
    const hostStrike = makeMoveData({ power: 200 });
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'HostLead', speed: 100, moves: [{ data: hostStrike, currentPp: 35 }] })],
      guestTeam: [
        makeBattlePokemon({ displayName: 'GuestLead', currentHp: 20, maxHp: 20, defense: 10, spDefense: 10, speed: 30 }),
        makeBattlePokemon({ displayName: 'GuestBench', id: 2, name: '2' }),
      ],
    });

    submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });
    submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:02.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.throws(
      () =>
        submitFriendlyBattleChoice(runtime, {
          actor: 'guest',
          submittedAt: '2026-04-12T12:00:03.000Z',
          choice: { type: 'move', moveIndex: 0 },
        }),
      /switch/i,
    );
  });

  it('rejects invalid move choices during a normal turn instead of silently struggling', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [makeBattlePokemon({ displayName: 'HostLead' })],
      guestTeam: [makeBattlePokemon({ displayName: 'GuestLead' })],
    });

    assert.throws(
      () =>
        submitFriendlyBattleChoice(runtime, {
          actor: 'host',
          submittedAt: '2026-04-12T12:00:01.000Z',
          choice: { type: 'move', moveIndex: 99 },
        }),
      /invalid move/i,
    );
  });

  it('rejects invalid switch choices during a normal turn instead of silently consuming the turn', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [
        makeBattlePokemon({ displayName: 'HostLead' }),
        makeBattlePokemon({ displayName: 'HostBench', id: 2, name: '2' }),
      ],
      guestTeam: [makeBattlePokemon({ displayName: 'GuestLead' })],
    });

    assert.throws(
      () =>
        submitFriendlyBattleChoice(runtime, {
          actor: 'host',
          submittedAt: '2026-04-12T12:00:01.000Z',
          choice: { type: 'switch', pokemonIndex: 0 },
        }),
      /invalid switch/i,
    );
  });

  it('allows a zero-PP move selection to resolve through mandatory struggle', () => {
    const { runtime } = createFriendlyBattleBattleRuntime({
      battleId: 'battle-1',
      hostTeam: [
        makeBattlePokemon({
          displayName: 'HostLead',
          moves: [{ data: makeMoveData(), currentPp: 0 }],
        }),
      ],
      guestTeam: [makeBattlePokemon({ displayName: 'GuestLead' })],
    });

    submitFriendlyBattleChoice(runtime, {
      actor: 'host',
      submittedAt: '2026-04-12T12:00:01.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    const events = submitFriendlyBattleChoice(runtime, {
      actor: 'guest',
      submittedAt: '2026-04-12T12:00:02.000Z',
      choice: { type: 'move', moveIndex: 0 },
    });

    assert.ok(events[0]?.type === 'turn_resolved');
    assert.ok(events[0].messages.some((message) => message.includes('발버둥쳤다')));
  });
});
