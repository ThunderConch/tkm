import type { ActivePartySnapshot } from '../parties/index.js';
import type { RulesetSummary } from '../rules/index.js';
import type {
  BattleRoomRecord,
  BattleRoomStatus,
  BattleRoomVisibility,
} from './room-types.js';

export interface RoomValidationFailure {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function createFailure(options: RoomValidationFailure): RoomValidationFailure {
  return options;
}

export function isSupportedRoomVisibility(value: string): value is BattleRoomVisibility {
  return value === 'private_friend';
}

export function isParticipationLockedStatus(status: BattleRoomStatus): boolean {
  return (
    status === 'waiting_for_opponent' ||
    status === 'awaiting_presence' ||
    status === 'starting' ||
    status === 'in_progress'
  );
}

export function validateRequestedVisibility(visibility: string): RoomValidationFailure | undefined {
  if (isSupportedRoomVisibility(visibility)) {
    return undefined;
  }

  return createFailure({
    status: 422,
    code: 'PVP_ROOM_VISIBILITY_INVALID',
    message: 'Only private friend rooms are supported in the current PvP phase.',
    retryable: false,
    details: { visibility },
  });
}

export function validateRequestedRuleset(
  requestedRulesetKey: string | undefined,
  activeRuleset: RulesetSummary,
): RoomValidationFailure | undefined {
  if (!requestedRulesetKey || requestedRulesetKey === activeRuleset.rulesetKey) {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_RULESET_MISMATCH',
    message: 'The requested room ruleset does not match the current active PvP ruleset.',
    retryable: true,
    details: {
      generation: activeRuleset.generation,
      requestedRulesetKey,
      activeRulesetKey: activeRuleset.rulesetKey,
    },
  });
}

export function validatePartyAccepted(
  party: ActivePartySnapshot,
  details: Record<string, unknown>,
): RoomValidationFailure | undefined {
  if (party.validationStatus === 'accepted') {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_PARTY_VALIDATION_REJECTED',
    message: 'The active online party is not accepted for PvP room participation.',
    retryable: false,
    details,
  });
}

export function validateCreateBindingAvailability(
  playerId: string,
  existingRoom: BattleRoomRecord | undefined,
): RoomValidationFailure | undefined {
  if (!existingRoom) {
    return undefined;
  }

  const existingSeat =
    existingRoom.host.userId === playerId
      ? existingRoom.host.seat
      : existingRoom.guest?.userId === playerId
        ? existingRoom.guest.seat
        : undefined;

  return createFailure({
    status: 409,
    code: 'PVP_ROOM_ALREADY_BOUND',
    message: 'The player is already bound to another active PvP room.',
    retryable: false,
    details: {
      roomId: existingRoom.room.roomId,
      status: existingRoom.room.status,
      seat: existingSeat,
      generation: existingRoom.room.generation,
    },
  });
}

export function validateJoinRoomState(room: BattleRoomRecord): RoomValidationFailure | undefined {
  if (room.guest) {
    return createFailure({
      status: 409,
      code: 'PVP_ROOM_ALREADY_FILLED',
      message: 'The PvP room already has both host and guest bound.',
      retryable: false,
      details: { roomId: room.room.roomId, status: room.room.status },
    });
  }

  if (room.room.status !== 'waiting_for_opponent') {
    return createFailure({
      status: 409,
      code: 'PVP_ROOM_STATE_INVALID',
      message: 'The PvP room is not accepting opponents in its current state.',
      retryable: false,
      details: { roomId: room.room.roomId, status: room.room.status },
    });
  }

  return undefined;
}

export function validateJoinRequestCode(
  room: BattleRoomRecord,
  requestedRoomCode: string,
): RoomValidationFailure | undefined {
  if (room.room.roomCode === requestedRoomCode) {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_ROOM_CODE_MISMATCH',
    message: 'The supplied room code does not match the target PvP room.',
    retryable: false,
    details: { roomId: room.room.roomId },
  });
}

export function validateJoinGeneration(
  room: BattleRoomRecord,
  requestedGeneration: string,
): RoomValidationFailure | undefined {
  if (requestedGeneration === room.room.generation) {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_ROOM_GENERATION_MISMATCH',
    message: 'The supplied generation does not match the PvP room generation.',
    retryable: false,
    details: {
      roomId: room.room.roomId,
      requestedGeneration,
      roomGeneration: room.room.generation,
    },
  });
}

export function validateSelfJoin(room: BattleRoomRecord, playerId: string): RoomValidationFailure | undefined {
  if (room.host.userId !== playerId) {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_ROOM_SELF_JOIN_FORBIDDEN',
    message: 'The host cannot join their own PvP room as the opponent.',
    retryable: false,
    details: { roomId: room.room.roomId },
  });
}

export function validateGuestRuleset(
  room: BattleRoomRecord,
  party: ActivePartySnapshot,
): RoomValidationFailure | undefined {
  if (party.generation !== room.room.generation) {
    return createFailure({
      status: 409,
      code: 'PVP_ROOM_GENERATION_MISMATCH',
      message: 'The guest active party generation does not match the PvP room.',
      retryable: false,
      details: {
        roomId: room.room.roomId,
        roomGeneration: room.room.generation,
        partyGeneration: party.generation,
      },
    });
  }

  if (party.rulesetKey === room.room.rulesetKey) {
    return undefined;
  }

  return createFailure({
    status: 409,
    code: 'PVP_ROOM_RULESET_MISMATCH',
    message: 'The guest active party ruleset does not match the PvP room ruleset.',
    retryable: true,
    details: {
      roomId: room.room.roomId,
      roomRulesetKey: room.room.rulesetKey,
      partyRulesetKey: party.rulesetKey,
      snapshotId: party.snapshotId,
    },
  });
}
