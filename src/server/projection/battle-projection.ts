import type { RoomSeat } from '../rooms/index.js';
import { createViewerVisibleState } from '../battle/battle-event-log.js';
import type { BattleDebugView, BattleRequestState, BattleSessionRecord, RoomSnapshotPayload } from '../battle/battle-types.js';

function getRemainingDeadlineMs(requestState: BattleRequestState | null, now: Date): number {
  if (!requestState) {
    return 0;
  }

  return Math.max(0, new Date(requestState.deadlineAt).getTime() - now.getTime());
}

function hasSubmittedCurrentCommand(session: BattleSessionRecord, seat: RoomSeat): boolean {
  if (!session.requestState) {
    return false;
  }

  if (session.requestState.kind === 'choose_move_or_switch') {
    return Boolean(session.pendingCommands[seat]);
  }

  return Boolean(session.pendingReplacementCommands[seat]);
}

export function buildRoomSnapshotPayload(
  session: BattleSessionRecord,
  seat: RoomSeat,
  now: Date,
): RoomSnapshotPayload {
  const requestState = session.requestState?.requiredSeats.includes(seat)
    ? session.requestState
    : null;

  return {
    roomStatus: session.roomStatus,
    battleStatus: session.phase,
    generation: session.generation,
    rulesetKey: session.rulesetKey,
    yourSeat: seat,
    turn: session.turn,
    visibleState: createViewerVisibleState(session, seat),
    pendingRequest: requestState
      ? {
          kind: requestState.kind,
          deadlineMs: getRemainingDeadlineMs(requestState, now),
          commandSubmitted: hasSubmittedCurrentCommand(session, seat),
        }
      : null,
  };
}

export function buildBattleDebugView(session: BattleSessionRecord): BattleDebugView {
  return {
    roomId: session.roomId,
    battleId: session.battleId,
    phase: session.phase,
    turn: session.turn,
    requestState: session.requestState ? structuredClone(session.requestState) : null,
    commands: structuredClone(session.commandLog),
    events: structuredClone(session.eventLog),
    timeouts: structuredClone(session.timeoutState),
    result: session.result ? structuredClone(session.result) : null,
  };
}
