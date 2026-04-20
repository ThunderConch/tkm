import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
  type ActivePartySnapshot,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
} from '../src/server/parties/index.js';
import {
  InMemoryRoomRepository,
  RoomService,
  RoomServiceError,
  type BattleRoomRecord,
} from '../src/server/rooms/index.js';

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

function registerParty(
  service: PartyRegistrationService,
  playerId: string,
  overrides: Partial<{ generation: 'gen4'; sourceStateHash: string; sourceConfigHash: string }> = {},
) {
  const members = makeMembers();

  return service.registerActiveParty({
    playerId,
    generation: overrides.generation ?? 'gen4',
    sourceStateHash: overrides.sourceStateHash ?? `sha256:${playerId}:state`,
    sourceConfigHash: overrides.sourceConfigHash ?? `sha256:${playerId}:config`,
    clientBuild: 'tokenmon-cli/0.120.0',
    members,
    growthProof: makeGrowthProof(members),
  });
}

function createServices() {
  const partyRepository = new InMemoryPartySnapshotRepository();
  const roomRepository = new InMemoryRoomRepository();
  const partyService = new PartyRegistrationService({ repository: partyRepository });
  let tick = 0;
  const roomCodes = ['A7KQ2M', 'A7KQ2M', 'B8TR4N', 'C9UV5P'];
  let roomCodeIndex = 0;
  let seedIndex = 0;
  const roomService = new RoomService({
    repository: roomRepository,
    partyService,
    now: () => new Date(Date.UTC(2026, 3, 11, 7, 10, tick++)),
    roomCodeGenerator: () => roomCodes[roomCodeIndex++] ?? 'Z9YX8W',
    battleSeedGenerator: () => `bseed_test_${++seedIndex}`,
    roomTtlMs: 15 * 60 * 1000,
  });

  return { partyRepository, roomRepository, partyService, roomService };
}

test('룸 생성은 host 바인딩과 고유 room code를 저장한다', () => {
  const { partyService, roomService } = createServices();
  registerParty(partyService, 'host-user');
  registerParty(partyService, 'other-user');

  const firstRoom = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen4',
    visibility: 'private_friend',
    rulesetKey: 'tkm-friendly-gen4-v1',
  });
  const secondRoom = roomService.createRoom({
    playerId: 'other-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });

  assert.equal(firstRoom.room.roomId, 'room_000001');
  assert.equal(firstRoom.room.roomCode, 'A7KQ2M');
  assert.equal(firstRoom.room.status, 'waiting_for_opponent');
  assert.equal(firstRoom.room.expiresAt, '2026-04-11T07:25:00.000Z');
  assert.equal(firstRoom.host.userId, 'host-user');
  assert.equal(firstRoom.host.seat, 'host');
  assert.equal(firstRoom.host.partySnapshotVersion, 1);
  assert.equal(firstRoom.host.battleReady, false);
  assert.equal(firstRoom.guest, null);
  assert.equal(firstRoom.battleFreeze, null);

  assert.equal(secondRoom.room.roomId, 'room_000002');
  assert.equal(secondRoom.room.roomCode, 'B8TR4N');
});

test('룸 참가 시 generation/ruleset 검증 후 awaiting_presence와 freeze를 준비한다', () => {
  const { partyService, roomService } = createServices();
  const hostParty = registerParty(partyService, 'host-user').party;
  const guestParty = registerParty(partyService, 'guest-user').party;

  const createdRoom = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });
  const joinedRoom = roomService.joinRoom({
    playerId: 'guest-user',
    roomId: createdRoom.room.roomId,
    roomCode: createdRoom.room.roomCode.toLowerCase(),
    generation: 'gen4',
  });
  const persistedRoom = roomService.getRoom(createdRoom.room.roomId);

  assert.equal(joinedRoom.room.status, 'awaiting_presence');
  assert.equal(joinedRoom.room.expiresAt, null);
  assert.equal(joinedRoom.host.battleReady, true);
  assert.equal(joinedRoom.guest?.userId, 'guest-user');
  assert.equal(joinedRoom.guest?.partySnapshotId, guestParty.snapshotId);
  assert.equal(joinedRoom.guest?.battleReady, true);
  assert.equal(joinedRoom.battleFreeze?.freezeStatus, 'pending_presence');
  assert.equal(joinedRoom.battleFreeze?.generation, 'gen4');
  assert.equal(joinedRoom.battleFreeze?.rulesetKey, 'tkm-friendly-gen4-v1');
  assert.equal(joinedRoom.battleFreeze?.hostPartySnapshotId, hostParty.snapshotId);
  assert.equal(joinedRoom.battleFreeze?.guestPartySnapshotId, guestParty.snapshotId);
  assert.equal(joinedRoom.battleFreeze?.battleSeed, 'bseed_test_1');
  assert.match(joinedRoom.battleFreeze?.rulesetHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(persistedRoom, joinedRoom);
});

