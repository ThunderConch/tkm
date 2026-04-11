import type { BattleRoomStatus, RoomSeat } from '../server/rooms/index.js';
import type { PvpGeneration, RulesetKey } from '../server/rules/index.js';
import type {
  BattleActionRequestPayload,
  BattleCommand,
  BattleCommandAcceptedPayload,
  BattleCommandEnvelope,
  BattleCommandPhase,
  BattleCommandRejectedPayload,
  BattleEndedPayload,
  BattleReplacementRequestPayload,
  BattleRequestKind,
  BattleServerEventEnvelope,
  BattleSessionPhase,
  RoomSnapshotPayload,
  ViewerVisibleState,
  VisibleBenchPokemon,
  VisibleMoveOption,
} from '../server/battle/index.js';

type PendingRequestBase = {
  kind: BattleRequestKind;
  phase: BattleCommandPhase;
  turn: number;
  deadlineMs: number;
  commandSubmitted: boolean;
  requestId: string | null;
};

export interface PendingActionRequest extends PendingRequestBase {
  kind: 'choose_move_or_switch';
  phase: 'awaiting_actions';
  activePokemon?: BattleActionRequestPayload['request']['activePokemon'];
  availableMoves?: VisibleMoveOption[];
  availableSwitches?: VisibleBenchPokemon[];
}

export interface PendingReplacementRequest extends PendingRequestBase {
  kind: 'choose_replacement';
  phase: 'awaiting_replacement';
  faintedSlot: number | null;
  availableReplacements?: VisibleBenchPokemon[];
}

export type PvpPendingRequest = PendingActionRequest | PendingReplacementRequest;

export interface PendingCommandState {
  clientCommandId: string;
  turn: number;
  phase: BattleCommandPhase;
  command: BattleCommand;
  seq: number;
  sentAt: string;
  status: 'created' | 'accepted' | 'rejected_permanent';
  lockedIn: boolean;
}

export interface PvpSessionState {
  roomId: string | null;
  battleId: string | null;
  roomStatus: BattleRoomStatus | null;
  battleStatus: BattleSessionPhase | null;
  generation: PvpGeneration | null;
  rulesetKey: RulesetKey | null;
  yourSeat: RoomSeat | null;
  turn: number | null;
  visibleState: ViewerVisibleState | null;
  pendingRequest: PvpPendingRequest | null;
  pendingCommand: PendingCommandState | null;
  lastRejectedCommand: BattleCommandRejectedPayload | null;
  lastResolvedTurn: number | null;
  terminalResult: BattleEndedPayload | null;
  lastServerSeq: number;
  lastEventType: BattleServerEventEnvelope['type'] | null;
  lastEventAt: string | null;
  nextClientSeq: number;
  resyncCount: number;
}

export interface CreateBattleCommandEnvelopeOptions {
  clientCommandId: string;
  sentAt: string;
  command: BattleCommand;
}

export interface CreatedBattleCommandEnvelope {
  state: PvpSessionState;
  envelope: BattleCommandEnvelope;
}

const TERMINAL_PHASES = new Set<BattleSessionPhase>(['finished', 'abandoned']);

function clonePendingRequest(request: PvpPendingRequest | null): PvpPendingRequest | null {
  if (!request) {
    return null;
  }

  if (request.kind === 'choose_move_or_switch') {
    return {
      ...request,
      activePokemon: request.activePokemon ? { ...request.activePokemon } : undefined,
      availableMoves: request.availableMoves?.map((move) => ({ ...move })),
      availableSwitches: request.availableSwitches?.map((slot) => ({ ...slot })),
    };
  }

  return {
    ...request,
    availableReplacements: request.availableReplacements?.map((slot) => ({ ...slot })),
  };
}

function fromSnapshotPendingRequest(payload: RoomSnapshotPayload): PvpPendingRequest | null {
  const request = payload.pendingRequest;

  if (!request) {
    return null;
  }

  if (request.kind === 'choose_move_or_switch') {
    return {
      kind: request.kind,
      phase: 'awaiting_actions',
      turn: payload.turn,
      deadlineMs: request.deadlineMs,
      commandSubmitted: request.commandSubmitted,
      requestId: null,
    };
  }

  return {
    kind: request.kind,
    phase: 'awaiting_replacement',
    turn: payload.turn,
    deadlineMs: request.deadlineMs,
    commandSubmitted: request.commandSubmitted,
    requestId: null,
    faintedSlot: null,
  };
}

function fromActionRequest(payload: BattleActionRequestPayload): PendingActionRequest {
  return {
    kind: 'choose_move_or_switch',
    phase: 'awaiting_actions',
    turn: payload.turn,
    deadlineMs: payload.deadlineMs,
    commandSubmitted: false,
    requestId: payload.requestId,
    activePokemon: { ...payload.request.activePokemon },
    availableMoves: payload.request.availableMoves.map((move) => ({ ...move })),
    availableSwitches: payload.request.availableSwitches.map((slot) => ({ ...slot })),
  };
}

