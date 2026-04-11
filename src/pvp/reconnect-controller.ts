import type {
  PvpWebSocketClientState,
  PvpWebSocketStateListener,
} from './websocket-client.js';

export interface PvpReconnectClient {
  getState(): PvpWebSocketClientState;
  subscribe(listener: PvpWebSocketStateListener): () => void;
  connect(): PvpWebSocketClientState;
  reconnect(): PvpWebSocketClientState;
  disconnect(closeInfo?: { code?: number; reason?: string }): PvpWebSocketClientState;
}

export interface PvpReconnectScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PvpReconnectBackoffContext {
  attempt: number;
  client: PvpWebSocketClientState;
  trigger: Exclude<PvpReconnectTrigger, null>;
}

export type PvpReconnectTrigger = 'transport_error' | 'transport_close' | null;

export type PvpReconnectDelayStrategy = (context: PvpReconnectBackoffContext) => number;

export interface CreatePvpReconnectControllerOptions {
  client: PvpReconnectClient;
  now?: () => Date;
  scheduler?: PvpReconnectScheduler;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  computeDelayMs?: PvpReconnectDelayStrategy;
}

export interface PvpReconnectControllerState {
  client: PvpWebSocketClientState;
  autoReconnectEnabled: boolean;
  reconnectScheduled: boolean;
  reconnectAttempt: number;
  reconnectDelayMs: number | null;
  nextReconnectAt: string | null;
  lastTrigger: PvpReconnectTrigger;
}

export type PvpReconnectControllerStateListener = (state: PvpReconnectControllerState) => void;

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MULTIPLIER = 2;

function cloneState(state: PvpReconnectControllerState): PvpReconnectControllerState {
  return {
    ...state,
    client: structuredClone(state.client),
  };
}

function createDefaultScheduler(): PvpReconnectScheduler {
  return {
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    },
  };
}

function clampDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return 0;
  }

  return Math.floor(delayMs);
}

function createDelayStrategy(baseDelayMs: number, maxDelayMs: number, multiplier: number): PvpReconnectDelayStrategy {
  return ({ attempt }) => {
    const exponential = baseDelayMs * multiplier ** Math.max(0, attempt - 1);
    return Math.min(maxDelayMs, exponential);
  };
}

function createInitialState(client: PvpReconnectClient): PvpReconnectControllerState {
  return {
    client: client.getState(),
    autoReconnectEnabled: false,
    reconnectScheduled: false,
    reconnectAttempt: 0,
    reconnectDelayMs: null,
    nextReconnectAt: null,
    lastTrigger: null,
  };
}

export class PvpReconnectController {
  private readonly client: PvpReconnectClient;

  private readonly now: () => Date;

  private readonly scheduler: PvpReconnectScheduler;

  private readonly computeDelayMs: PvpReconnectDelayStrategy;

  private readonly listeners = new Set<PvpReconnectControllerStateListener>();

  private readonly unsubscribeClient: () => void;

  private reconnectTimer: unknown | null = null;

  private state: PvpReconnectControllerState;

  constructor(options: CreatePvpReconnectControllerOptions) {
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;

    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? createDefaultScheduler();
    this.computeDelayMs = options.computeDelayMs ?? createDelayStrategy(baseDelayMs, maxDelayMs, multiplier);
    this.state = createInitialState(this.client);
    this.unsubscribeClient = this.client.subscribe((clientState) => {
      this.handleClientState(clientState);
    });
  }

  getState(): PvpReconnectControllerState {
    return cloneState(this.state);
  }

  subscribe(listener: PvpReconnectControllerStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): PvpReconnectControllerState {
    this.cancelReconnectSchedule();
    const clientState = this.client.connect();
    this.patchState({
      client: clientState,
      autoReconnectEnabled: true,
      reconnectScheduled: false,
      reconnectAttempt: 0,
      reconnectDelayMs: null,
      nextReconnectAt: null,
      lastTrigger: null,
    });
    return this.getState();
  }

  disconnect(closeInfo: { code?: number; reason?: string } = {}): PvpReconnectControllerState {
    this.cancelReconnectSchedule();
    const clientState = this.client.disconnect(closeInfo);
    this.patchState({
      client: clientState,
      autoReconnectEnabled: false,
      reconnectScheduled: false,
      reconnectAttempt: 0,
      reconnectDelayMs: null,
      nextReconnectAt: null,
      lastTrigger: null,
    });
    return this.getState();
  }

  dispose(): void {
    this.cancelReconnectSchedule();
    this.unsubscribeClient();
    this.listeners.clear();
  }

  private handleClientState(clientState: PvpWebSocketClientState): void {
    if (clientState.transportStatus === 'connected') {
      this.cancelReconnectSchedule();
      this.patchState({
        client: clientState,
        reconnectScheduled: false,
        reconnectAttempt: 0,
        reconnectDelayMs: null,
        nextReconnectAt: null,
        lastTrigger: null,
      });
      return;
    }

    if (clientState.transportStatus === 'connecting' || clientState.transportStatus === 'reconnecting') {
      this.cancelReconnectSchedule();
      this.patchState({
        client: clientState,
        reconnectScheduled: false,
        reconnectDelayMs: null,
        nextReconnectAt: null,
      });
      return;
    }

    this.patchState({ client: clientState });

    if (!this.state.autoReconnectEnabled) {
      this.cancelReconnectSchedule();
      return;
    }

    if (clientState.transportStatus !== 'closed' && clientState.transportStatus !== 'error') {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.scheduleReconnect(clientState);
  }

  private scheduleReconnect(clientState: PvpWebSocketClientState): void {
    const trigger = clientState.transportStatus === 'error' ? 'transport_error' : 'transport_close';
    const attempt = this.state.reconnectAttempt + 1;
    const delayMs = clampDelayMs(this.computeDelayMs({ attempt, client: structuredClone(clientState), trigger }));
    const nextReconnectAt = new Date(this.now().getTime() + delayMs).toISOString();

    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.patchState({
        reconnectScheduled: false,
        reconnectDelayMs: null,
        nextReconnectAt: null,
      });

      if (!this.state.autoReconnectEnabled) {
        return;
      }

      const latestClientState = this.client.getState();
      if (
        latestClientState.transportStatus === 'connected'
        || latestClientState.transportStatus === 'connecting'
        || latestClientState.transportStatus === 'reconnecting'
      ) {
        this.patchState({ client: latestClientState });
        return;
      }

      try {
        const nextClientState = this.client.reconnect();
        this.patchState({ client: nextClientState });
      } catch {
        this.patchState({ client: this.client.getState() });
      }
    }, delayMs);

    this.patchState({
      client: clientState,
      reconnectScheduled: true,
      reconnectAttempt: attempt,
      reconnectDelayMs: delayMs,
      nextReconnectAt,
      lastTrigger: trigger,
    });
  }

  private cancelReconnectSchedule(): void {
    if (!this.reconnectTimer) {
      return;
    }

    this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private patchState(patch: Partial<PvpReconnectControllerState>): void {
    this.state = {
      ...this.state,
      ...patch,
      client: patch.client ? structuredClone(patch.client) : this.state.client,
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createPvpReconnectController(
  options: CreatePvpReconnectControllerOptions,
): PvpReconnectController {
  return new PvpReconnectController(options);
}
