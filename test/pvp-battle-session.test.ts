import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { initLocale } from '../src/i18n/index.js';
import type { MoveData, PokemonData } from '../src/core/types.js';
import type { ActivePartySnapshot } from '../src/server/parties/index.js';
import type { BattleRoomRecord } from '../src/server/rooms/index.js';
import type { RulesetSummary } from '../src/server/rules/index.js';
import {
  BattleSessionService,
  type BattleCommandEnvelope,
  type BattleDataResolver,
  type BattleServerEventEnvelope,
  type BattleSessionRecord,
} from '../src/server/battle/index.js';

initLocale('ko');

const RULESET: RulesetSummary = {
  generation: 'gen4',
  rulesetKey: 'tkm-friendly-gen4-v1',
  status: 'active',
  party: {
    size: 6,
    activePartySlotsPerPlayer: 1,
    speciesDupClause: true,
  },
  specialLimits: {
    legendaryMythicalTotal: 2,
    restrictedTotal: 1,
  },
  levelPolicy: {
    displayMode: 'actual-level-visible',
    effectiveFormulaKey: 'soft-cap-after-50-v1',
    softCapStartsAt: 50,
    effectiveLevelCap: 60,
  },
  battlePolicy: {
    format: 'single',
    teamPreview: false,
    leadSelection: 'slot1_auto',
    replacementSelection: 'manual',
    actionTimeoutSeconds: 45,
  },
  cheatPolicy: {
    requireCleanSave: true,
    allowCheatFlaggedSave: false,
    growthSnapshotRequired: true,
  },
  updatedAt: '2026-04-11T07:00:00.000Z',
};

const SPECIES_DATA: Record<string, PokemonData> = {
  '001': {
    id: 1,
    name: 'Bulbasaur',
    types: ['grass'],
    stage: 1,
    line: ['Bulbasaur'],
    evolves_at: 16,
    unlock: 'starter',
    exp_group: 'medium_slow',
    rarity: 'common',
    region: 'kanto',
    base_stats: { hp: 80, attack: 85, defense: 80, speed: 90, sp_attack: 95, sp_defense: 85 },
    catch_rate: 45,
  },
  '004': {
    id: 4,
    name: 'Charmander',
    types: ['fire'],
    stage: 1,
    line: ['Charmander'],
    evolves_at: 16,
    unlock: 'starter',
    exp_group: 'medium_slow',
    rarity: 'common',
    region: 'kanto',
    base_stats: { hp: 78, attack: 84, defense: 72, speed: 88, sp_attack: 100, sp_defense: 78 },
    catch_rate: 45,
  },
  '007': {
    id: 7,
    name: 'Squirtle',
    types: ['water'],
    stage: 1,
    line: ['Squirtle'],
    evolves_at: 16,
    unlock: 'starter',
    exp_group: 'medium_slow',
    rarity: 'common',
    region: 'kanto',
    base_stats: { hp: 79, attack: 83, defense: 100, speed: 60, sp_attack: 85, sp_defense: 105 },
    catch_rate: 45,
  },
  '025': {
    id: 25,
    name: 'Pikachu',
    types: ['electric'],
    stage: 1,
    line: ['Pikachu'],
    evolves_at: null,
    unlock: 'starter',
    exp_group: 'medium_fast',
    rarity: 'common',
    region: 'kanto',
    base_stats: { hp: 70, attack: 60, defense: 55, speed: 110, sp_attack: 70, sp_defense: 60 },
    catch_rate: 190,
  },
};

