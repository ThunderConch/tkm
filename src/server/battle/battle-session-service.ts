import type { RoomSeat } from '../rooms/index.js';
import {
  buildSeatRuntimeState,
  createAuthoritativeBattleState,
} from './battle-engine-adapter.js';
import { validateBattleCommand } from './battle-command-service.js';
import {
  createActionRequestPayload,
  createReplacementRequestPayload,
  createViewerVisibleState,
  projectEventsForViewer,
} from './battle-event-log.js';
import {
  createEndedPayloadResult,
  resolveForfeit,
  resolveSubmittedActions,
  resolveSubmittedReplacements,
} from './battle-turn-service.js';
import type {
  BattleLoggedEvent,
  BattleCommandEnvelope,
  BattleCommandPhase,
  BattleDataResolver,
  BattleServerEventEnvelope,
  BattleSessionCreateInput,
  BattleSessionMutationResult,
  BattleSessionRecord,
  BattleSessionSubmitInput,
} from './battle-types.js';

export interface BattleSessionServiceOptions {
  dataResolver: BattleDataResolver;
  now?: () => Date;
  battleIdGenerator?: () => string;
}

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
      seenClientCommandIds: [],
      nextSeq: 1,
      result: null,
      createdAt,
      updatedAt: createdAt,
    };

    const sentAt = this.now().toISOString();
    const eventsBySeat = this.createEmptySeatEventMap();
    for (const seat of ['host', 'guest'] as const) {
      this.pushEvent(eventsBySeat, seat, {
        type: 'room.snapshot',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: {
          roomStatus: session.roomStatus,
          battleStatus: session.phase,
          generation: session.generation,
          rulesetKey: session.rulesetKey,
          yourSeat: seat,
          turn: session.turn,
          visibleState: createViewerVisibleState(session, seat),
          pendingRequest: {
            kind: 'choose_move_or_switch',
            deadlineMs: session.rulesetSnapshot.battlePolicy.actionTimeoutSeconds * 1000,
          },
        },
      });
      this.pushEvent(eventsBySeat, seat, {
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
    const eventsBySeat = this.createEmptySeatEventMap();
    const validation = validateBattleCommand({ session, seat, envelope });
    if (!validation.ok) {
      const sentAt = this.now().toISOString();
      this.pushEvent(eventsBySeat, seat, {
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

    const acceptedAt = this.now().toISOString();
    this.pushEvent(eventsBySeat, seat, {
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
      const finishedAt = this.now().toISOString();
      const resolution = resolveForfeit({
        session,
        forfeitingSeat: seat,
        recordedAt: finishedAt,
      });
      this.emitResolutionEvents(eventsBySeat, session, resolution.events, resolution.nextPhase, finishedAt);
      this.emitBattleEnded(eventsBySeat, session, finishedAt);
      session.pendingCommands = {};
      session.pendingReplacementCommands = {};
      session.pendingReplacementSeats = [];
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

  private emitResolutionEvents(
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    session: BattleSessionRecord,
    events: BattleLoggedEvent[],
    nextPhase: 'awaiting_actions' | 'awaiting_replacement' | 'finished',
    sentAt: string,
  ) {
    for (const seat of ['host', 'guest'] as const) {
      this.pushEvent(eventsBySeat, seat, {
        type: 'battle.turn_resolved',
        roomId: session.roomId,
        battleId: session.battleId,
        seq: this.nextSeq(session),
        sentAt,
        payload: {
          turn: nextPhase === 'awaiting_actions' && session.phase === 'awaiting_actions' ? session.turn - 1 : session.turn,
          events: projectEventsForViewer(seat, events),
          postTurnVisibleState: createViewerVisibleState(session, seat),
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
    for (const seat of ['host', 'guest'] as const) {
      this.pushEvent(eventsBySeat, seat, {
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
      this.pushEvent(eventsBySeat, seat, {
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
    for (const seat of ['host', 'guest'] as const) {
      this.pushEvent(eventsBySeat, seat, {
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
    eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>,
    seat: RoomSeat,
    event: BattleServerEventEnvelope,
  ): void {
    eventsBySeat[seat].push(event);
  }

  private nextSeq(session: BattleSessionRecord): number {
    const current = session.nextSeq;
    session.nextSeq += 1;
    return current;
  }
}
