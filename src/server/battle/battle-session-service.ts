import type { RoomSeat } from '../rooms/index.js';
import { buildRoomSnapshotPayload } from '../projection/battle-projection.js';
import {
  buildSeatRuntimeState,
  createAuthoritativeBattleState,
} from './battle-engine-adapter.js';
import { validateBattleCommand } from './battle-command-service.js';
import {
  createActionRequestPayload,
  createReplacementRequestPayload,
  projectEventsForViewer,
} from './battle-event-log.js';
import {
  createEndedPayloadResult,
  resolveForfeit,
  resolveSubmittedActions,
  resolveSubmittedReplacements,
} from './battle-turn-service.js';
import type {
  BattleCommandEnvelope,
  BattleCommandPhase,
  BattleCommandRejectionCode,
  BattleCommandSource,
  BattleDataResolver,
  BattleFinishReason,
  BattleLoggedEvent,
  BattleRequestKind,
  BattleRequestState,
  BattleServerEventEnvelope,
  BattleSessionCreateInput,
  BattleSessionMutationResult,
  BattleSessionRecord,
  BattleSessionSubmitInput,
  BattleSessionResult,
} from './battle-types.js';

export interface BattleSessionServiceOptions {
  dataResolver: BattleDataResolver;
  now?: () => Date;
  battleIdGenerator?: () => string;
}

const SEATS: RoomSeat[] = ['host', 'guest'];

export class BattleSessionService {
  private readonly dataResolver: BattleDataResolver;
  private readonly now: () => Date;
  private readonly battleIdGenerator: () => string;

  constructor(options: BattleSessionServiceOptions) {
    this.dataResolver = options.dataResolver;
    this.now = options.now ?? (() => new Date());
    this.battleIdGenerator = options.battleIdGenerator ?? (() => `battle_${crypto.randomUUID()}`);
  }

