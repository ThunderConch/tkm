import { createHash, randomBytes } from 'node:crypto';

import {
  PartyRegistrationService,
  PartyRegistrationServiceError,
  type ActivePartySnapshot,
} from '../parties/index.js';
import { getRulesetByGeneration, type RulesetSummary } from '../rules/index.js';
import { createRoomCode, normalizeRoomCode } from './room-code.js';
import { InMemoryRoomRepository, type RoomRepository } from './room-repository.js';
import type {
  BattleFreezeSnapshot,
  BattleRoomRecord,
  CreateRoomInput,
  JoinRoomInput,
  RoomPlayerBinding,
} from './room-types.js';
import {
  type RoomValidationFailure,
  validateCreateBindingAvailability,
  validateGuestRuleset,
  validateJoinGeneration,
  validateJoinRequestCode,
  validateJoinRoomState,
  validatePartyAccepted,
  validateRequestedRuleset,
  validateRequestedVisibility,
  validateSelfJoin,
} from './room-validator.js';

const DEFAULT_ROOM_TTL_MS = 15 * 60 * 1000;
const MAX_ROOM_CODE_ATTEMPTS = 32;

export interface RoomServiceOptions {
  repository?: RoomRepository;
  partyService?: PartyRegistrationService;
  now?: () => Date;
  roomCodeGenerator?: () => string;
  battleSeedGenerator?: () => string;
  roomTtlMs?: number;
}

