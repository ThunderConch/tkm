import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { initLocale } from '../src/i18n/index.js';
import type { MoveData, PokemonData } from '../src/core/types.js';
import {
  BattleSessionService,
  type BattleCommandEnvelope,
  type BattleDataResolver,
  type PvpGeneration,
} from '../src/server/battle/index.js';
import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
} from '../src/server/parties/index.js';
import { InMemoryRoomRepository, RoomService } from '../src/server/rooms/index.js';
import { PvpWsServer, type PvpWsOutboundEnvelope } from '../src/server/ws/index.js';

initLocale('ko');

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
  '039': {
    id: 39,
    name: 'Jigglypuff',
    types: ['normal'],
    stage: 1,
    line: ['Jigglypuff'],
    evolves_at: null,
    unlock: 'wild',
    exp_group: 'fast',
    rarity: 'uncommon',
    region: 'kanto',
    base_stats: { hp: 135, attack: 65, defense: 45, speed: 20, sp_attack: 65, sp_defense: 50 },
    catch_rate: 170,
  },
  '052': {
    id: 52,
    name: 'Meowth',
    types: ['normal'],
    stage: 1,
    line: ['Meowth'],
    evolves_at: 28,
    unlock: 'wild',
    exp_group: 'medium_fast',
    rarity: 'common',
    region: 'kanto',
    base_stats: { hp: 60, attack: 70, defense: 55, speed: 110, sp_attack: 45, sp_defense: 65 },
    catch_rate: 255,
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
  'host-chip': {
    id: 102,
    name: 'host-chip',
    nameKo: '호스트 견제',
    nameEn: 'Host Chip',
    type: 'grass',
    category: 'special',
    power: 35,
    accuracy: 100,
    pp: 25,
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
};

const RESOLVER: BattleDataResolver = {
  resolveSpecies(_generation, speciesId) {
    return SPECIES_DATA[speciesId] ?? SPECIES_DATA[speciesId.padStart(3, '0')];
  },
  resolveMove(_generation, moveId) {
    return MOVE_DATA[moveId];
  },
};

class FakeTransport {
  readonly messages: PvpWsOutboundEnvelope[] = [];

  readonly closes: Array<{ code: number; reason: string }> = [];

  send(message: PvpWsOutboundEnvelope): void {
    this.messages.push(message);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

function makeMember(slot: number, speciesId: string, levelActual: number, moves: string[]): OnlinePartyMemberInput {
  return {
    slot,
    pokemonInstanceId: `pkm-${slot}`,
    speciesId,
    nickname: `P-${slot}`,
    levelActual,
    moves,
  };
}

function makeGrowthProof(members: OnlinePartyMemberInput[]): GrowthProofInput {
  return {
    proofVersion: 'v1',
    capturedAt: '2026-04-11T09:00:00Z',
    sourceSaveId: 'save_main',
    sourceSaveRevision: 101,
    cheatFlags: {
      hasCheatHistory: false,
      flags: [],
    },
    memberProofs: members.map((member) => ({
      slot: member.slot,
      pokemonInstanceId: member.pokemonInstanceId,
      speciesId: member.speciesId,
      levelActual: member.levelActual,
      movesHash: `sha256:moves-${member.slot}`,
      stateHash: `sha256:state-${member.slot}`,
    })),
  };
}

function createClock() {
  let current = Date.UTC(2026, 3, 11, 8, 0, 0);

  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

function createEnvironment() {
  const clock = createClock();
  const partyRepository = new InMemoryPartySnapshotRepository();
  const roomRepository = new InMemoryRoomRepository();
  const partyService = new PartyRegistrationService({ repository: partyRepository });
  let roomCodeIndex = 0;
  let battleIdIndex = 0;
  let battleSeedIndex = 0;
  const roomCodes = ['A7KQ2M', 'B8TR4N'];
  const roomService = new RoomService({
    repository: roomRepository,
    partyService,
    now: clock.now,
    roomCodeGenerator: () => roomCodes[roomCodeIndex++] ?? 'Z9YX8W',
    battleSeedGenerator: () => `bseed_${++battleSeedIndex}`,
    roomTtlMs: 15 * 60 * 1000,
  });
  const battleSessionService = new BattleSessionService({
    dataResolver: RESOLVER,
    now: clock.now,
    battleIdGenerator: () => `battle_${String(++battleIdIndex).padStart(6, '0')}`,
  });

  const registerParty = (playerId: string, generation: PvpGeneration = 'gen1') => {
    const leadMoves =
      playerId === 'host-user'
        ? ['host-fast', 'host-chip', 'guest-fast', 'guest-chip']
        : ['guest-fast', 'guest-chip', 'host-fast', 'host-chip'];
    const members: OnlinePartyMemberInput[] = [
      makeMember(1, playerId === 'host-user' ? '001' : '004', 52, leadMoves),
      makeMember(2, '007', 48, ['host-chip', 'guest-chip', 'host-fast', 'guest-fast']),
      makeMember(3, '025', 40, ['guest-fast', 'host-fast', 'guest-chip', 'host-chip']),
      makeMember(4, '039', 35, ['guest-chip', 'host-chip', 'guest-fast', 'host-fast']),
      makeMember(5, '052', 30, ['host-fast', 'guest-fast', 'host-chip', 'guest-chip']),
      makeMember(6, playerId === 'host-user' ? '004' : '001', 25, ['guest-chip', 'guest-fast', 'host-chip', 'host-fast']),
    ];

    return partyService.registerActiveParty({
      playerId,
      generation,
      sourceStateHash: `sha256:${playerId}:state`,
      sourceConfigHash: `sha256:${playerId}:config`,
      clientBuild: 'tokenmon-cli/0.120.0',
      members,
      growthProof: makeGrowthProof(members),
    }).party;
  };

  const hostParty = registerParty('host-user');
  const guestParty = registerParty('guest-user');
  const room = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen1',
    visibility: 'private_friend',
  });
  const joinedRoom = roomService.joinRoom({
    playerId: 'guest-user',
    roomId: room.room.roomId,
    roomCode: room.room.roomCode,
    generation: 'gen1',
  });

  const server = new PvpWsServer({
    authenticate(token) {
      if (token === 'host-token') {
        return { userId: 'host-user' };
      }
      if (token === 'guest-token') {
        return { userId: 'guest-user' };
      }
      return null;
    },
    now: clock.now,
    roomRepository,
    battleSessionService,
    loadPartySnapshot(snapshotId) {
      return [hostParty, guestParty].find((party) => party.snapshotId === snapshotId);
    },
  });

  return { clock, roomRepository, room: joinedRoom, server };
}

function getBattleId(messages: PvpWsOutboundEnvelope[]): string {
  const snapshot = messages.find((message) => message.type === 'room.snapshot');
  assert.ok(snapshot, 'room.snapshot message missing');
  return snapshot.battleId;
}

function buildChooseMoveCommand(input: {
  roomId: string;
  battleId: string;
  clientCommandId: string;
  turn: number;
  moveSlot: number;
}): BattleCommandEnvelope {
  return {
    type: 'battle.command',
    roomId: input.roomId,
    battleId: input.battleId,
    seq: 1,
    sentAt: '2026-04-11T08:00:00.000Z',
    payload: {
      clientCommandId: input.clientCommandId,
      turn: input.turn,
      phase: 'awaiting_actions',
      command: {
        type: 'choose_move',
        moveSlot: input.moveSlot,
      },
    },
  };
}

describe('PvpWsServer', () => {
  beforeEach(() => {
    initLocale('ko');
  });

  it('양 플레이어 연결 후 battle command를 서버 권한으로 처리하고 좌석별 이벤트만 푸시한다', () => {
    const { server, room } = createEnvironment();
    const hostTransport = new FakeTransport();
    const guestTransport = new FakeTransport();

    const hostConnection = server.connectClient({
      roomId: room.room.roomId,
      token: 'host-token',
      connectionId: 'conn-host',
      transport: hostTransport,
    });

    assert.equal(hostConnection.seat, 'host');
    assert.equal(hostConnection.battleId, null);
    assert.deepEqual(hostTransport.messages, []);

    const guestConnection = server.connectClient({
      roomId: room.room.roomId,
      token: 'guest-token',
      connectionId: 'conn-guest',
      transport: guestTransport,
    });

    assert.equal(guestConnection.seat, 'guest');
    assert.deepEqual(hostTransport.messages.map((message) => message.type), ['room.snapshot', 'battle.request_action']);
    assert.equal(guestTransport.messages.map((message) => message.type).join(','), 'room.snapshot,battle.request_action');

    const battleId = getBattleId(hostTransport.messages);
    assert.equal(guestConnection.battleId, battleId);

    server.receiveMessage(
      'conn-host',
      buildChooseMoveCommand({
        roomId: room.room.roomId,
        battleId,
        clientCommandId: 'host-cmd-1',
        turn: 1,
        moveSlot: 1,
      }),
    );

    assert.equal(hostTransport.messages.at(-1)?.type, 'battle.command_accepted');
    assert.equal(guestTransport.messages.at(-1)?.type, 'battle.request_action');

    server.receiveMessage(
      'conn-guest',
      buildChooseMoveCommand({
        roomId: room.room.roomId,
        battleId,
        clientCommandId: 'guest-cmd-1',
        turn: 1,
        moveSlot: 1,
      }),
    );

    const hostResolved = hostTransport.messages.findLast((message) => message.type === 'battle.turn_resolved');
    const guestResolved = guestTransport.messages.findLast((message) => message.type === 'battle.turn_resolved');
    assert.ok(hostResolved && hostResolved.type === 'battle.turn_resolved');
    assert.ok(guestResolved && guestResolved.type === 'battle.turn_resolved');
    assert.equal(hostResolved.payload.events[0]?.eventType, 'move_used');
    assert.equal(hostResolved.payload.events[0]?.actor, 'self');
    assert.equal(guestResolved.payload.events[0]?.eventType, 'move_used');
    assert.equal(guestResolved.payload.events[0]?.actor, 'opponent');
    assert.equal(hostTransport.messages.at(-1)?.type, 'battle.request_action');
    assert.equal(guestTransport.messages.at(-1)?.type, 'battle.request_action');
  });

  it('heartbeat timeout이 발생하면 stale connection을 끊고 room presence를 disconnected로 저장한다', () => {
    const { server, roomRepository, room, clock } = createEnvironment();
    const hostTransport = new FakeTransport();
    const guestTransport = new FakeTransport();

    server.connectClient({
      roomId: room.room.roomId,
      token: 'host-token',
      connectionId: 'conn-host',
      transport: hostTransport,
    });
    server.connectClient({
      roomId: room.room.roomId,
      token: 'guest-token',
      connectionId: 'conn-guest',
      transport: guestTransport,
    });

    clock.advance(10_000);
    server.sweepHeartbeats();

    assert.equal(hostTransport.messages.at(-1)?.type, 'ws.ping');
    assert.equal(guestTransport.messages.at(-1)?.type, 'ws.ping');

    server.receiveMessage('conn-host', {
      type: 'ws.pong',
      sentAt: '2026-04-11T08:00:10.000Z',
    });

    clock.advance(15_000);
    server.sweepHeartbeats();

    assert.deepEqual(guestTransport.closes.at(-1), {
      code: 4002,
      reason: 'PVP_WS_HEARTBEAT_TIMEOUT',
    });

    const persistedRoom = roomRepository.getRoom(room.room.roomId);
    assert.equal(persistedRoom?.host.presence, 'connected');
    assert.equal(persistedRoom?.guest?.presence, 'disconnected');
  });

  it('같은 좌석의 중복 연결은 새 연결을 거부하고 기존 연결을 유지한다', () => {
    const { server, room } = createEnvironment();
    const originalHostTransport = new FakeTransport();
    const duplicateHostTransport = new FakeTransport();
    const guestTransport = new FakeTransport();

    server.connectClient({
      roomId: room.room.roomId,
      token: 'host-token',
      connectionId: 'conn-host-1',
      transport: originalHostTransport,
    });
    server.connectClient({
      roomId: room.room.roomId,
      token: 'guest-token',
      connectionId: 'conn-guest',
      transport: guestTransport,
    });

    assert.throws(
      () =>
        server.connectClient({
          roomId: room.room.roomId,
          token: 'host-token',
          connectionId: 'conn-host-2',
          transport: duplicateHostTransport,
        }),
      /PVP_WS_DUPLICATE_CONNECTION/,
    );

    assert.deepEqual(duplicateHostTransport.closes.at(-1), {
      code: 4001,
      reason: 'PVP_WS_DUPLICATE_CONNECTION',
    });
    assert.equal(originalHostTransport.closes.length, 0);
  });
});
