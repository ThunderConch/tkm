import type { PvpWsErrorEnvelope } from '../server/ws/index.js';
import {
  applyPvpTransportEnvelope,
  createPvpClientCommand,
  createPvpClientState,
  type PvpClientInboundEnvelope,
  type PvpClientOutboundEnvelope,
  type PvpClientState,
} from './client-protocol.js';
import type { CreateBattleCommandEnvelopeOptions } from './session-store.js';

export type PvpWebSocketTransportStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface PvpWebSocketMessageEvent {
  data: string;
}

export interface PvpWebSocketCloseEvent {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface PvpWebSocketErrorEvent {
  message?: string;
  error?: unknown;
}

export interface PvpWebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: PvpWebSocketMessageEvent) => void) | null;
  onclose: ((event: PvpWebSocketCloseEvent) => void) | null;
  onerror: ((event: PvpWebSocketErrorEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type CreatePvpWebSocket = (url: string) => PvpWebSocketLike;

export interface CreatePvpWebSocketClientOptions {
  serverUrl: string;
  roomId: string;
  token: string;
  createSocket: CreatePvpWebSocket;
  now?: () => Date;
}

export interface PvpWebSocketCloseInfo {
  code: number | null;
  reason: string | null;
  wasClean: boolean;
  at: string | null;
}

export interface PvpWebSocketClientState {
  protocol: PvpClientState;
  transportStatus: PvpWebSocketTransportStatus;
  connectionUrl: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastInboundRawMessage: string | null;
  lastOutboundRawMessage: string | null;
  lastTransportError: PvpWsErrorEnvelope | null;
  lastClose: PvpWebSocketCloseInfo;
  connectCount: number;
}

export interface SendBattleCommandResult {
  state: PvpWebSocketClientState;
  envelope: PvpClientOutboundEnvelope;
  serialized: string;
}

export type PvpWebSocketStateListener = (state: PvpWebSocketClientState) => void;

const DEFAULT_CLOSE_INFO: PvpWebSocketCloseInfo = {
  code: null,
  reason: null,
  wasClean: false,
  at: null,
};

function cloneTransportError(error: PvpWsErrorEnvelope | null): PvpWsErrorEnvelope | null {
  if (!error) {
    return null;
  }

  return {
    ...error,
    details: error.details ? structuredClone(error.details) : undefined,
  };
}

function cloneCloseInfo(closeInfo: PvpWebSocketCloseInfo): PvpWebSocketCloseInfo {
  return { ...closeInfo };
}

function cloneState(state: PvpWebSocketClientState): PvpWebSocketClientState {
  return {
    ...state,
    protocol: structuredClone(state.protocol),
    lastTransportError: cloneTransportError(state.lastTransportError),
    lastClose: cloneCloseInfo(state.lastClose),
  };
}

function toIsoString(now: () => Date): string {
  return now().toISOString();
}

function createTransportError(
  now: () => Date,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): PvpWsErrorEnvelope {
  return {
    type: 'ws.error',
    sentAt: toIsoString(now),
    code,
    message,
    retryable,
    details: details ? structuredClone(details) : undefined,
  };
}

export function createPvpWebSocketUrl(serverUrl: string, roomId: string, token: string): string {
  const url = new URL(serverUrl);

  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/ws/pvp';
  }

  url.searchParams.set('roomId', roomId);
  url.searchParams.set('token', token);
  return url.toString();
}

function createInitialState(connectionUrl: string): PvpWebSocketClientState {
  return {
    protocol: createPvpClientState(),
    transportStatus: 'idle',
    connectionUrl,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastInboundRawMessage: null,
    lastOutboundRawMessage: null,
    lastTransportError: null,
    lastClose: cloneCloseInfo(DEFAULT_CLOSE_INFO),
    connectCount: 0,
  };
}

export class PvpWebSocketClient {
  private readonly connectionUrl: string;

  private readonly createSocket: CreatePvpWebSocket;

  private readonly now: () => Date;

  private readonly listeners = new Set<PvpWebSocketStateListener>();

  private socket: PvpWebSocketLike | null = null;

  private state: PvpWebSocketClientState;

  private manualDisconnect = false;

  constructor(options: CreatePvpWebSocketClientOptions) {
    this.connectionUrl = createPvpWebSocketUrl(options.serverUrl, options.roomId, options.token);
    this.createSocket = options.createSocket;
    this.now = options.now ?? (() => new Date());
    this.state = createInitialState(this.connectionUrl);
  }

  getState(): PvpWebSocketClientState {
    return cloneState(this.state);
  }

  subscribe(listener: PvpWebSocketStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): PvpWebSocketClientState {
    return this.openSocket('connecting');
  }

  reconnect(): PvpWebSocketClientState {
    return this.openSocket('reconnecting');
  }

  disconnect(closeInfo: { code?: number; reason?: string } = {}): PvpWebSocketClientState {
    this.manualDisconnect = true;

    const socket = this.socket;
    if (!socket) {
      this.patchState({
        transportStatus: 'closed',
        lastDisconnectedAt: toIsoString(this.now),
        lastClose: {
          code: closeInfo.code ?? 1000,
          reason: closeInfo.reason ?? 'client_disconnect_without_socket',
          wasClean: true,
          at: toIsoString(this.now),
        },
      });
      return this.getState();
    }

    socket.close(closeInfo.code, closeInfo.reason);
    return this.getState();
  }

  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendBattleCommandResult {
    const socket = this.requireOpenSocket();
    const created = createPvpClientCommand(this.state.protocol, options);
    const serialized = this.serializeEnvelope(created.envelope);

    socket.send(serialized);
    this.patchState({
      protocol: created.state,
      lastOutboundRawMessage: serialized,
      lastTransportError: null,
    });

    return {
      state: this.getState(),
      envelope: created.envelope,
      serialized,
    };
  }

  private openSocket(status: Extract<PvpWebSocketTransportStatus, 'connecting' | 'reconnecting'>): PvpWebSocketClientState {
    if (this.socket) {
      throw new Error('PVP_CLIENT_SOCKET_ALREADY_OPEN');
    }

    this.manualDisconnect = false;
    const socket = this.createSocket(this.connectionUrl);
    this.socket = socket;
    this.bindSocket(socket);

    this.patchState({
      transportStatus: status,
      connectionUrl: this.connectionUrl,
      connectCount: this.state.connectCount + 1,
      lastTransportError: null,
    });

    return this.getState();
  }

  private bindSocket(socket: PvpWebSocketLike): void {
    socket.onopen = () => {
      this.patchState({
        transportStatus: 'connected',
        lastConnectedAt: toIsoString(this.now),
        lastTransportError: null,
      });
    };

    socket.onmessage = (event) => {
      this.handleRawMessage(event.data);
    };

    socket.onerror = (event) => {
      this.recordTransportError(
        createTransportError(
          this.now,
          'PVP_CLIENT_SOCKET_ERROR',
          event.message ?? 'websocket transport error',
          true,
          event.error ? { error: String(event.error) } : undefined,
        ),
        'error',
      );
    };

    socket.onclose = (event) => {
      this.socket = null;
      const closedAt = toIsoString(this.now);
      this.patchState({
        transportStatus: 'closed',
        lastDisconnectedAt: closedAt,
        lastClose: {
          code: event.code ?? (this.manualDisconnect ? 1000 : null),
          reason: event.reason ?? (this.manualDisconnect ? 'client_disconnect' : null),
          wasClean: event.wasClean ?? this.manualDisconnect,
          at: closedAt,
        },
      });
      this.manualDisconnect = false;
    };
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.patchState({
        lastInboundRawMessage: raw,
      });
      this.recordTransportError(
        createTransportError(this.now, 'PVP_CLIENT_MESSAGE_PARSE_ERROR', 'Failed to parse websocket message.', true, {
          raw,
          cause: error instanceof Error ? error.message : String(error),
        }),
        'error',
      );
      return;
    }

    let applied;
    try {
      applied = applyPvpTransportEnvelope(this.state.protocol, parsed as PvpClientInboundEnvelope, {
        pongSentAt: toIsoString(this.now),
      });
    } catch (error) {
      this.patchState({
        lastInboundRawMessage: raw,
      });
      this.recordTransportError(
        createTransportError(this.now, 'PVP_CLIENT_MESSAGE_INVALID', 'Received invalid websocket envelope.', true, {
          raw,
          cause: error instanceof Error ? error.message : String(error),
        }),
        'error',
      );
      return;
    }

    this.patchState({
      protocol: applied.state,
      lastInboundRawMessage: raw,
      lastTransportError: null,
      transportStatus: this.state.transportStatus === 'error' ? 'connected' : this.state.transportStatus,
    });

    for (const envelope of applied.outbound) {
      this.sendProtocolEnvelope(envelope);
    }
  }

  private sendProtocolEnvelope(envelope: PvpClientOutboundEnvelope): void {
    const socket = this.requireOpenSocket();
    const serialized = this.serializeEnvelope(envelope);
    socket.send(serialized);
    this.patchState({
      lastOutboundRawMessage: serialized,
      lastTransportError: null,
    });
  }

  private serializeEnvelope(envelope: PvpClientOutboundEnvelope): string {
    return JSON.stringify(envelope);
  }

  private requireOpenSocket(): PvpWebSocketLike {
    if (!this.socket) {
      throw new Error('PVP_CLIENT_SOCKET_NOT_CONNECTED');
    }

    return this.socket;
  }

  private recordTransportError(error: PvpWsErrorEnvelope, transportStatus: Extract<PvpWebSocketTransportStatus, 'error' | 'closed'>): void {
    this.patchState({
      transportStatus,
      lastTransportError: error,
    });
  }

  private patchState(patch: Partial<PvpWebSocketClientState>): void {
    const nextState: PvpWebSocketClientState = {
      ...this.state,
      ...patch,
      protocol: patch.protocol ? structuredClone(patch.protocol) : this.state.protocol,
      lastTransportError: patch.lastTransportError !== undefined
        ? cloneTransportError(patch.lastTransportError)
        : this.state.lastTransportError,
      lastClose: patch.lastClose ? cloneCloseInfo(patch.lastClose) : this.state.lastClose,
    };

    this.state = nextState;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createPvpWebSocketClient(options: CreatePvpWebSocketClientOptions): PvpWebSocketClient {
  return new PvpWebSocketClient(options);
}