interface ServiceErrorOptions {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function cloneRoom(room: BattleRoomRecord): BattleRoomRecord {
  return structuredClone(room);
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function withAddedMs(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function createRulesetHash(ruleset: RulesetSummary): string {
  return `sha256:${createHash('sha256').update(stableStringify(ruleset)).digest('hex')}`;
}

function createDefaultBattleSeed(): string {
  return `bseed_${randomBytes(8).toString('hex')}`;
}

function createRoomBinding(seat: RoomPlayerBinding['seat'], party: ActivePartySnapshot, joinedAt: string): RoomPlayerBinding {
  return {
    seat,
    userId: party.playerId,
    partySnapshotId: party.snapshotId,
    partySnapshotVersion: party.snapshotVersion,
    partyValidationStatus: party.validationStatus,
    presence: 'offline',
    joinedAt,
    battleReady: false,
  };
}

function throwFailure(failure: RoomValidationFailure): never {
  throw new RoomServiceError(failure);
}

export class RoomServiceError extends Error {
  readonly status: number;

  readonly code: string;

  readonly retryable: boolean;

  readonly details?: Record<string, unknown>;

  constructor(options: ServiceErrorOptions) {
    super(options.message);
    this.name = 'RoomServiceError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

export class RoomService {
  private readonly repository: RoomRepository;

  private readonly partyService: PartyRegistrationService;

  private readonly now: () => Date;

  private readonly roomCodeGenerator: () => string;

  private readonly battleSeedGenerator: () => string;

  private readonly roomTtlMs: number;

  constructor(options: RoomServiceOptions = {}) {
    this.repository = options.repository ?? new InMemoryRoomRepository();
    this.partyService = options.partyService ?? new PartyRegistrationService();
    this.now = options.now ?? (() => new Date());
    this.roomCodeGenerator = options.roomCodeGenerator ?? (() => createRoomCode());
    this.battleSeedGenerator = options.battleSeedGenerator ?? createDefaultBattleSeed;
    this.roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  }

  getRoom(roomId: string): BattleRoomRecord {
    const room = this.repository.getRoom(roomId);
    if (!room) {
      throw new RoomServiceError({
        status: 404,
        code: 'PVP_ROOM_NOT_FOUND',
        message: 'The requested PvP room does not exist.',
        retryable: false,
        details: { roomId },
      });
    }

    return cloneRoom(room);
  }

  createRoom(input: CreateRoomInput): BattleRoomRecord {
    const ruleset = this.resolveRuleset(input.generation);
    const visibilityFailure = validateRequestedVisibility(input.visibility);
    if (visibilityFailure) {
      throwFailure(visibilityFailure);
    }

    const requestedRulesetFailure = validateRequestedRuleset(input.rulesetKey, ruleset);
    if (requestedRulesetFailure) {
      throwFailure(requestedRulesetFailure);
    }

    const alreadyBoundRoom = this.repository.findActiveRoomByPlayerId(input.playerId);
    const bindingFailure = validateCreateBindingAvailability(input.playerId, alreadyBoundRoom);
    if (bindingFailure) {
      throwFailure(bindingFailure);
    }

    const activeParty = this.getBindableActiveParty({
      playerId: input.playerId,
      generation: ruleset.generation,
      missingPartyCode: 'PVP_PARTY_NOT_REGISTERED',
      missingPartyMessage: 'Register an active online party before creating a PvP room.',
      mismatchCode: 'PVP_RULESET_MISMATCH',
      mismatchMessage: 'The active online party does not match the current PvP ruleset.',
      details: { generation: ruleset.generation },
    });

    const partyAcceptedFailure = validatePartyAccepted(activeParty, {
      generation: ruleset.generation,
      snapshotId: activeParty.snapshotId,
    });
    if (partyAcceptedFailure) {
      throwFailure(partyAcceptedFailure);
    }

    const createdAt = this.now();
    const createdAtIso = toIsoString(createdAt);
    const expiresAtIso = toIsoString(withAddedMs(createdAt, this.roomTtlMs));
    const roomCode = this.createUniqueRoomCode();
    const roomId = this.repository.createRoomId();
    const hostBinding = createRoomBinding('host', activeParty, createdAtIso);
    const room: BattleRoomRecord = {
      room: {
        roomId,
        roomCode,
        mode: 'friendly_private',
        visibility: 'private_friend',
        status: 'waiting_for_opponent',
        generation: ruleset.generation,
        rulesetKey: ruleset.rulesetKey,
        createdByUserId: input.playerId,
        createdAt: createdAtIso,
        expiresAt: expiresAtIso,
        startedAt: null,
        finishedAt: null,
        cancelledAt: null,
      },
      host: hostBinding,
      guest: null,
      rulesetSnapshot: structuredClone(ruleset),
      battleFreeze: null,
    };

    this.repository.saveRoom(room);
    return cloneRoom(room);
  }

  joinRoom(input: JoinRoomInput): BattleRoomRecord {
    const room = this.repository.getRoom(input.roomId);
    if (!room) {
      throw new RoomServiceError({
        status: 404,
        code: 'PVP_ROOM_NOT_FOUND',
        message: 'The requested PvP room does not exist.',
        retryable: false,
        details: { roomId: input.roomId },
      });
    }

    const stateFailure = validateJoinRoomState(room);
    if (stateFailure) {
      throwFailure(stateFailure);
    }

    const normalizedRoomCode = normalizeRoomCode(input.roomCode);
    const roomCodeFailure = validateJoinRequestCode(room, normalizedRoomCode);
    if (roomCodeFailure) {
      throwFailure(roomCodeFailure);
    }

    const generationFailure = validateJoinGeneration(room, input.generation);
    if (generationFailure) {
      throwFailure(generationFailure);
    }

    const selfJoinFailure = validateSelfJoin(room, input.playerId);
    if (selfJoinFailure) {
      throwFailure(selfJoinFailure);
    }

    const alreadyBoundRoom = this.repository.findActiveRoomByPlayerId(input.playerId);
    if (alreadyBoundRoom && alreadyBoundRoom.room.roomId !== room.room.roomId) {
      const bindingFailure = validateCreateBindingAvailability(input.playerId, alreadyBoundRoom);
      if (bindingFailure) {
        throwFailure(bindingFailure);
      }
    }

    const activeParty = this.getBindableActiveParty({
      playerId: input.playerId,
      generation: room.room.generation,
      missingPartyCode: 'PVP_PARTY_NOT_REGISTERED',
      missingPartyMessage: 'Register an active online party before joining a PvP room.',
      mismatchCode: 'PVP_ROOM_RULESET_MISMATCH',
      mismatchMessage: 'The active online party does not match the PvP room ruleset.',
      details: {
        roomId: room.room.roomId,
        generation: room.room.generation,
        roomRulesetKey: room.room.rulesetKey,
      },
    });

    const guestRulesetFailure = validateGuestRuleset(room, activeParty);
    if (guestRulesetFailure) {
      throwFailure(guestRulesetFailure);
    }

    const partyAcceptedFailure = validatePartyAccepted(activeParty, {
      roomId: room.room.roomId,
      generation: room.room.generation,
      snapshotId: activeParty.snapshotId,
    });
    if (partyAcceptedFailure) {
      throwFailure(partyAcceptedFailure);
    }

    const joinedAt = toIsoString(this.now());
    const guestBinding = createRoomBinding('guest', activeParty, joinedAt);
    const battleFreeze = this.prepareBattleFreeze(room, activeParty, joinedAt);
    const nextRoom: BattleRoomRecord = {
      ...room,
      room: {
        ...room.room,
        status: 'awaiting_presence',
        expiresAt: null,
      },
      host: {
        ...room.host,
        battleReady: true,
      },
      guest: {
        ...guestBinding,
        battleReady: true,
      },
      battleFreeze,
    };

    this.repository.saveRoom(nextRoom);
    return cloneRoom(nextRoom);
  }

  private getBindableActiveParty(options: {
    playerId: string;
    generation: string;
    missingPartyCode: string;
    missingPartyMessage: string;
    mismatchCode: string;
    mismatchMessage: string;
    details: Record<string, unknown>;
  }): ActivePartySnapshot {
    try {
      return this.partyService.getActiveParty({
        playerId: options.playerId,
        generation: options.generation,
      });
    } catch (error: unknown) {
      if (!(error instanceof PartyRegistrationServiceError)) {
        throw error;
      }

      if (error.code === 'PVP_ACTIVE_PARTY_NOT_FOUND') {
        throw new RoomServiceError({
          status: 404,
          code: options.missingPartyCode,
          message: options.missingPartyMessage,
          retryable: false,
          details: options.details,
        });
      }

      if (error.code === 'PVP_RULESET_MISMATCH') {
        throw new RoomServiceError({
          status: 409,
          code: options.mismatchCode,
          message: options.mismatchMessage,
          retryable: true,
          details: {
            ...options.details,
            ...error.details,
          },
        });
      }

      throw new RoomServiceError({
        status: error.status,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      });
    }
  }

  private resolveRuleset(generation: string): RulesetSummary {
    try {
      return structuredClone(getRulesetByGeneration(generation));
    } catch {
      throw new RoomServiceError({
        status: 404,
        code: 'PVP_RULESET_NOT_FOUND',
        message: 'No active PvP ruleset is configured for this generation.',
        retryable: false,
        details: { generation },
      });
    }
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      const roomCode = normalizeRoomCode(this.roomCodeGenerator());
      if (!this.repository.hasRoomCode(roomCode)) {
        return roomCode;
      }
    }

    throw new RoomServiceError({
      status: 503,
      code: 'PVP_ROOM_CODE_UNAVAILABLE',
      message: 'Unable to allocate a unique PvP room code at the moment.',
      retryable: true,
    });
  }

  private prepareBattleFreeze(
    room: BattleRoomRecord,
    guestParty: ActivePartySnapshot,
    preparedAt: string,
  ): BattleFreezeSnapshot {
    return {
      freezeStatus: 'pending_presence',
      preparedAt,
      generation: room.room.generation,
      rulesetKey: room.room.rulesetKey,
      rulesetHash: createRulesetHash(room.rulesetSnapshot),
      rulesetSnapshot: structuredClone(room.rulesetSnapshot),
      hostPartySnapshotId: room.host.partySnapshotId,
      hostPartySnapshotVersion: room.host.partySnapshotVersion,
      guestPartySnapshotId: guestParty.snapshotId,
      guestPartySnapshotVersion: guestParty.snapshotVersion,
      battleSeed: this.battleSeedGenerator(),
    };
  }
}