function fromReplacementRequest(payload: BattleReplacementRequestPayload): PendingReplacementRequest {
  return {
    kind: 'choose_replacement',
    phase: 'awaiting_replacement',
    turn: payload.turn,
    deadlineMs: payload.deadlineMs,
    commandSubmitted: false,
    requestId: payload.requestId,
    faintedSlot: payload.faintedSlot,
    availableReplacements: payload.availableReplacements.map((slot) => ({ ...slot })),
  };
}

function syncServerEnvelopeMeta(
  state: PvpSessionState,
  event: BattleServerEventEnvelope,
): Pick<PvpSessionState, 'roomId' | 'battleId' | 'lastServerSeq' | 'lastEventType' | 'lastEventAt'> {
  return {
    roomId: event.roomId,
    battleId: event.battleId,
    lastServerSeq: event.seq,
    lastEventType: event.type,
    lastEventAt: event.sentAt,
  };
}

function setPendingRequestCommandSubmitted(
  request: PvpPendingRequest | null,
  commandSubmitted: boolean,
): PvpPendingRequest | null {
  if (!request) {
    return null;
  }

  if (request.kind === 'choose_move_or_switch') {
    return {
      ...request,
      activePokemon: request.activePokemon ? { ...request.activePokemon } : undefined,
      availableMoves: request.availableMoves?.map((move) => ({ ...move })),
      availableSwitches: request.availableSwitches?.map((slot) => ({ ...slot })),
      commandSubmitted,
    };
  }

  return {
    ...request,
    availableReplacements: request.availableReplacements?.map((slot) => ({ ...slot })),
    commandSubmitted,
  };
}

function assertCanCreateCommand(state: PvpSessionState): asserts state is PvpSessionState & {
  roomId: string;
  battleId: string;
  pendingRequest: PvpPendingRequest;
} {
  if (!state.roomId || !state.battleId) {
    throw new Error('Cannot build battle command envelope without active room and battle ids.');
  }

  if (!state.pendingRequest || TERMINAL_PHASES.has(state.battleStatus ?? 'finished')) {
    throw new Error('Cannot build battle command envelope without a current pending request.');
  }

  if (isCommandLocked(state)) {
    throw new Error('Cannot build battle command envelope while command input is locked.');
  }
}

function validateActionCommand(request: PendingActionRequest, command: BattleCommand): void {
  if (command.type === 'forfeit') {
    return;
  }

  if (command.type === 'choose_replacement') {
    throw new Error('Command is incompatible with the current pending request.');
  }

  if (command.type === 'choose_move' && request.availableMoves) {
    const move = request.availableMoves.find((entry) => entry.slot === command.moveSlot);
    if (!move || move.disabled) {
      throw new Error(`Move slot ${command.moveSlot} is not valid for the current pending request.`);
    }
  }

  if (command.type === 'choose_switch' && request.availableSwitches) {
    const target = request.availableSwitches.find((entry) => entry.slot === command.targetSlot);
    if (!target || target.fainted) {
      throw new Error(`Switch slot ${command.targetSlot} is not valid for the current pending request.`);
    }
  }
}

function validateReplacementCommand(request: PendingReplacementRequest, command: BattleCommand): void {
  if (command.type === 'forfeit') {
    return;
  }

  if (command.type !== 'choose_replacement') {
    throw new Error('Command is incompatible with the current pending request.');
  }

  if (request.availableReplacements) {
    const target = request.availableReplacements.find((entry) => entry.slot === command.targetSlot);
    if (!target || target.fainted) {
      throw new Error(`Replacement slot ${command.targetSlot} is not valid for the current pending request.`);
    }
  }
}

export function createPvpSessionState(): PvpSessionState {
  return {
    roomId: null,
    battleId: null,
    roomStatus: null,
    battleStatus: null,
    generation: null,
    rulesetKey: null,
    yourSeat: null,
    turn: null,
    visibleState: null,
    pendingRequest: null,
    pendingCommand: null,
    lastRejectedCommand: null,
    lastResolvedTurn: null,
    terminalResult: null,
    lastServerSeq: 0,
    lastEventType: null,
    lastEventAt: null,
    nextClientSeq: 1,
    resyncCount: 0,
  };
}

export function hasPendingAction(state: PvpSessionState): boolean {
  return state.pendingRequest !== null && !TERMINAL_PHASES.has(state.battleStatus ?? 'finished');
}

export function isCommandLocked(state: PvpSessionState): boolean {
  return Boolean(state.pendingCommand) || state.pendingRequest?.commandSubmitted === true;
}

