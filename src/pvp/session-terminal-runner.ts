import type { BattleCommand } from '../server/battle/index.js';
import {
  createPvpSessionTerminalController,
  type CreatePvpSessionTerminalControllerOptions,
  type PvpSessionTerminalClientLike,
  type PvpSessionTerminalSnapshot,
  type PvpSessionTerminalSubmitFailureResult,
  type PvpSessionTerminalSubmitResult,
  type PvpSessionTerminalSubmitSuccessResult,
} from './session-terminal-controller.js';
import type { PvpSessionClient, PvpSessionClientState, PvpSessionClientStateListener } from './session-client.js';

export interface PvpSessionTerminalRunnerState {
  running: boolean;
  revision: number;
  snapshot: PvpSessionTerminalSnapshot;
  screen: string;
  availableInputTokens: string[];
  lastSubmitResult: PvpSessionTerminalSubmitResult | null;
}

export type PvpSessionTerminalRunnerStateListener = (state: PvpSessionTerminalRunnerState) => void;

export type PvpSessionTerminalRunnerSessionClientLike = PvpSessionTerminalClientLike & Pick<PvpSessionClient, 'subscribe'>;

export interface CreatePvpSessionTerminalRunnerOptions extends Omit<CreatePvpSessionTerminalControllerOptions, 'sessionClient'> {
  sessionClient: PvpSessionTerminalRunnerSessionClientLike;
}

function cloneRunnerState(state: PvpSessionTerminalRunnerState): PvpSessionTerminalRunnerState {
  return structuredClone(state);
}

function cloneSnapshot(snapshot: PvpSessionTerminalSnapshot): PvpSessionTerminalSnapshot {
  return structuredClone(snapshot);
}

function cloneSubmitResult(result: PvpSessionTerminalSubmitResult | null): PvpSessionTerminalSubmitResult | null {
  return result ? structuredClone(result) : null;
}

function createRunnerState(
  snapshot: PvpSessionTerminalSnapshot,
  options: {
    running: boolean;
    revision: number;
    lastSubmitResult?: PvpSessionTerminalSubmitResult | null;
  },
): PvpSessionTerminalRunnerState {
  const clonedSnapshot = cloneSnapshot(snapshot);

  return {
    running: options.running,
    revision: options.revision,
    snapshot: clonedSnapshot,
    screen: clonedSnapshot.screen,
    availableInputTokens: [...clonedSnapshot.availableInputTokens],
    lastSubmitResult: cloneSubmitResult(options.lastSubmitResult ?? null),
  };
}

function syncSubmitResultSnapshot(
  result: PvpSessionTerminalSubmitResult,
  snapshot: PvpSessionTerminalSnapshot,
): PvpSessionTerminalSubmitResult {
  const syncedSnapshot = cloneSnapshot(snapshot);

  if (result.status === 'submitted') {
    const success: PvpSessionTerminalSubmitSuccessResult = {
      ...structuredClone(result),
      command: structuredClone(result.command),
      entry: structuredClone(result.entry),
      sendOptions: structuredClone(result.sendOptions),
      sendResult: structuredClone(result.sendResult),
      snapshot: syncedSnapshot,
    };

    return success;
  }

  const failure: PvpSessionTerminalSubmitFailureResult = {
    ...structuredClone(result),
    snapshot: syncedSnapshot,
  };

  return failure;
}

export class PvpSessionTerminalRunner {
  private readonly sessionClient: PvpSessionTerminalRunnerSessionClientLike;

  private readonly listeners = new Set<PvpSessionTerminalRunnerStateListener>();

  private readonly controller: ReturnType<typeof createPvpSessionTerminalController>;

  private unsubscribeSession: (() => void) | null = null;

  private state: PvpSessionTerminalRunnerState;

  constructor(options: CreatePvpSessionTerminalRunnerOptions) {
    this.sessionClient = options.sessionClient;
    this.controller = createPvpSessionTerminalController({
      sessionClient: options.sessionClient,
      now: options.now,
      createClientCommandId: options.createClientCommandId,
    });
    this.state = createRunnerState(this.controller.getSnapshot(), {
      running: false,
      revision: 0,
      lastSubmitResult: null,
    });
  }

  start(): PvpSessionTerminalRunnerState {
    if (this.unsubscribeSession) {
      return this.getState();
    }

    this.state = {
      ...this.state,
      running: true,
    };

    const listener: PvpSessionClientStateListener = (_sessionState: PvpSessionClientState) => {
      this.refreshFromSession();
    };

    this.unsubscribeSession = this.sessionClient.subscribe(listener);
    return this.getState();
  }

  stop(): PvpSessionTerminalRunnerState {
    if (!this.unsubscribeSession) {
      return this.getState();
    }

    const unsubscribe = this.unsubscribeSession;
    this.unsubscribeSession = null;
    unsubscribe();

    this.state = {
      ...this.state,
      running: false,
      revision: this.state.revision + 1,
    };
    this.emit();
    return this.getState();
  }

  getState(): PvpSessionTerminalRunnerState {
    return cloneRunnerState(this.state);
  }

  subscribe(listener: PvpSessionTerminalRunnerStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  submitInputToken(token: string): PvpSessionTerminalSubmitResult {
    const submitResult = this.controller.submitInputToken(token);
    const snapshot = this.controller.getSnapshot();
    const syncedResult = syncSubmitResultSnapshot(submitResult, snapshot);

    this.state = createRunnerState(snapshot, {
      running: this.state.running,
      revision: this.state.revision + 1,
      lastSubmitResult: syncedResult,
    });
    this.emit();
    return cloneSubmitResult(syncedResult) ?? syncedResult;
  }

  private refreshFromSession(): void {
    const snapshot = this.controller.getSnapshot();
    this.state = createRunnerState(snapshot, {
      running: this.state.running,
      revision: this.state.revision + 1,
      lastSubmitResult: this.state.lastSubmitResult,
    });
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function createPvpSessionTerminalRunner(
  options: CreatePvpSessionTerminalRunnerOptions,
): PvpSessionTerminalRunner {
  return new PvpSessionTerminalRunner(options);
}

export type PvpSessionTerminalRunnerLike = Pick<
  PvpSessionTerminalRunner,
  'start' | 'stop' | 'getState' | 'subscribe' | 'submitInputToken'
>;

export type PvpSessionTerminalRunnerCommand = BattleCommand;
