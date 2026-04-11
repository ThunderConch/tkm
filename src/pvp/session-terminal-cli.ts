import type {
  PvpSessionTerminalRunnerLike,
  PvpSessionTerminalRunnerState,
} from './session-terminal-runner.js';

export type PvpSessionTerminalCliMaybePromise<T> = T | Promise<T>;
export type PvpSessionTerminalCliInputListener = (token: string) => void;

export interface PvpSessionTerminalCliInputSource {
  subscribe(listener: PvpSessionTerminalCliInputListener): () => void;
}

export interface PvpSessionTerminalCliScreenOutput {
  repaint(screen: string, state: PvpSessionTerminalRunnerState): void;
}

export interface PvpSessionTerminalCliBootstrapHooks {
  connect?: () => PvpSessionTerminalCliMaybePromise<void>;
  disconnect?: () => PvpSessionTerminalCliMaybePromise<void>;
}

export interface PvpSessionTerminalCliState {
  running: boolean;
  runnerState: PvpSessionTerminalRunnerState;
}

export interface CreatePvpSessionTerminalCliOptions {
  runner: PvpSessionTerminalRunnerLike;
  input: PvpSessionTerminalCliInputSource;
  output: PvpSessionTerminalCliScreenOutput;
  bootstrap?: PvpSessionTerminalCliBootstrapHooks;
  normalizeInputToken?: (token: string) => string;
}

function cloneRunnerState(state: PvpSessionTerminalRunnerState): PvpSessionTerminalRunnerState {
  return structuredClone(state);
}

function createCliState(
  runnerState: PvpSessionTerminalRunnerState,
  options: {
    running: boolean;
  },
): PvpSessionTerminalCliState {
  return {
    running: options.running,
    runnerState: cloneRunnerState(runnerState),
  };
}

function defaultNormalizeInputToken(token: string): string {
  return token.trim();
}

export class PvpSessionTerminalCli {
  private readonly runner: PvpSessionTerminalRunnerLike;

  private readonly input: PvpSessionTerminalCliInputSource;

  private readonly output: PvpSessionTerminalCliScreenOutput;

  private readonly bootstrap: PvpSessionTerminalCliBootstrapHooks;

  private readonly normalizeInputToken: (token: string) => string;

  private unsubscribeRunner: (() => void) | null = null;

  private unsubscribeInput: (() => void) | null = null;

  private state: PvpSessionTerminalCliState;

  private running = false;

  constructor(options: CreatePvpSessionTerminalCliOptions) {
    this.runner = options.runner;
    this.input = options.input;
    this.output = options.output;
    this.bootstrap = options.bootstrap ?? {};
    this.normalizeInputToken = options.normalizeInputToken ?? defaultNormalizeInputToken;
    this.state = createCliState(this.runner.getState(), {
      running: false,
    });
  }

  async start(): Promise<PvpSessionTerminalCliState> {
    if (this.running) {
      return this.getState();
    }

    let connectCompleted = false;
    let runnerStarted = false;
    let runnerUnsubscribe: (() => void) | null = null;
    let inputUnsubscribe: (() => void) | null = null;

    try {
      await this.bootstrap.connect?.();
      connectCompleted = true;

      const startedRunnerState = this.runner.start();
      runnerStarted = true;
      this.running = true;
      this.state = createCliState(startedRunnerState, {
        running: true,
      });

      runnerUnsubscribe = this.runner.subscribe((runnerState) => {
        this.state = createCliState(runnerState, {
          running: this.running,
        });
        this.output.repaint(runnerState.screen, cloneRunnerState(runnerState));
      });

      inputUnsubscribe = this.input.subscribe((token) => {
        this.handleInputToken(token);
      });

      this.unsubscribeRunner = runnerUnsubscribe;
      this.unsubscribeInput = inputUnsubscribe;

      return this.getState();
    } catch (error) {
      this.running = false;
      this.unsubscribeInput = null;
      this.unsubscribeRunner = null;

      inputUnsubscribe?.();
      runnerUnsubscribe?.();

      if (runnerStarted) {
        this.runner.stop();
      }

      if (connectCompleted) {
        await this.bootstrap.disconnect?.();
      }

      this.state = createCliState(this.runner.getState(), {
        running: false,
      });
      throw error;
    }
  }

  async stop(): Promise<PvpSessionTerminalCliState> {
    if (!this.running && !this.unsubscribeInput && !this.unsubscribeRunner) {
      return this.getState();
    }

    this.running = false;

    const unsubscribeInput = this.unsubscribeInput;
    this.unsubscribeInput = null;
    unsubscribeInput?.();

    const unsubscribeRunner = this.unsubscribeRunner;
    this.unsubscribeRunner = null;
    unsubscribeRunner?.();

    const stoppedRunnerState = this.runner.stop();
    this.state = createCliState(stoppedRunnerState, {
      running: false,
    });

    await this.bootstrap.disconnect?.();
    return this.getState();
  }

  getState(): PvpSessionTerminalCliState {
    return {
      running: this.state.running,
      runnerState: cloneRunnerState(this.state.runnerState),
    };
  }

  private handleInputToken(rawToken: string): void {
    if (!this.running) {
      return;
    }

    const token = this.normalizeInputToken(rawToken);
    if (!token) {
      return;
    }

    this.runner.submitInputToken(token);
  }
}

export function createPvpSessionTerminalCli(
  options: CreatePvpSessionTerminalCliOptions,
): PvpSessionTerminalCli {
  return new PvpSessionTerminalCli(options);
}