  createSession(input: BattleSessionCreateInput): BattleSessionMutationResult {
    const createdAt = this.now().toISOString();
    const roomSnapshot = {
      ...input.room,
      room: {
        ...input.room.room,
        status: 'in_progress' as const,
      },
    };

    const session: BattleSessionRecord = {
      roomId: input.room.room.roomId,
      battleId: this.battleIdGenerator(),
      generation: input.room.room.generation,
      rulesetKey: input.room.room.rulesetKey,
      phase: 'awaiting_actions',
      turn: 1,
      roomStatus: 'in_progress',
      rulesetSnapshot: input.room.rulesetSnapshot,
      roomSnapshot,
      battleState: createAuthoritativeBattleState({
        generation: input.room.room.generation,
        hostParty: input.hostParty,
        guestParty: input.guestParty,
        dataResolver: this.dataResolver,
      }),
      seatState: {
        host: buildSeatRuntimeState(input.hostParty),
        guest: buildSeatRuntimeState(input.guestParty),
      },
      pendingCommands: {},
      pendingReplacementSeats: [],
      pendingReplacementCommands: {},
      requestState: null,
      timeoutState: {
        host: { consecutive: 0, total: 0, lastTimeoutAt: null },
        guest: { consecutive: 0, total: 0, lastTimeoutAt: null },
      },
      commandLog: [],
      eventLog: [],
      seenClientCommandIds: [],
      nextSeq: 1,
      result: null,
      createdAt,
      updatedAt: createdAt,
    };

    this.issueRequestState(session, {
      kind: 'choose_move_or_switch',
      phase: 'awaiting_actions',
      turn: session.turn,
      requiredSeats: SEATS,
      issuedAt: createdAt,
    });

    const eventsBySeat = this.createEmptySeatEventMap();
    const sentAt = createdAt;
    for (const seat of SEATS) {
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'room.snapshot',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: buildRoomSnapshotPayload(session, seat, new Date(sentAt)),
      });
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.request_action',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: createActionRequestPayload(session, seat),
      });
    }
    session.updatedAt = sentAt;

    return { session, eventsBySeat };
  }

  submitCommand(input: BattleSessionSubmitInput): BattleSessionMutationResult {
    const { session, seat, envelope } = input;
    const source = input.source ?? 'client';
    const now = this.now();
    const eventsBySeat = this.createEmptySeatEventMap();
    const validation = validateBattleCommand({ session, seat, envelope, now, source });
    if (!validation.ok) {
      const sentAt = now.toISOString();
      this.recordCommand(session, {
        seat,
        envelope,
        source,
        accepted: false,
        code: validation.code,
        recordedAt: sentAt,
      });
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.command_rejected',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: {
          clientCommandId: envelope.payload.clientCommandId,
          code: validation.code,
          message: validation.message,
          retryable: validation.retryable,
        },
      });
      session.updatedAt = sentAt;
      return { session, eventsBySeat };
    }

    session.seenClientCommandIds.push(envelope.payload.clientCommandId);

    const acceptedAt = now.toISOString();
    this.recordCommand(session, {
      seat,
      envelope,
      source,
      accepted: true,
      code: null,
      recordedAt: acceptedAt,
    });
    if (source === 'client') {
      session.timeoutState[seat].consecutive = 0;
    }

    this.pushEvent(session, eventsBySeat, seat, {
      type: 'battle.command_accepted',
      roomId: session.roomId,
      battleId: session.battleId,
      seq: this.nextSeq(session),
      sentAt: acceptedAt,
      payload: {
        clientCommandId: envelope.payload.clientCommandId,
        turn: envelope.payload.turn,
        phase: envelope.payload.phase,
        lockedIn: true,
      },
    });
    session.updatedAt = acceptedAt;

    if (envelope.payload.command.type === 'forfeit') {
      const resolvedAt = this.now().toISOString();
      const resolution = resolveForfeit({
        session,
        forfeitingSeat: seat,
        recordedAt: resolvedAt,
      });
      this.clearPendingRequestState(session);
      this.emitResolutionEvents(eventsBySeat, session, resolution.events, resolution.nextPhase, resolvedAt);
      const finishedAt = this.now().toISOString();
      if (session.result) {
        session.result.recordedAt = finishedAt;
      }
      this.emitBattleEnded(eventsBySeat, session, finishedAt);
      session.updatedAt = finishedAt;
      return { session, eventsBySeat };
    }

    if (session.phase === 'awaiting_actions') {
      session.pendingCommands[seat] = envelope.payload;
      if (session.pendingCommands.host && session.pendingCommands.guest) {
        const resolvedAt = this.now().toISOString();
        const resolution = resolveSubmittedActions({
          session,
          commands: {
            host: session.pendingCommands.host.command,
            guest: session.pendingCommands.guest.command,
          },
          recordedAt: resolvedAt,
        });
        session.pendingCommands = {};
        this.transitionRequestState(session, resolution.nextPhase, resolvedAt);
        this.emitResolutionEvents(eventsBySeat, session, resolution.events, resolution.nextPhase, resolvedAt);
        if (resolution.nextPhase === 'awaiting_actions') {
          this.emitActionRequests(eventsBySeat, session, resolvedAt);
        } else if (resolution.nextPhase === 'awaiting_replacement') {
          this.emitReplacementRequests(eventsBySeat, session, resolvedAt);
        } else {
          this.emitBattleEnded(eventsBySeat, session, resolvedAt);
        }
        session.updatedAt = resolvedAt;
      }
      return { session, eventsBySeat };
    }

    session.pendingReplacementCommands[seat] = envelope.payload;
    const readyToResolve = session.pendingReplacementSeats.every(
      (requiredSeat) => session.pendingReplacementCommands[requiredSeat]?.command.type === 'choose_replacement',
    );

    if (readyToResolve) {
      const resolvedAt = this.now().toISOString();
      const replacementSlots: Partial<Record<RoomSeat, number>> = {};
      for (const requiredSeat of session.pendingReplacementSeats) {
        const payload = session.pendingReplacementCommands[requiredSeat];
        if (payload?.command.type === 'choose_replacement') {
          replacementSlots[requiredSeat] = payload.command.targetSlot;
        }
      }
      const resolution = resolveSubmittedReplacements({
        session,
        replacementSlots,
        recordedAt: resolvedAt,
      });
      session.pendingReplacementCommands = {};
      this.transitionRequestState(session, resolution.nextPhase, resolvedAt);
      this.emitResolutionEvents(eventsBySeat, session, resolution.events, resolution.nextPhase, resolvedAt);
      if (resolution.nextPhase === 'awaiting_actions') {
        this.emitActionRequests(eventsBySeat, session, resolvedAt);
      } else {
        this.emitBattleEnded(eventsBySeat, session, resolvedAt);
      }
      session.updatedAt = resolvedAt;
    }

    return { session, eventsBySeat };
  }

  submitTimeoutForfeit(args: { session: BattleSessionRecord; loserSeat: RoomSeat }): BattleSessionMutationResult {
    const { session, loserSeat } = args;
    const finishedAt = this.now().toISOString();
    const winnerSeat: RoomSeat = loserSeat === 'host' ? 'guest' : 'host';
    session.phase = 'finished';
    session.result = {
      winnerSeat,
      loserSeat,
      reason: 'timeout_forfeit',
      recordedAt: finishedAt,
    };
    this.clearPendingRequestState(session);

    const eventsBySeat = this.createEmptySeatEventMap();
    this.emitBattleEnded(eventsBySeat, session, finishedAt);
    session.updatedAt = finishedAt;
    return { session, eventsBySeat };
  }

  private issueRequestState(
    session: BattleSessionRecord,
    args: {
      kind: BattleRequestKind;
      phase: BattleCommandPhase;
      turn: number;
      requiredSeats: RoomSeat[];
      issuedAt: string;
    },
  ): void {
    const { kind, phase, turn, requiredSeats, issuedAt } = args;
    session.requestState = {
      kind,
      phase,
      turn,
      issuedAt,
      deadlineAt: new Date(new Date(issuedAt).getTime() + this.getRequestTimeoutMs(session)).toISOString(),
      requiredSeats: [...requiredSeats],
    };
  }

  private transitionRequestState(
    session: BattleSessionRecord,
    nextPhase: 'awaiting_actions' | 'awaiting_replacement' | 'finished',
    issuedAt: string,
  ): void {
    if (nextPhase === 'awaiting_actions') {
      this.issueRequestState(session, {
        kind: 'choose_move_or_switch',
        phase: 'awaiting_actions',
        turn: session.turn,
        requiredSeats: SEATS,
        issuedAt,
      });
      return;
    }

    if (nextPhase === 'awaiting_replacement') {
      this.issueRequestState(session, {
        kind: 'choose_replacement',
        phase: 'awaiting_replacement',
        turn: session.turn,
        requiredSeats: [...session.pendingReplacementSeats],
        issuedAt,
      });
      return;
    }

    this.clearPendingRequestState(session);
  }

  private clearPendingRequestState(session: BattleSessionRecord): void {
    session.pendingCommands = {};
    session.pendingReplacementCommands = {};
    session.pendingReplacementSeats = [];
    session.requestState = null;
  }

  private getRequestTimeoutMs(session: BattleSessionRecord): number {
    return session.rulesetSnapshot.battlePolicy.actionTimeoutSeconds * 1000;
  }

  private recordCommand(
    session: BattleSessionRecord,
    args: {
      seat: RoomSeat;
      envelope: BattleCommandEnvelope;
      source: BattleCommandSource;
      accepted: boolean;
      code: BattleCommandRejectionCode | null;
      recordedAt: string;
    },
  ): void {
    const { seat, envelope, source, accepted, code, recordedAt } = args;
    session.commandLog.push({
      clientCommandId: envelope.payload.clientCommandId,
      seat,
      turn: envelope.payload.turn,
      phase: envelope.payload.phase,
      command: structuredClone(envelope.payload.command),
      source,
      accepted,
      code,
      recordedAt,
    });
  }

  private emitResolutionEvents(
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    session: BattleSessionRecord,
    events: BattleLoggedEvent[],
    nextPhase: 'awaiting_actions' | 'awaiting_replacement' | 'finished',
    sentAt: string,
  ) {
    const resolvedTurn = nextPhase === 'awaiting_actions' && session.phase === 'awaiting_actions'
      ? session.turn - 1
      : session.turn;

    for (const seat of SEATS) {
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.turn_resolved',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: {
          turn: resolvedTurn,
          events: projectEventsForViewer(seat, events),
          postTurnVisibleState: buildRoomSnapshotPayload(session, seat, new Date(sentAt)).visibleState,
          nextPhase,
        },
      });
    }
  }

  private emitActionRequests(
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    session: BattleSessionRecord,
    sentAt: string,
  ) {
    for (const seat of SEATS) {
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.request_action',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: createActionRequestPayload(session, seat),
      });
    }
  }

  private emitReplacementRequests(
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    session: BattleSessionRecord,
    sentAt: string,
  ) {
    for (const seat of session.pendingReplacementSeats) {
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.force_replacement',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: createReplacementRequestPayload(session, seat),
      });
    }
  }

  private emitBattleEnded(
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    session: BattleSessionRecord,
    sentAt: string,
  ) {
    for (const seat of SEATS) {
      this.pushEvent(session, eventsBySeat, seat, {
        type: 'battle.ended',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: createEndedPayloadResult(session, seat),
      });
    }
  }

  private createEmptySeatEventMap(): Record<RoomSeat, BattleServerEventEnvelope[]> {
    return {
      host: [],
      guest: [],
    };
  }

  private pushEvent(
    session: BattleSessionRecord,
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    seat: RoomSeat,
    event: BattleServerEventEnvelope,
  ): void {
    eventsBySeat[seat].push(event);
    session.eventLog.push({
      seat,
      type: event.type,
      seq: event.seq,
      sentAt: event.sentAt,
    });
  }

  private nextSeq(session: BattleSessionRecord): number {
    const current = session.nextSeq;
    session.nextSeq += 1;
    return current;
  }
}
