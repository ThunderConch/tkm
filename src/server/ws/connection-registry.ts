import type { BattleServerEventEnvelope } from '../battle/index.js';
import type { RoomSeat } from '../rooms/index.js';

export interface PvpWsPingEnvelope {
  type: 'ws.ping';
  sentAt: string;
}

export interface PvpWsErrorEnvelope {
  type: 'ws.error';
  sentAt: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type PvpWsOutboundEnvelope = BattleServerEventEnvelope | PvpWsPingEnvelope | PvpWsErrorEnvelope;

export interface PvpWsTransport {
  send(message: PvpWsOutboundEnvelope): void;
  close(code: number, reason: string): void;
}

export interface PvpWsConnectionRecord {
  connectionId: string;
  roomId: string;
  userId: string;
  seat: RoomSeat;
  battleId: string | null;
  transport: PvpWsTransport;
  connectedAt: string;
  lastSeenAtMs: number;
  lastPingAtMs: number | null;
}

export interface RegisterPvpWsConnectionInput {
  connectionId: string;
  roomId: string;
  userId: string;
  seat: RoomSeat;
  battleId: string | null;
  transport: PvpWsTransport;
  now: Date;
}

function cloneConnection(connection: PvpWsConnectionRecord): PvpWsConnectionRecord {
  return { ...connection };
}

function createSeatKey(roomId: string, seat: RoomSeat): string {
  return `${roomId}:${seat}`;
}

export class ConnectionRegistry {
  private readonly connectionsById = new Map<string, PvpWsConnectionRecord>();

  private readonly connectionIdBySeat = new Map<string, string>();

  register(input: RegisterPvpWsConnectionInput): PvpWsConnectionRecord {
    const connection: PvpWsConnectionRecord = {
      connectionId: input.connectionId,
      roomId: input.roomId,
      userId: input.userId,
      seat: input.seat,
      battleId: input.battleId,
      transport: input.transport,
      connectedAt: input.now.toISOString(),
      lastSeenAtMs: input.now.getTime(),
      lastPingAtMs: null,
    };

    this.connectionsById.set(connection.connectionId, connection);
    this.connectionIdBySeat.set(createSeatKey(connection.roomId, connection.seat), connection.connectionId);

    return cloneConnection(connection);
  }

  get(connectionId: string): PvpWsConnectionRecord | undefined {
    const connection = this.connectionsById.get(connectionId);
    return connection ? cloneConnection(connection) : undefined;
  }

  getBySeat(roomId: string, seat: RoomSeat): PvpWsConnectionRecord | undefined {
    const connectionId = this.connectionIdBySeat.get(createSeatKey(roomId, seat));
    if (!connectionId) {
      return undefined;
    }

    return this.get(connectionId);
  }

  listByRoom(roomId: string): PvpWsConnectionRecord[] {
    return Array.from(this.connectionsById.values())
      .filter((connection) => connection.roomId === roomId)
      .map((connection) => cloneConnection(connection));
  }

  listAll(): PvpWsConnectionRecord[] {
    return Array.from(this.connectionsById.values(), (connection) => cloneConnection(connection));
  }

  updateBattleIdForRoom(roomId: string, battleId: string): void {
    for (const connection of this.connectionsById.values()) {
      if (connection.roomId === roomId) {
        connection.battleId = battleId;
      }
    }
  }

  markSeen(connectionId: string, now: Date): void {
    const connection = this.connectionsById.get(connectionId);
    if (!connection) {
      return;
    }

    connection.lastSeenAtMs = now.getTime();
  }

  markPingSent(connectionId: string, now: Date): void {
    const connection = this.connectionsById.get(connectionId);
    if (!connection) {
      return;
    }

    connection.lastPingAtMs = now.getTime();
  }

  remove(connectionId: string): PvpWsConnectionRecord | undefined {
    const connection = this.connectionsById.get(connectionId);
    if (!connection) {
      return undefined;
    }

    this.connectionsById.delete(connectionId);
    this.connectionIdBySeat.delete(createSeatKey(connection.roomId, connection.seat));
    return cloneConnection(connection);
  }
}