const MOVE_DATA: Record<string, MoveData> = {
  'host-fast': {
    id: 101,
    name: 'host-fast',
    nameKo: '호스트 속공',
    nameEn: 'Host Fast',
    type: 'normal',
    category: 'physical',
    power: 55,
    accuracy: 100,
    pp: 20,
  },
  'host-ko': {
    id: 102,
    name: 'host-ko',
    nameKo: '호스트 일격',
    nameEn: 'Host KO',
    type: 'normal',
    category: 'physical',
    power: 300,
    accuracy: 100,
    pp: 5,
  },
  'host-chip': {
    id: 103,
    name: 'host-chip',
    nameKo: '호스트 견제',
    nameEn: 'Host Chip',
    type: 'grass',
    category: 'special',
    power: 35,
    accuracy: 100,
    pp: 25,
  },
  'host-guard': {
    id: 104,
    name: 'host-guard',
    nameKo: '호스트 가드',
    nameEn: 'Host Guard',
    type: 'normal',
    category: 'status',
    power: 0,
    accuracy: null,
    pp: 20,
  },
  'guest-fast': {
    id: 201,
    name: 'guest-fast',
    nameKo: '게스트 속공',
    nameEn: 'Guest Fast',
    type: 'normal',
    category: 'physical',
    power: 50,
    accuracy: 100,
    pp: 20,
  },
  'guest-chip': {
    id: 202,
    name: 'guest-chip',
    nameKo: '게스트 견제',
    nameEn: 'Guest Chip',
    type: 'fire',
    category: 'special',
    power: 30,
    accuracy: 100,
    pp: 25,
  },
  'guest-guard': {
    id: 203,
    name: 'guest-guard',
    nameKo: '게스트 가드',
    nameEn: 'Guest Guard',
    type: 'normal',
    category: 'status',
    power: 0,
    accuracy: null,
    pp: 20,
  },
  'guest-finisher': {
    id: 204,
    name: 'guest-finisher',
    nameKo: '게스트 마무리',
    nameEn: 'Guest Finisher',
    type: 'water',
    category: 'special',
    power: 85,
    accuracy: 100,
    pp: 10,
  },
};

const RESOLVER: BattleDataResolver = {
  resolveSpecies(_generation, speciesId) {
    return SPECIES_DATA[speciesId];
  },
  resolveMove(_generation, moveId) {
    return MOVE_DATA[moveId];
  },
};

function makeParty(playerId: string, members: Array<{ slot: number; speciesId: string; levelActual: number; levelEffective?: number; moves: string[] }>): ActivePartySnapshot {
  return {
    snapshotId: `party_${playerId}`,
    snapshotVersion: 1,
    playerId,
    generation: 'gen4',
    rulesetKey: 'tkm-friendly-gen4-v1',
    status: 'active',
    isActive: true,
    registeredAt: '2026-04-11T07:00:00.000Z',
    sourceStateHash: `sha256:${playerId}:state`,
    sourceConfigHash: `sha256:${playerId}:config`,
    clientBuild: 'tokenmon-cli/0.120.0',
    validationStatus: 'accepted',
    proofVersion: 'v1',
    capturedAt: '2026-04-11T07:00:00.000Z',
    sourceSaveId: `save_${playerId}`,
    sourceSaveRevision: 1,
    partySummary: {
      memberCount: members.length,
      legendaryMythicalCount: 0,
      restrictedCount: 0,
      speciesDupClause: true,
    },
    members: members.map((member) => ({
      slot: member.slot,
      pokemonInstanceId: `${playerId}-pkm-${member.slot}`,
      speciesId: member.speciesId,
      nickname: `${playerId}-${member.slot}`,
      levelActual: member.levelActual,
      levelEffective: member.levelEffective ?? Math.min(member.levelActual, 60),
      specialClass: {
        legendary: false,
        mythical: false,
        restricted: false,
      },
      moves: member.moves,
    })),
    growthProof: {
      proofVersion: 'v1',
      capturedAt: '2026-04-11T07:00:00.000Z',
      sourceSaveId: `save_${playerId}`,
      sourceSaveRevision: 1,
      cheatFlags: {
        hasCheatHistory: false,
        flags: [],
      },
      memberProofs: members.map((member) => ({
        slot: member.slot,
        pokemonInstanceId: `${playerId}-pkm-${member.slot}`,
        speciesId: member.speciesId,
        levelActual: member.levelActual,
        movesHash: `sha256:${playerId}:moves:${member.slot}`,
        stateHash: `sha256:${playerId}:state:${member.slot}`,
      })),
    },
  };
}

