import {
  createPvpReconnectController,
  type CreatePvpReconnectControllerOptions,
  type PvpReconnectController,
  type PvpReconnectControllerState,
  type PvpReconnectTrigger,
} from './reconnect-controller.js';
import {
  createPvpWebSocketClient,
  type CreatePvpWebSocketClientOptions,
  type PvpWebSocketClient,
  type PvpWebSocketTransportStatus,
  type SendBattleCommandResult,
} from './websocket-client.js';
import type { PvpClientState } from './client-protocol.js';
import {
  hasPendingAction,
  isCommandLocked,
  type CreateBattleCommandEnvelopeOptions,
  type PvpPendingRequest,
  type PvpSessionState,
} from './session-store.js';

export interface CreatePvpSessionClientOptions
  extends CreatePvpWebSocketClientOptions,
    Omit<CreatePvpReconnectControllerOptions, 'client'> {}

export interface PvpSessionClientReconnectState {
  autoReconnectEnabled: boolean;
  attempt: number;
  scheduled: boolean;
  delay: number | null;
  nextReconnectAt: string | null;
  lastTrigger: PvpReconnectTrigger;
}

export interface PvpSessionClientState {
  transportStatus: PvpWebSocketTransportStatus;
  session: PvpSessionState;
  protocol: PvpClientState;
  reconnect: PvpSessionClientReconnectState;
  canSendCommand: boolean;
  hasPendingRequest: boolean;
  activeRequestKind: PvpPendingRequest['kind'] | null;
}

export interface SendPvpSessionBattleCommandResult extends Omit<SendBattleCommandResult, 'state'> {
  state: PvpSessionClientState;
}

export type PvpSessionClientStateListener = (state: PvpSessionClientState) => void;

function cloneState(state: PvpSessionClientState): PvpSessionClientState {
  return structuredClone(state);
}

function deriveSessionClientState(controllerState: PvpReconnectControllerState): PvpSessionClientState {
  const protocol = structuredClone(controllerState.client.protocol);
  const session = structuredClone(protocol.session);
  const hasPendingRequest = session.pendingRequest !== null;

  return {
    transportStatus: controllerState.client.transportStatus,
    session,
    protocol,
    reconnect: {
      autoReconnectEnabled: controllerState.autoReconnectEnabled,
      attempt: controllerState.reconnectAttempt,
      scheduled: controllerState.reconnectScheduled,
      delay: controllerState.reconnectDelayMs,
      nextReconnectAt: controllerState.nextReconnectAt,
      lastTrigger: controllerState.lastTrigger,
    },
    canSendCommand: controllerState.client.transportStatus === 'connected'
      && hasPendingAction(session)
      && !isCommandLocked(session),
    hasPendingRequest,
    activeRequestKind: session.pendingRequest?.kind ?? null,
  };
}

export class PvpSessionClient {
  private readonly websocketClient: PvpWebSocketClient;

  private readonly reconnectController: PvpReconnectController;

  private readonly listeners = new Set<PvpSessionClientStateListener>();

  private readonly unsubscribeReconnect: () => void;

  private state: PvpSessionClientState;

  private disposed = false;

  constructor(options: CreatePvpSessionClientOptions) {
    this.websocketClient = createPvpWebSocketClient(options);
    this.reconnectController = createPvpReconnectController({
      client: this.websocketClient,
      now: options.now,
      scheduler: options.scheduler,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      multiplier: options.multiplier,
      computeDelayMs: options.computeDelayMs,
    });
    this.state = deriveSessionClientState(this.reconnectController.getState());
    this.unsubscribeReconnect = this.reconnectController.subscribe((controllerState) => {
      if (this.disposed) {
        return;
      }

      this.state = deriveSessionClientState(controllerState);
      this.emit();
    });
  }

  getState(): PvpSessionClientState {
    return cloneState(this.state);
  }

  subscribe(listener: PvpSessionClientStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): PvpSessionClientState {
    this.assertNotDisposed();
    this.reconnectController.connect();
    return this.getState();
  }

  disconnect(closeInfo: { code?: number; reason?: string } = {}): PvpSessionClientState {
    this.assertNotDisposed();
    this.reconnectController.disconnect(closeInfo);
    return this.getState();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.reconnectController.disconnect({
      code: 1000,
      reason: 'session_client_dispose',
    });
    this.disposed = true;
    this.unsubscribeReconnect();
    this.reconnectController.dispose();
    this.listeners.clear();
  }

  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendPvpSessionBattleCommandResult {
    this.assertNotDisposed();
    const result = this.websocketClient.sendBattleCommand(options);

    return {
      envelope: result.envelope,
      serialized: result.serialized,
      state: this.getState(),
    };
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('PVP_SESSION_CLIENT_DISPOSED');
    }
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createPvpSessionClient(options: CreatePvpSessionClientOptions): PvpSessionClient {
  return new PvpSessionClient(options);
}
