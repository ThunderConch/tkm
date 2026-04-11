import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPvpRoomRoutes } from '../src/server/http/pvp-room-routes.js';
import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
  InMemoryRoomRepository,
  RoomService,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
} from '../src/server/index.js';

function makeMember(slot: number, speciesId: string, levelActual = 50): OnlinePartyMemberInput {
  return {
    slot,
    pokemonInstanceId: `pkm-${slot}`,
    speciesId,
    nickname: `P-${slot}`,
    levelActual,
    moves: [`move-${slot}-1`, `move-${slot}-2`, `move-${slot}-3`, `move-${slot}-4`],
  };
}

function makeMembers(): OnlinePartyMemberInput[] {
  return [
    makeMember(1, '387', 12),
    makeMember(2, '390', 18),
    makeMember(3, '393', 24),
    makeMember(4, '403', 31),
    makeMember(5, '483', 72),
    makeMember(6, '490', 55),
  ];
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

function registerParty(service: PartyRegistrationService, playerId: string, generation = 'gen4') {
  const members = makeMembers();
  return service.registerActiveParty({
    playerId,
    generation,
    sourceStateHash: `sha256:state-${playerId}`,
    sourceConfigHash: `sha256:config-${playerId}`,
    clientBuild: 'tokenmon-cli/0.120.0',
    members,
    growthProof: makeGrowthProof(members),
  });
}

function createRoutes() {
  const partyRepository = new InMemoryPartySnapshotRepository();
  const roomRepository = new InMemoryRoomRepository();
  const partyService = new PartyRegistrationService({ repository: partyRepository });
  let tick = 0;
  let roomCodeIndex = 0;
  let battleSeedIndex = 0;
  const roomCodes = ['A7KQ2M', 'B8TR4N', 'C9UV5P'];
  const roomService = new RoomService({
    repository: roomRepository,
    partyService,
    now: () => new Date(Date.UTC(2026, 3, 11, 7, 10, tick++)),
    roomCodeGenerator: () => roomCodes[Math.min(roomCodeIndex++, roomCodes.length - 1)],
    battleSeedGenerator: () => `bseed_test_${++battleSeedIndex}`,
    roomTtlMs: 15 * 60 * 1000,
  });

  return {
    partyService,
    roomService,
    roomRoutes: createPvpRoomRoutes({ service: roomService }),
  };
}

test('룸 생성은 인증이 없으면 401을 반환한다', () => {
  const { roomRoutes } = createRoutes();

  const response = roomRoutes.createRoom({
    body: {
      generation: 'gen4',
      visibility: 'private_friend',
    },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'PVP_UNAUTHORIZED');
});

test('shape이 잘못된 룸 생성 요청은 400을 반환한다', () => {
  const { roomRoutes } = createRoutes();

  const response = roomRoutes.createRoom({
    auth: { playerId: 'player-1' },
    body: {
      visibility: 'private_friend',
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'PVP_INVALID_REQUEST');
});

test('룸 생성은 host 기준 projection을 반환한다', () => {
  const { partyService, roomRoutes } = createRoutes();
  const registration = registerParty(partyService, 'player-host');

  const response = roomRoutes.createRoom({
    auth: { playerId: 'player-host' },
    body: {
      generation: 'gen4',
      visibility: 'private_friend',
      rulesetKey: 'tkm-friendly-gen4-v1',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.room.roomCode, 'A7KQ2M');
  assert.equal(response.body.room.status, 'waiting_for_opponent');
  assert.equal(response.body.you.seat, 'host');
  assert.equal(response.body.you.partySnapshotId, registration.party.snapshotId);
  assert.equal(response.body.opponent, null);
  assert.deepEqual(response.body.match, {
    freezeStatus: 'waiting_for_opponent',
    battleId: null,
    battleStartedAt: null,
  });
});

test('룸 참가와 조회는 viewer별 projection을 반환하고 상대 snapshot은 숨긴다', () => {
  const { partyService, roomRoutes } = createRoutes();
  const hostRegistration = registerParty(partyService, 'player-host');
  const guestRegistration = registerParty(partyService, 'player-guest');

  const created = roomRoutes.createRoom({
    auth: { playerId: 'player-host' },
    body: {
      generation: 'gen4',
      visibility: 'private_friend',
    },
  });

  const joined = roomRoutes.joinRoom({
    auth: { playerId: 'player-guest' },
    params: { roomId: created.body.room.roomId },
    body: {
      roomCode: created.body.room.roomCode,
      generation: 'gen4',
    },
  });

  assert.equal(joined.status, 200);
  assert.equal(joined.body.room.status, 'awaiting_presence');
  assert.equal(joined.body.you.seat, 'guest');
  assert.equal(joined.body.you.partySnapshotId, guestRegistration.party.snapshotId);
  assert.equal(joined.body.opponent?.seat, 'host');
  assert.equal(joined.body.opponent?.displayName, 'player-host');
  assert.equal('partySnapshotId' in joined.body.opponent, false);
  assert.deepEqual(joined.body.match, {
    freezeStatus: 'pending_presence',
    battleId: null,
    battleStartedAt: null,
  });

  const hostView = roomRoutes.getRoom({
    auth: { playerId: 'player-host' },
    params: { roomId: created.body.room.roomId },
  });

  assert.equal(hostView.status, 200);
  assert.equal(hostView.body.you.seat, 'host');
  assert.equal(hostView.body.you.partySnapshotId, hostRegistration.party.snapshotId);
  assert.equal(hostView.body.opponent?.seat, 'guest');
  assert.equal(hostView.body.opponent?.displayName, 'player-guest');
  assert.equal('partySnapshotId' in hostView.body.opponent, false);
});

test('룸 조회는 참여자가 아니면 403을 반환한다', () => {
  const { partyService, roomRoutes } = createRoutes();
  registerParty(partyService, 'player-host');

  const created = roomRoutes.createRoom({
    auth: { playerId: 'player-host' },
    body: {
      generation: 'gen4',
      visibility: 'private_friend',
    },
  });

  const response = roomRoutes.getRoom({
    auth: { playerId: 'player-other' },
    params: { roomId: created.body.room.roomId },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'PVP_ROOM_ACCESS_DENIED');
});

test('룸 참가 실패는 room service error envelope을 그대로 노출한다', () => {
  const { partyService, roomRoutes } = createRoutes();
  registerParty(partyService, 'player-host');
  registerParty(partyService, 'player-guest');

  const created = roomRoutes.createRoom({
    auth: { playerId: 'player-host' },
    body: {
      generation: 'gen4',
      visibility: 'private_friend',
    },
  });

  const response = roomRoutes.joinRoom({
    auth: { playerId: 'player-guest' },
    params: { roomId: created.body.room.roomId },
    body: {
      roomCode: 'WRONG1',
      generation: 'gen4',
    },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'PVP_ROOM_CODE_MISMATCH');
});