function makeRoom(): BattleRoomRecord {
  return {
    room: {
      roomId: 'room_test_01',
      roomCode: 'A7KQ2M',
      mode: 'friendly_private',
      visibility: 'private_friend',
      status: 'awaiting_presence',
      generation: 'gen4',
      rulesetKey: 'tkm-friendly-gen4-v1',
      createdByUserId: 'host-user',
      createdAt: '2026-04-11T07:00:00.000Z',
      expiresAt: null,
      startedAt: '2026-04-11T07:01:00.000Z',
      finishedAt: null,
      cancelledAt: null,
    },
    host: {
      seat: 'host',
      userId: 'host-user',
      partySnapshotId: 'party_host-user',
      partySnapshotVersion: 1,
      partyValidationStatus: 'accepted',
      presence: 'connected',
      joinedAt: '2026-04-11T07:00:30.000Z',
      battleReady: true,
    },
    guest: {
      seat: 'guest',
      userId: 'guest-user',
      partySnapshotId: 'party_guest-user',
      partySnapshotVersion: 1,
      partyValidationStatus: 'accepted',
      presence: 'connected',
      joinedAt: '2026-04-11T07:00:40.000Z',
      battleReady: true,
    },
    rulesetSnapshot: RULESET,
    battleFreeze: {
      freezeStatus: 'pending_presence',
      preparedAt: '2026-04-11T07:00:50.000Z',
      generation: 'gen4',
      rulesetKey: 'tkm-friendly-gen4-v1',
      rulesetHash: 'sha256:test',
      rulesetSnapshot: RULESET,
      hostPartySnapshotId: 'party_host-user',
      hostPartySnapshotVersion: 1,
      guestPartySnapshotId: 'party_guest-user',
      guestPartySnapshotVersion: 1,
      battleSeed: 'battle-seed-1',
    },
  };
}

function createService() {
  let tick = 0;
  return new BattleSessionService({
    dataResolver: RESOLVER,
    battleIdGenerator: () => 'battle_test_01',
    now: () => new Date(Date.UTC(2026, 3, 11, 7, 1, tick++)),
  });
}

function findEvent<TType extends BattleServerEventEnvelope['type']>(
  events: BattleServerEventEnvelope[],
  type: TType,
): Extract<BattleServerEventEnvelope, { type: TType }> {
  const event = events.find((entry) => entry.type === type);
  assert.ok(event, `expected ${type} event`);
  return event as Extract<BattleServerEventEnvelope, { type: TType }>;
}

function command(
  turn: number,
  phase: BattleSessionRecord['phase'],
  clientCommandId: string,
  inner: BattleCommandEnvelope['payload']['command'],
): BattleCommandEnvelope {
  return {
    type: 'battle.command',
    roomId: 'room_test_01',
    battleId: 'battle_test_01',
    seq: 1,
    sentAt: '2026-04-11T07:02:00.000Z',
    payload: {
      clientCommandId,
      turn,
      phase,
      command: inner,
    },
  };
}

