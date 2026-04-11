import type { RoomSeat } from '../rooms/index.js';
import { getAvailableMoveSlots, getAvailableSwitchSlots } from './battle-command-service.js';
import type {
  BattleCommandEnvelope,
  BattleCommandPhase,
  BattleRequestState,
  BattleSessionRecord,
} from './battle-types.js';

function createAutoCommandEnvelope(args: {
  session: BattleSessionRecord;
  seat: RoomSeat;
  requestState: BattleRequestState;
  command: BattleCommandEnvelope['payload']['command'];
  now: Date;
}): BattleCommandEnvelope {
  const { session, seat, requestState, command, now } = args;
  return {
    type: 'battle.command',
    roomId: session.roomId,
    battleId: session.battleId,
    seq: session.nextSeq,
    sentAt: now.toISOString(),
    payload: {
      clientCommandId: `timeout:${session.battleId}:${requestState.turn}:${requestState.phase}:${seat}:${now.getTime()}`,
      turn: requestState.turn,
      phase: requestState.phase,
      command,
    },
  };
}

function buildDefaultCommand(args: {
  session: BattleSessionRecord;
  seat: RoomSeat;
  phase: BattleCommandPhase;
}) {
  const { session, seat, phase } = args;

  if (phase === 'awaiting_actions') {
    const moveSlots = getAvailableMoveSlots(session, seat);
    if (moveSlots.length > 0) {
      return {
        type: 'choose_move' as const,
        moveSlot: moveSlots[0],
      };
    }

    const switchSlots = getAvailableSwitchSlots(session, seat);
    if (switchSlots.length > 0) {
      return {
        type: 'choose_switch' as const,
        targetSlot: switchSlots[0],
      };
    }

    return { type: 'forfeit' as const };
  }

  const replacementSlots = getAvailableSwitchSlots(session, seat);
  if (replacementSlots.length > 0) {
    return {
      type: 'choose_replacement' as const,
      targetSlot: replacementSlots[0],
    };
  }

  return { type: 'forfeit' as const };
}

export function isBattleRequestTimedOut(session: BattleSessionRecord, now: Date): boolean {
  if (!session.requestState) {
    return false;
  }

  return now.getTime() > new Date(session.requestState.deadlineAt).getTime();
}

export function getTimedOutSeats(session: BattleSessionRecord, now: Date): RoomSeat[] {
  if (!isBattleRequestTimedOut(session, now) || !session.requestState) {
    return [];
  }

  const pendingCommands = session.requestState.kind === 'choose_move_or_switch'
    ? session.pendingCommands
    : session.pendingReplacementCommands;

  return session.requestState.requiredSeats.filter((seat) => !pendingCommands[seat]);
}

export function createTimeoutCommandEnvelope(args: {
  session: BattleSessionRecord;
  seat: RoomSeat;
  now: Date;
}): BattleCommandEnvelope {
  const { session, seat, now } = args;
  if (!session.requestState) {
    throw new Error('Cannot create a timeout command without an active request state.');
  }

  return createAutoCommandEnvelope({
    session,
    seat,
    requestState: session.requestState,
    command: buildDefaultCommand({
      session,
      seat,
      phase: session.requestState.phase,
    }),
    now,
  });
}

export function createTimeoutForfeitEnvelope(args: {
  session: BattleSessionRecord;
  seat: RoomSeat;
  now: Date;
}): BattleCommandEnvelope {
  const { session, seat, now } = args;
  if (!session.requestState) {
    throw new Error('Cannot create a timeout forfeit without an active request state.');
  }

  return createAutoCommandEnvelope({
    session,
    seat,
    requestState: session.requestState,
    command: { type: 'forfeit' },
    now,
  });
}
