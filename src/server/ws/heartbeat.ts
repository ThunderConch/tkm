import { ConnectionRegistry, type PvpWsConnectionRecord } from './connection-registry.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_PONG_TIMEOUT_MS = 15_000;

export interface HeartbeatSweepResult {
  pingedConnectionIds: string[];
  timedOutConnectionIds: string[];
}

export interface HeartbeatMonitorOptions {
  registry: ConnectionRegistry;
  now?: () => Date;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export class HeartbeatMonitor {
  private readonly registry: ConnectionRegistry;

  private readonly now: () => Date;

  private readonly pingIntervalMs: number;

  private readonly pongTimeoutMs: number;

  constructor(options: HeartbeatMonitorOptions) {
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date());
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  }

  recordPong(connectionId: string): void {
    this.registry.markSeen(connectionId, this.now());
  }

  sweep(onTimeout: (connection: PvpWsConnectionRecord) => void): HeartbeatSweepResult {
    const now = this.now();
    const nowMs = now.getTime();
    const result: HeartbeatSweepResult = {
      pingedConnectionIds: [],
      timedOutConnectionIds: [],
    };

    for (const connection of this.registry.listAll()) {
      if (nowMs - connection.lastSeenAtMs > this.pongTimeoutMs) {
        result.timedOutConnectionIds.push(connection.connectionId);
        onTimeout(connection);
        continue;
      }

      const shouldPing =
        connection.lastPingAtMs === null || nowMs - connection.lastPingAtMs >= this.pingIntervalMs;
      if (!shouldPing) {
        continue;
      }

      connection.transport.send({
        type: 'ws.ping',
        sentAt: now.toISOString(),
      });
      this.registry.markPingSent(connection.connectionId, now);
      result.pingedConnectionIds.push(connection.connectionId);
    }

    return result;
  }
}
