import {
  createPvpSessionTerminalCli,
  type PvpSessionTerminalCli,
  type PvpSessionTerminalCliState,
  type PvpSessionTerminalCliInputSource,
  type PvpSessionTerminalCliScreenOutput,
} from './session-terminal-cli.js';
import {
  createPvpSessionTerminalRunner,
  type CreatePvpSessionTerminalRunnerOptions,
  type PvpSessionTerminalRunner,
  type PvpSessionTerminalRunnerSessionClientLike,
  type PvpSessionTerminalRunnerState,
} from './session-terminal-runner.js';
import { createPvpSessionTerminalStdioAdapter, type CreatePvpSessionTerminalStdioAdapterOptions } from './session-terminal-stdio.js';
import type { PvpSessionBootstrapResult } from './session-bootstrap.js';

export interface PvpLiveSessionCliAdapter extends PvpSessionTerminalCliInputSource, PvpSessionTerminalCliScreenOutput {
  setAbortHandler?(handler: (() => void) | null): void;
}

export interface PvpLiveSessionCliSessionClientLike extends PvpSessionTerminalRunnerSessionClientLike {
  connect?(): unknown;
  disconnect?(closeInfo?: { code?: number; reason?: string }): unknown;
}

export interface StartPvpLiveSessionCliOptions<
  TSessionClient extends PvpLiveSessionCliSessionClientLike = PvpLiveSessionCliSessionClientLike,
> extends Pick<CreatePvpSessionTerminalRunnerOptions, 'now' | 'createClientCommandId'> {
  bootstrap: PvpSessionBootstrapResult<TSessionClient>;
  adapter?: PvpLiveSessionCliAdapter;
  adapterOptions?: CreatePvpSessionTerminalStdioAdapterOptions;
}

export interface PvpLiveSessionCliHandle {
  readonly cli: PvpSessionTerminalCli;
  readonly runner: PvpSessionTerminalRunner;
  getState(): PvpSessionTerminalCliState;
  getRunnerState(): PvpSessionTerminalRunnerState;
  stop(): Promise<PvpSessionTerminalCliState>;
}

class StartedPvpLiveSessionCli implements PvpLiveSessionCliHandle {
  readonly cli: PvpSessionTerminalCli;

  readonly runner: PvpSessionTerminalRunner;

  private readonly adapter: PvpLiveSessionCliAdapter;

  private stopPromise: Promise<PvpSessionTerminalCliState> | null = null;

  constructor(options: {
    cli: PvpSessionTerminalCli;
    runner: PvpSessionTerminalRunner;
    adapter: PvpLiveSessionCliAdapter;
  }) {
    this.cli = options.cli;
    this.runner = options.runner;
    this.adapter = options.adapter;
  }

  getState(): PvpSessionTerminalCliState {
    return this.cli.getState();
  }

  getRunnerState(): PvpSessionTerminalRunnerState {
    return this.runner.getState();
  }

  async stop(): Promise<PvpSessionTerminalCliState> {
    if (!this.stopPromise) {
      this.adapter.setAbortHandler?.(null);
      this.stopPromise = this.cli.stop();
    }

    return this.stopPromise;
  }
}

export async function startPvpLiveSessionCli<
  TSessionClient extends PvpLiveSessionCliSessionClientLike = PvpLiveSessionCliSessionClientLike,
>(options: StartPvpLiveSessionCliOptions<TSessionClient>): Promise<PvpLiveSessionCliHandle> {
  const { bootstrap } = options;
  const adapter = options.adapter ?? createPvpSessionTerminalStdioAdapter(options.adapterOptions);
  const runner = createPvpSessionTerminalRunner({
    sessionClient: bootstrap.sessionClient,
    now: options.now,
    createClientCommandId: options.createClientCommandId,
  });
  const cli = createPvpSessionTerminalCli({
    runner,
    input: adapter,
    output: adapter,
    bootstrap: {
      connect: () => {
        bootstrap.sessionClient.connect?.();
      },
      disconnect: () => {
        bootstrap.sessionClient.disconnect?.({
          code: 1000,
          reason: 'terminal_cli_stop',
        });
      },
    },
  });
  const started = new StartedPvpLiveSessionCli({
    cli,
    runner,
    adapter,
  });

  adapter.setAbortHandler?.(() => {
    void started.stop();
  });

  try {
    await cli.start();
    return started;
  } catch (error) {
    adapter.setAbortHandler?.(null);
    throw error;
  }
}