export function applyPvpServerEvent(
  state: PvpSessionState,
  event: BattleServerEventEnvelope,
): PvpSessionState {
  const envelopeMeta = syncServerEnvelopeMeta(state, event);

  switch (event.type) {
    case 'room.snapshot': {
      const clearedTransient = state.pendingCommand !== null || state.lastRejectedCommand !== null;
      return {
        ...state,
        ...envelopeMeta,
        roomStatus: event.payload.roomStatus,
        battleStatus: event.payload.battleStatus,
        generation: event.payload.generation,
        rulesetKey: event.payload.rulesetKey,
        yourSeat: event.payload.yourSeat,
        turn: event.payload.turn,
        visibleState: structuredClone(event.payload.visibleState),
        pendingRequest: fromSnapshotPendingRequest(event.payload),
        pendingCommand: null,
        lastRejectedCommand: null,
        lastResolvedTurn: state.lastResolvedTurn,
        terminalResult: TERMINAL_PHASES.has(event.payload.battleStatus) ? state.terminalResult : null,
        resyncCount: clearedTransient ? state.resyncCount + 1 : state.resyncCount,
      };
    }

    case 'battle.request_action':
      return {
        ...state,
        ...envelopeMeta,
        battleStatus: 'awaiting_actions',
        turn: event.payload.turn,
        pendingRequest: fromActionRequest(event.payload),
        pendingCommand: null,
        lastRejectedCommand: null,
        terminalResult: null,
      };

    case 'battle.command_accepted': {
      const pendingRequest = setPendingRequestCommandSubmitted(state.pendingRequest, true);

      const pendingCommand = state.pendingCommand
        && state.pendingCommand.clientCommandId === event.payload.clientCommandId
        ? {
            ...state.pendingCommand,
            status: 'accepted' as const,
            lockedIn: event.payload.lockedIn,
          }
        : state.pendingCommand;

      return {
        ...state,
        ...envelopeMeta,
        pendingRequest,
        pendingCommand,
        lastRejectedCommand: null,
      };
    }

    case 'battle.command_rejected': {
      const retryable = event.payload.retryable;
      const pendingRequest = setPendingRequestCommandSubmitted(
        state.pendingRequest,
        retryable ? false : state.pendingRequest?.commandSubmitted ?? false,
      );

      const pendingCommand = retryable
        ? null
        : state.pendingCommand
          && state.pendingCommand.clientCommandId === event.payload.clientCommandId
          ? {
              ...state.pendingCommand,
              status: 'rejected_permanent' as const,
              lockedIn: true,
            }
          : state.pendingCommand;

      return {
        ...state,
        ...envelopeMeta,
        pendingRequest,
        pendingCommand,
        lastRejectedCommand: { ...event.payload },
      };
    }

    case 'battle.turn_resolved':
      return {
        ...state,
        ...envelopeMeta,
        battleStatus: event.payload.nextPhase,
        turn: event.payload.turn,
        visibleState: structuredClone(event.payload.postTurnVisibleState),
        pendingRequest: null,
        pendingCommand: null,
        lastRejectedCommand: null,
        lastResolvedTurn: event.payload.turn,
        terminalResult: event.payload.nextPhase === 'finished' ? state.terminalResult : null,
      };

    case 'battle.force_replacement':
      return {
        ...state,
        ...envelopeMeta,
        battleStatus: 'awaiting_replacement',
        turn: event.payload.turn,
        pendingRequest: fromReplacementRequest(event.payload),
        pendingCommand: null,
        lastRejectedCommand: null,
        terminalResult: null,
      };

    case 'battle.ended':
      return {
        ...state,
        ...envelopeMeta,
        battleStatus: 'finished',
        pendingRequest: null,
        pendingCommand: null,
        lastRejectedCommand: null,
        terminalResult: { ...event.payload },
      };
  }
}

export function createBattleCommandEnvelope(
  state: PvpSessionState,
  options: CreateBattleCommandEnvelopeOptions,
): CreatedBattleCommandEnvelope {
  assertCanCreateCommand(state);

  if (state.pendingRequest.kind === 'choose_move_or_switch') {
    validateActionCommand(state.pendingRequest, options.command);
  } else {
    validateReplacementCommand(state.pendingRequest, options.command);
  }

  const envelope: BattleCommandEnvelope = {
    type: 'battle.command',
    roomId: state.roomId,
    battleId: state.battleId,
    seq: state.nextClientSeq,
    sentAt: options.sentAt,
    payload: {
      clientCommandId: options.clientCommandId,
      turn: state.pendingRequest.turn,
      phase: state.pendingRequest.phase,
      command: structuredClone(options.command),
    },
  };

  const nextState: PvpSessionState = {
    ...state,
    nextClientSeq: state.nextClientSeq + 1,
    pendingCommand: {
      clientCommandId: options.clientCommandId,
      turn: state.pendingRequest.turn,
      phase: state.pendingRequest.phase,
      command: structuredClone(options.command),
      seq: envelope.seq,
      sentAt: options.sentAt,
      status: 'created',
      lockedIn: false,
    },
    lastRejectedCommand: null,
  };

  return {
    state: nextState,
    envelope,
  };
}
