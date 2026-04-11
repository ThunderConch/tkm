import type {
  BattleFreezeStatus,
  BattleRoomRecord,
  RoomPlayerBinding,
  RoomSeat,
} from '../rooms/index.js';

export interface RoomView {
  room: {
    roomId: string;
    roomCode: string;
    mode: BattleRoomRecord['room']['mode'];
    status: BattleRoomRecord['room']['status'];
    generation: BattleRoomRecord['room']['generation'];
    rulesetKey: BattleRoomRecord['room']['rulesetKey'];
    createdAt: string;
    expiresAt: string | null;
  };
  you: {
    seat: RoomSeat;
    partySnapshotId: string;
    partyValidationStatus: RoomPlayerBinding['partyValidationStatus'];
    presence: RoomPlayerBinding['presence'];
    battleReady: boolean;
  };
  opponent: {
    seat: RoomSeat;
    presence: RoomPlayerBinding['presence'];
    battleReady: boolean;
    displayName: string;
  } | null;
  match: {
    freezeStatus: BattleFreezeStatus;
    battleId: null;
    battleStartedAt: string | null;
  };
}

export class RoomProjectionError extends Error {
  readonly status: number;

  readonly code: string;

  readonly retryable: boolean;

  readonly details?: Record<string, unknown>;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = 'RoomProjectionError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

function toDisplayName(userId: string): string {
  return userId;
}

function resolveViewerBindings(room: BattleRoomRecord, viewerId: string): {
  you: RoomPlayerBinding;
  opponent: RoomPlayerBinding | null;
} {
  if (room.host.userId === viewerId) {
    return {
      you: room.host,
      opponent: room.guest,
    };
  }

  if (room.guest?.userId === viewerId) {
    return {
      you: room.guest,
      opponent: room.host,
    };
  }

  throw new RoomProjectionError({
    status: 403,
    code: 'PVP_ROOM_ACCESS_DENIED',
    message: 'Only room participants can view this PvP room.',
    retryable: false,
    details: { roomId: room.room.roomId },
  });
}

function resolveFreezeStatus(room: BattleRoomRecord): BattleFreezeStatus {
  return room.battleFreeze?.freezeStatus ?? 'waiting_for_opponent';
}

export function projectRoomView(room: BattleRoomRecord, viewerId: string): RoomView {
  const { you, opponent } = resolveViewerBindings(room, viewerId);

  return {
    room: {
      roomId: room.room.roomId,
      roomCode: room.room.roomCode,
      mode: room.room.mode,
      status: room.room.status,
      generation: room.room.generation,
      rulesetKey: room.room.rulesetKey,
      createdAt: room.room.createdAt,
      expiresAt: room.room.expiresAt,
    },
    you: {
      seat: you.seat,
      partySnapshotId: you.partySnapshotId,
      partyValidationStatus: you.partyValidationStatus,
      presence: you.presence,
      battleReady: you.battleReady,
    },
    opponent: opponent
      ? {
          seat: opponent.seat,
          presence: opponent.presence,
          battleReady: opponent.battleReady,
          displayName: toDisplayName(opponent.userId),
        }
      : null,
    match: {
      freezeStatus: resolveFreezeStatus(room),
      battleId: null,
      battleStartedAt: room.room.startedAt,
    },
  };
}