test('이미 다른 활성 룸에 묶인 플레이어는 새 룸을 만들거나 참가할 수 없다', () => {
  const { partyService, roomService } = createServices();
  registerParty(partyService, 'host-user');
  registerParty(partyService, 'guest-user');
  registerParty(partyService, 'third-user');

  const room = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });

  assert.throws(
    () =>
      roomService.createRoom({
        playerId: 'host-user',
        generation: 'gen4',
        visibility: 'private_friend',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_ALREADY_BOUND');
      return true;
    },
  );

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'host-user',
        roomId: room.room.roomId,
        roomCode: room.room.roomCode,
        generation: 'gen4',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_SELF_JOIN_FORBIDDEN');
      return true;
    },
  );

  const secondRoom = roomService.createRoom({
    playerId: 'third-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });

  roomService.joinRoom({
    playerId: 'guest-user',
    roomId: room.room.roomId,
    roomCode: room.room.roomCode,
    generation: 'gen4',
  });

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'guest-user',
        roomId: secondRoom.room.roomId,
        roomCode: secondRoom.room.roomCode,
        generation: 'gen4',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_ALREADY_BOUND');
      return true;
    },
  );
});

test('generation/ruleset mismatch와 active snapshot 부재를 차단한다', () => {
  const { partyRepository, partyService, roomService } = createServices();
  const hostParty = registerParty(partyService, 'host-user').party;
  registerParty(partyService, 'guest-user');

  const room = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'guest-user',
        roomId: room.room.roomId,
        roomCode: room.room.roomCode,
        generation: 'gen5',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_GENERATION_MISMATCH');
      return true;
    },
  );

  partyRepository.seedSnapshots([
    {
      ...hostParty,
      playerId: 'guest-user',
      snapshotId: 'ops_gen4_999999',
      snapshotVersion: 9,
      rulesetKey: 'tkm-friendly-gen4-v999',
      isActive: true,
    } as ActivePartySnapshot,
  ]);

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'guest-user',
        roomId: room.room.roomId,
        roomCode: room.room.roomCode,
        generation: 'gen4',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_RULESET_MISMATCH');
      return true;
    },
  );

  assert.throws(
    () =>
      roomService.createRoom({
        playerId: 'missing-user',
        generation: 'gen4',
        visibility: 'private_friend',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_PARTY_NOT_REGISTERED');
      return true;
    },
  );
});

test('룸 상태와 코드 검증으로 잘못된 참가를 막는다', () => {
  const { partyService, roomRepository, roomService } = createServices();
  registerParty(partyService, 'host-user');
  registerParty(partyService, 'guest-user');

  const room = roomService.createRoom({
    playerId: 'host-user',
    generation: 'gen4',
    visibility: 'private_friend',
  });

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'guest-user',
        roomId: room.room.roomId,
        roomCode: 'WRONG1',
        generation: 'gen4',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_CODE_MISMATCH');
      return true;
    },
  );

  const persisted = roomService.getRoom(room.room.roomId);
  const seededRoom: BattleRoomRecord = {
    ...persisted,
    room: {
      ...persisted.room,
      status: 'cancelled',
      cancelledAt: '2026-04-11T07:15:00.000Z',
    },
  };
  roomRepository.seedRooms([seededRoom]);

  assert.throws(
    () =>
      roomService.joinRoom({
        playerId: 'guest-user',
        roomId: room.room.roomId,
        roomCode: room.room.roomCode,
        generation: 'gen4',
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoomServiceError);
      assert.equal(error.code, 'PVP_ROOM_STATE_INVALID');
      return true;
    },
  );
});
