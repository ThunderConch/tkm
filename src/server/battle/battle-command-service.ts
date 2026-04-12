import type { RoomSeat } from '../rooms/index.js';
import {
  collectAliveBenchSlots,
  getActiveBattlePokemon,
} from './battle-engine-adapter.js';
import type {
  BattleCommandEnvelope,
  BattleCommandRejectionCode,
  BattleCommandSource,
  BattleSessionRecord,
} from './battle-types.js';
import { BATTLE_COMMAND_REJECTION_CODES } from './battle-types.js';

export type BattleCommandValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: BattleCommandRejectionCode;
      message: string;
      retryable: boolean;
    };

function reject(
  code: BattleCommandRejectionCode,
  message: string,
  retryable: boolean,
): BattleCommandValidationResult {
  return {
    ok: false,
    code,
    message,
    retryable,
  };
}

export function getAvailableMoveSlots(session: BattleSessionRecord, seat: RoomSeat): number[] {
  if (session.phase !== 'awaiting_actions') {
    return [];
  }

  const active = getActiveBattlePokemon(session, seat);
  if (active.fainted) {
    return [];
  }

  return active.moves
    .map((move, index) => ({ move, slot: index + 1 }))
    .filter(({ move }) => move.currentPp > 0)
    .map(({ slot }) => slot);
}

export function getAvailableSwitchSlots(session: BattleSessionRecord, seat: RoomSeat): number[] {
  return collectAliveBenchSlots(session, seat);
}

export function validateBattleCommand(args: {
  session: BattleSessionRecord;
  seat: RoomSeat;
  envelope: BattleCommandEnvelope;
  now: Date;
  source: BattleCommandSource;
}): BattleCommandValidationResult {
  const { session, seat, envelope, now, source } = args;
  const { battleId, roomId } = envelope;
  const { clientCommandId, phase, turn, command } = envelope.payload;

  if (roomId !== session.roomId || battleId !== session.battleId) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_BATTLE_MISMATCH,
      'The submitted battle command does not target this battle session.',
      false,
    );
  }

  if (clientCommandId.trim().length === 0) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_CLIENT_ID_REQUIRED,
      'clientCommandId is required for PvP battle commands.',
      false,
    );
  }

  if (session.phase === 'finished' || session.phase === 'abandoned') {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_BATTLE_ALREADY_FINISHED,
      'This PvP battle has already finished.',
      false,
    );
  }

  if (session.seenClientCommandIds.includes(clientCommandId)) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_DUPLICATE,
      'This clientCommandId was already accepted for the battle.',
      false,
    );
  }

  if (
    source !== 'timeout_auto'
    && session.requestState
    && session.requestState.requiredSeats.includes(seat)
    && now.getTime() > new Date(session.requestState.deadlineAt).getTime()
  ) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_TIMEOUT,
      'The current battle request deadline has already elapsed.',
      false,
    );
  }

  if (phase !== session.phase) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_PHASE_MISMATCH,
      'The submitted battle command phase does not match the server phase.',
      true,
    );
  }

  if (turn !== session.turn) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_TURN_MISMATCH,
      'The submitted battle command turn does not match the server turn.',
      true,
    );
  }

  if (command.type === 'forfeit') {
    return { ok: true };
  }

  if (session.phase === 'awaiting_actions') {
    if (session.pendingCommands[seat]) {
      return reject(
        BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_DUPLICATE,
        'A battle command for this seat and turn was already accepted.',
        true,
      );
    }

    if (command.type === 'choose_replacement') {
      return reject(
        BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_PHASE_MISMATCH,
        'Replacement commands are only accepted during awaiting_replacement.',
        true,
      );
    }

    if (command.type === 'choose_move') {
      if (!getAvailableMoveSlots(session, seat).includes(command.moveSlot)) {
        return reject(
          BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_MOVE_INVALID,
          'The requested move slot is not currently available.',
          true,
        );
      }
      return { ok: true };
    }

    if (!getAvailableSwitchSlots(session, seat).includes(command.targetSlot)) {
      return reject(
        BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_SWITCH_INVALID,
        'The requested switch target is not currently available.',
        true,
      );
    }

    return { ok: true };
  }

  if (command.type !== 'choose_replacement') {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_PHASE_MISMATCH,
      'Only replacement commands are accepted during awaiting_replacement.',
      true,
    );
  }

  if (!session.pendingReplacementSeats.includes(seat)) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_PHASE_MISMATCH,
      'This seat is not currently required to choose a replacement.',
      true,
    );
  }

  if (session.pendingReplacementCommands[seat]) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_DUPLICATE,
      'A replacement command for this seat and turn was already accepted.',
      true,
    );
  }

  if (!getAvailableSwitchSlots(session, seat).includes(command.targetSlot)) {
    return reject(
      BATTLE_COMMAND_REJECTION_CODES.PVP_COMMAND_REPLACEMENT_INVALID,
      'The requested replacement target is not currently available.',
      true,
    );
  }

  return { ok: true };
}
