import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { initLocale } from '../src/i18n/index.js';
import type { MoveData, PokemonData } from '../src/core/types.js';
import {
  BattleSessionService,
  type BattleCommandEnvelope,
  type BattleDataResolver,
} from '../src/server/battle/index.js';
import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
} from '../src/server/parties/index.js';
import type { PvpGeneration } from '../src/server/rules/index.js';
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

  return { clock, room: joinedRoom, server };
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

describe('PvP reconnect resume', () => {
  beforeEach(() => {
    initLocale('ko');
  });

  it('resume reconnect 시 기존 연결을 교체하고 남은 deadline + commandSubmitted 상태를 담은 snapshot을 즉시 보낸다', () => {
    const { clock, room, server } = createEnvironment();
    const hostTransport = new FakeTransport();
    const guestTransport = new FakeTransport();

    server.connectClient({
      roomId: room.room.roomId,
      token: 'host-token',
      connectionId: 'conn-host-1',
      transport: hostTransport,
    });
    server.connectClient({
      roomId: room.room.roomId,
      token: 'guest-token',
      connectionId: 'conn-guest',
      transport: guestTransport,
    });

    const battleId = getBattleId(hostTransport.messages);
    server.receiveMessage(
      'conn-host-1',
      buildChooseMoveCommand({
        roomId: room.room.roomId,
        battleId,
        clientCommandId: 'host-cmd-1',
        turn: 1,
        moveSlot: 1,
      }),
    );

    clock.advance(5_000);

    const resumedTransport = new FakeTransport();
    const resumed = server.connectClient({
      roomId: room.room.roomId,
      token: 'host-token',
      connectionId: 'conn-host-2',
      transport: resumedTransport,
      resume: true,
    });

    assert.equal(resumed.seat, 'host');
    assert.equal(resumed.battleId, battleId);
    assert.deepEqual(hostTransport.closes.at(-1), {
      code: 4001,
      reason: 'PVP_WS_CONNECTION_REPLACED',
    });

    const resumeSnapshot = resumedTransport.messages.at(-1);
    assert.ok(resumeSnapshot && resumeSnapshot.type === 'room.snapshot');
    assert.equal(resumeSnapshot.payload.turn, 1);
    assert.equal(resumeSnapshot.payload.pendingRequest?.kind, 'choose_move_or_switch');
    assert.equal(resumeSnapshot.payload.pendingRequest?.commandSubmitted, true);
    assert.equal(resumeSnapshot.payload.pendingRequest?.deadlineMs, 40_000);

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

    assert.equal(hostTransport.messages.some((message) => message.type === 'battle.turn_resolved'), false);
    assert.equal(resumedTransport.messages.some((message) => message.type === 'battle.turn_resolved'), true);
  });

  it('운영자 디버그 뷰에서 명령/이벤트 로그와 현재 timeout 상태를 조회할 수 있다', () => {
    const { room, server } = createEnvironment();
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

    const battleId = getBattleId(hostTransport.messages);
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

    const debugView = server.getBattleDebugView(room.room.roomId);
    assert.ok(debugView);
    assert.equal(debugView?.battleId, battleId);
    assert.equal(debugView?.commands.length, 2);
    assert.equal(debugView?.commands[0]?.accepted, true);
    assert.ok(debugView?.events.some((event) => event.type === 'battle.turn_resolved'));
    assert.equal(debugView?.timeouts.host.consecutive, 0);
    assert.equal(debugView?.requestState?.kind, 'choose_move_or_switch');
  });
});