describe('BattleSessionService', () => {
  let originalRandom: typeof Math.random;

  beforeEach(() => {
    originalRandom = Math.random;
    Math.random = () => 0;
  });

  it('배틀 시작 snapshot에서 viewer별 공개 정보와 액션 요청을 분리한다', () => {
    const service = createService();
    const hostParty = makeParty('host-user', [
      { slot: 1, speciesId: '001', levelActual: 63, moves: ['host-fast', 'host-ko', 'host-chip', 'host-guard'] },
      { slot: 2, speciesId: '025', levelActual: 55, moves: ['host-fast', 'host-chip', 'host-guard', 'host-fast'] },
    ]);
    const guestParty = makeParty('guest-user', [
      { slot: 1, speciesId: '004', levelActual: 61, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
      { slot: 2, speciesId: '007', levelActual: 54, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
    ]);

    const created = service.createSession({ room: makeRoom(), hostParty, guestParty });

    assert.equal(created.session.phase, 'awaiting_actions');
    assert.equal(created.session.turn, 1);

    const hostSnapshot = findEvent(created.eventsBySeat.host, 'room.snapshot');
    const guestSnapshot = findEvent(created.eventsBySeat.guest, 'room.snapshot');

    assert.equal(hostSnapshot.payload.visibleState.self.active.slot, 1);
    assert.equal(hostSnapshot.payload.visibleState.self.active.moves.length, 4);
    assert.equal(hostSnapshot.payload.visibleState.opponent.active.speciesId, '004');
    assert.equal(hostSnapshot.payload.visibleState.opponent.benchCount, 1);
    assert.equal('bench' in hostSnapshot.payload.visibleState.opponent, false);
    assert.equal('moves' in hostSnapshot.payload.visibleState.opponent.active, false);

    assert.equal(guestSnapshot.payload.visibleState.self.active.speciesId, '004');
    assert.equal(guestSnapshot.payload.visibleState.opponent.active.speciesId, '001');
    assert.equal(guestSnapshot.payload.pendingRequest?.kind, 'choose_move_or_switch');

    const hostRequest = findEvent(created.eventsBySeat.host, 'battle.request_action');
    assert.equal(hostRequest.payload.phase, 'awaiting_actions');
    assert.equal(hostRequest.payload.request.availableSwitches.length, 1);

    Math.random = originalRandom;
  });

  it('양측 일반 턴 명령을 수집하고 resolve한 뒤 다음 액션 요청을 만든다', () => {
    const service = createService();
    const created = service.createSession({
      room: makeRoom(),
      hostParty: makeParty('host-user', [
        { slot: 1, speciesId: '001', levelActual: 60, moves: ['host-fast', 'host-chip', 'host-guard', 'host-ko'] },
        { slot: 2, speciesId: '025', levelActual: 58, moves: ['host-fast', 'host-chip', 'host-guard', 'host-fast'] },
      ]),
      guestParty: makeParty('guest-user', [
        { slot: 1, speciesId: '004', levelActual: 60, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
        { slot: 2, speciesId: '007', levelActual: 58, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
      ]),
    });

    let session = created.session;

    const first = service.submitCommand({
      session,
      seat: 'host',
      envelope: command(1, 'awaiting_actions', 'cmd-host-switch', { type: 'choose_switch', targetSlot: 2 }),
    });
    session = first.session;
    const accepted = findEvent(first.eventsBySeat.host, 'battle.command_accepted');
    assert.equal(accepted.payload.lockedIn, true);
    assert.equal(first.eventsBySeat.guest.some((event) => event.type === 'battle.turn_resolved'), false);

    const second = service.submitCommand({
      session,
      seat: 'guest',
      envelope: command(1, 'awaiting_actions', 'cmd-guest-move', { type: 'choose_move', moveSlot: 1 }),
    });
    session = second.session;

    const hostResolved = findEvent(second.eventsBySeat.host, 'battle.turn_resolved');
    assert.equal(hostResolved.payload.turn, 1);
    assert.equal(hostResolved.payload.nextPhase, 'awaiting_actions');
    assert.equal(hostResolved.payload.postTurnVisibleState.self.active.slot, 2);
    assert.ok(hostResolved.payload.events.some((event) => event.eventType === 'switch_used'));

    const nextRequest = findEvent(second.eventsBySeat.host, 'battle.request_action');
    assert.equal(nextRequest.payload.turn, 2);
    assert.equal(session.turn, 2);
    assert.equal(session.phase, 'awaiting_actions');

    Math.random = originalRandom;
  });

  it('기절 시 replacement phase로 전환하고 대상 플레이어만 교체를 고르게 한다', () => {
    const service = createService();
    const created = service.createSession({
      room: makeRoom(),
      hostParty: makeParty('host-user', [
        { slot: 1, speciesId: '001', levelActual: 60, moves: ['host-ko', 'host-fast', 'host-chip', 'host-guard'] },
        { slot: 2, speciesId: '025', levelActual: 59, moves: ['host-fast', 'host-chip', 'host-guard', 'host-fast'] },
      ]),
      guestParty: makeParty('guest-user', [
        { slot: 1, speciesId: '004', levelActual: 50, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
        { slot: 2, speciesId: '007', levelActual: 58, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
      ]),
    });

    let session = service.submitCommand({
      session: created.session,
      seat: 'host',
      envelope: command(1, 'awaiting_actions', 'cmd-host-ko', { type: 'choose_move', moveSlot: 1 }),
    }).session;

    const resolved = service.submitCommand({
      session,
      seat: 'guest',
      envelope: command(1, 'awaiting_actions', 'cmd-guest-fast', { type: 'choose_move', moveSlot: 1 }),
    });
    session = resolved.session;

    const hostTurnResolved = findEvent(resolved.eventsBySeat.host, 'battle.turn_resolved');
    assert.equal(hostTurnResolved.payload.nextPhase, 'awaiting_replacement');
    const guestReplacement = findEvent(resolved.eventsBySeat.guest, 'battle.force_replacement');
    assert.equal(guestReplacement.payload.availableReplacements.length, 1);
    assert.equal(resolved.eventsBySeat.host.some((event) => event.type === 'battle.force_replacement'), false);
    assert.equal(session.phase, 'awaiting_replacement');

    const rejected = service.submitCommand({
      session,
      seat: 'host',
      envelope: command(1, 'awaiting_replacement', 'cmd-host-illegal', { type: 'choose_move', moveSlot: 1 }),
    });
    const hostRejected = findEvent(rejected.eventsBySeat.host, 'battle.command_rejected');
    assert.equal(hostRejected.payload.code, 'PVP_COMMAND_PHASE_MISMATCH');

    const replaced = service.submitCommand({
      session,
      seat: 'guest',
      envelope: command(1, 'awaiting_replacement', 'cmd-guest-replace', { type: 'choose_replacement', targetSlot: 2 }),
    });
    session = replaced.session;

    const replacementResolved = findEvent(replaced.eventsBySeat.host, 'battle.turn_resolved');
    assert.equal(replacementResolved.payload.nextPhase, 'awaiting_actions');
    assert.equal(replacementResolved.payload.postTurnVisibleState.opponent.active.speciesId, '007');
    const nextRequest = findEvent(replaced.eventsBySeat.guest, 'battle.request_action');
    assert.equal(nextRequest.payload.turn, 2);
    assert.equal(session.turn, 2);
    assert.equal(session.phase, 'awaiting_actions');

    Math.random = originalRandom;
  });

  it('forfeit 명령은 즉시 종료와 결과 기록을 만든다', () => {
    const service = createService();
    const created = service.createSession({
      room: makeRoom(),
      hostParty: makeParty('host-user', [
        { slot: 1, speciesId: '001', levelActual: 60, moves: ['host-fast', 'host-chip', 'host-guard', 'host-ko'] },
        { slot: 2, speciesId: '025', levelActual: 58, moves: ['host-fast', 'host-chip', 'host-guard', 'host-fast'] },
      ]),
      guestParty: makeParty('guest-user', [
        { slot: 1, speciesId: '004', levelActual: 60, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
        { slot: 2, speciesId: '007', levelActual: 58, moves: ['guest-fast', 'guest-chip', 'guest-guard', 'guest-finisher'] },
      ]),
    });

    const forfeited = service.submitCommand({
      session: created.session,
      seat: 'guest',
      envelope: command(1, 'awaiting_actions', 'cmd-guest-forfeit', { type: 'forfeit' }),
    });

    assert.equal(forfeited.session.phase, 'finished');
    assert.deepEqual(forfeited.session.result, {
      winnerSeat: 'host',
      loserSeat: 'guest',
      reason: 'forfeit',
      recordedAt: '2026-04-11T07:01:03.000Z',
    });

    const hostEnded = findEvent(forfeited.eventsBySeat.host, 'battle.ended');
    const guestEnded = findEvent(forfeited.eventsBySeat.guest, 'battle.ended');
    assert.equal(hostEnded.payload.result, 'win');
    assert.equal(guestEnded.payload.result, 'loss');
    assert.equal(hostEnded.payload.reason, 'forfeit');
  });
});
