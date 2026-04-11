import {
  BattleSessionService,
  type BattleCommandEnvelope,
  type BattleSessionRecord,
} from '../battle/index.js';
import type { ActivePartySnapshot } from '../parties/index.js';
import type { BattleRoomRecord, RoomPresence, RoomRepository, RoomSeat } from '../rooms/index.js';
import {
  ConnectionRegistry,
  type PvpWsConnectionRecord,
  type PvpWsOutboundEnvelope,
  type PvpWsTransport,
} from './connection-registry.js';
import { HeartbeatMonitor, type HeartbeatSweepResult } from './heartbeat.js';
import { MessageRouter, type PvpWsInboundEnvelope } from './message-router.js';

export interface PvpWsServerOptions {
  authenticate(token: string): { userId: string } | null;
  roomRepository: RoomRepository;
  battleSessionService: BattleSessionService;
  loadPartySnapshot(snapshotId: string): ActivePartySnapshot | undefined;
  now?: () => Date;
}

export interface PvpWsConnectInput {
  roomId: string;
  token: string;
  connectionId: string;
  transport: PvpWsTransport;
}

export interface PvpWsConnectionSummary {
  connectionId: string;
  seat: RoomSeat;
  battleId: string | null;
}

function cloneRoom(room: BattleRoomRecord): BattleRoomRecord {
  return structuredClone(room);
}

function cloneSession(session: BattleSessionRecord): BattleSessionRecord {
  return structuredClone(session);
}

function createError(code: string, message = code): Error {
  return new Error(message);
}

function resolveSeat(room: BattleRoomRecord, userId: string): RoomSeat {
  if (room.host.userId === userId) {
    return 'host';
  }

  if (room.guest?.userId === userId) {
    return 'guest';
  }

  throw createError('PVP_ROOM_ACCESS_DENIED');
}

function getSeatBinding(room: BattleRoomRecord, seat: RoomSeat) {
  return seat === 'host' ? room.host : room.guest;
}

export class PvpWsServer {
  private readonly authenticate: PvpWsServerOptions['authenticate'];

  private readonly roomRepository: RoomRepository;

  private readonly battleSessionService: BattleSessionService;

  private readonly loadPartySnapshot: PvpWsServerOptions['loadPartySnapshot'];

  private readonly now: () => Date;

  private readonly registry = new ConnectionRegistry();

  private readonly heartbeatMonitor: HeartbeatMonitor;

  private readonly messageRouter = new MessageRouter();

  private readonly sessionsByRoomId = new Map<string, BattleSessionRecord>();

  constructor(options: PvpWsServerOptions) {
    this.authenticate = options.authenticate;
    this.roomRepository = options.roomRepository;
    this.battleSessionService = options.battleSessionService;
    this.loadPartySnapshot = options.loadPartySnapshot;
    this.now = options.now ?? (() => new Date());
    this.heartbeatMonitor = new HeartbeatMonitor({
      registry: this.registry,
      now: this.now,
    });
  }

  connectClient(input: PvpWsConnectInput): PvpWsConnectionSummary {
    const auth = this.authenticate(input.token);
    if (!auth) {
      input.transport.close(4003, 'PVP_WS_AUTH_INVALID');
      throw createError('PVP_WS_AUTH_INVALID');
    }

    const room = this.getRoomOrThrow(input.roomId);
    const seat = resolveSeat(room, auth.userId);
    const duplicate = this.registry.getBySeat(input.roomId, seat);
    if (duplicate) {
      input.transport.close(4001, 'PVP_WS_DUPLICATE_CONNECTION');
      throw createError('PVP_WS_DUPLICATE_CONNECTION');
    }

    const existingSession = this.sessionsByRoomId.get(input.roomId);
    const connection = this.registry.register({
      connectionId: input.connectionId,
      roomId: input.roomId,
      userId: auth.userId,
      seat,
      battleId: existingSession?.battleId ?? null,
      transport: input.transport,
      now: this.now(),
    });

    const roomWithPresence = this.persistPresence(input.roomId, seat, 'connected');
    const startedSession = this.ensureSessionStarted(roomWithPresence);

    return {
      connectionId: connection.connectionId,
      seat,
      battleId: startedSession?.battleId ?? existingSession?.battleId ?? null,
    };
  }

  receiveMessage(connectionId: string, message: PvpWsInboundEnvelope): void {
    const connection = this.getConnectionOrThrow(connectionId);
    this.registry.markSeen(connectionId, this.now());

    const routed = this.messageRouter.route(message);
    if (routed.type === 'ws.pong') {
      this.heartbeatMonitor.recordPong(connectionId);
      return;
    }

    const session = this.getSessionForCommand(connection, routed.envelope);
    const result = this.battleSessionService.submitCommand({
      session,
      seat: connection.seat,
      envelope: routed.envelope,
    });

    this.sessionsByRoomId.set(result.session.roomId, cloneSession(result.session));
    this.dispatchEvents(result.session.roomId, 'host', result.eventsBySeat.host);
    this.dispatchEvents(result.session.roomId, 'guest', result.eventsBySeat.guest);
    this.syncFinishedRoom(result.session);
  }

  disconnectClient(
    connectionId: string,
    closeInfo: { code: number; reason: string } = {
      code: 4000,
      reason: 'PVP_WS_DISCONNECTED',
    },
  ): void {
    const connection = this.registry.remove(connectionId);
    if (!connection) {
      return;
    }

    connection.transport.close(closeInfo.code, closeInfo.reason);
    this.persistPresence(connection.roomId, connection.seat, 'disconnected');
  }

  sweepHeartbeats(): HeartbeatSweepResult {
    return this.heartbeatMonitor.sweep((connection) => {
      this.disconnectClient(connection.connectionId, {
        code: 4002,
        reason: 'PVP_WS_HEARTBEAT_TIMEOUT',
      });
    });
  }

  getBattleSession(roomId: string): BattleSessionRecord | undefined {
    const session = this.sessionsByRoomId.get(roomId);
    return session ? cloneSession(session) : undefined;
  }

  private ensureSessionStarted(room: BattleRoomRecord): BattleSessionRecord | undefined {
    const existingSession = this.sessionsByRoomId.get(room.room.roomId);
    if (existingSession) {
      this.registry.updateBattleIdForRoom(room.room.roomId, existingSession.battleId);
      return cloneSession(existingSession);
    }

    if (!room.guest) {
      return undefined;
    }

    if (room.host.presence !== 'connected' || room.guest.presence !== 'connected') {
      return undefined;
    }

    const hostParty = this.loadPartySnapshotOrThrow(room.host.partySnapshotId);
    const guestParty = this.loadPartySnapshotOrThrow(room.guest.partySnapshotId);
    const startedAt = this.now().toISOString();
    const startedRoom: BattleRoomRecord = {
      ...cloneRoom(room),
      room: {
        ...room.room,
        status: 'in_progress',
        startedAt,
        expiresAt: null,
      },
    };

    this.roomRepository.saveRoom(startedRoom);

    const result = this.battleSessionService.createSession({
      room: startedRoom,
      hostParty,
      guestParty,
    });
    this.sessionsByRoomId.set(result.session.roomId, cloneSession(result.session));
    this.registry.updateBattleIdForRoom(result.session.roomId, result.session.battleId);
    this.dispatchEvents(result.session.roomId, 'host', result.eventsBySeat.host);
    this.dispatchEvents(result.session.roomId, 'guest', result.eventsBySeat.guest);

    return cloneSession(result.session);
  }

  private syncFinishedRoom(session: BattleSessionRecord): void {
    if (session.phase !== 'finished' && session.phase !== 'abandoned') {
      return;
    }

    const room = this.getRoomOrThrow(session.roomId);
    const nextRoom: BattleRoomRecord = {
      ...room,
      room: {
        ...room.room,
        status: 'finished',
        finishedAt: session.updatedAt,
      },
    };
    this.roomRepository.saveRoom(nextRoom);
  }

  private getRoomOrThrow(roomId: string): BattleRoomRecord {
    const room = this.roomRepository.getRoom(roomId);
    if (!room) {
      throw createError('PVP_ROOM_NOT_FOUND');
    }

    return room;
  }

  private getConnectionOrThrow(connectionId: string): PvpWsConnectionRecord {
    const connection = this.registry.get(connectionId);
    if (!connection) {
      throw createError('PVP_WS_CONNECTION_NOT_FOUND');
    }

    return connection;
  }

  private getSessionForCommand(
    connection: PvpWsConnectionRecord,
    envelope: BattleCommandEnvelope,
  ): BattleSessionRecord {
    if (envelope.roomId !== connection.roomId) {
      throw createError('PVP_COMMAND_BATTLE_MISMATCH');
    }

    const session = this.sessionsByRoomId.get(connection.roomId);
    if (!session) {
      throw createError('PVP_BATTLE_NOT_READY');
    }

    if (envelope.battleId !== session.battleId) {
      throw createError('PVP_COMMAND_BATTLE_MISMATCH');
    }

    return cloneSession(session);
  }

  private loadPartySnapshotOrThrow(snapshotId: string): ActivePartySnapshot {
    const snapshot = this.loadPartySnapshot(snapshotId);
    if (!snapshot) {
      throw createError('PVP_PARTY_SNAPSHOT_NOT_FOUND');
    }

    return structuredClone(snapshot);
  }

  private persistPresence(roomId: string, seat: RoomSeat, presence: RoomPresence): BattleRoomRecord {
    const room = this.getRoomOrThrow(roomId);
    const binding = getSeatBinding(room, seat);
    if (!binding) {
      throw createError('PVP_ROOM_ACCESS_DENIED');
    }

    const nextRoom: BattleRoomRecord =
      seat === 'host'
        ? {
            ...room,
            host: {
              ...room.host,
              presence,
            },
          }
        : {
            ...room,
            guest: room.guest
              ? {
                  ...room.guest,
                  presence,
                }
              : null,
          };

    this.roomRepository.saveRoom(nextRoom);
    return nextRoom;
  }

  private dispatchEvents(
    roomId: string,
    seat: RoomSeat,
    messages: readonly PvpWsOutboundEnvelope[],
  ): void {
    const connection = this.registry.getBySeat(roomId, seat);
    if (!connection) {
      return;
    }

    for (const message of messages) {
      connection.transport.send(message);
    }
  }
}
