import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpSessionTerminalCli,
  createPvpSessionTerminalSnapshot,
  type PvpSessionTerminalCliInputSource,
  type PvpSessionTerminalCliScreenOutput,
  type PvpSessionTerminalCliState,
  type PvpSessionTerminalRunnerLike,
  type PvpSessionTerminalRunnerState,
  type PvpSessionTerminalRunnerStateListener,
  type PvpSessionTerminalSubmitResult,
} from '../src/pvp/index.js';

function createRunnerState(overrides: Partial<PvpSessionTerminalRunnerState> = {}): PvpSessionTerminalRunnerState {
  const snapshot = createPvpSessionTerminalSnapshot(null);
  snapshot.screen = overrides.screen ?? 'screen:idle';
  snapshot.availableInputTokens = [...(overrides.availableInputTokens ?? [])];

  return {
    running: overrides.running ?? false,
    revision: overrides.revision ?? 0,
    snapshot,
    screen: overrides.screen ?? snapshot.screen,
    availableInputTokens: [...(overrides.availableInputTokens ?? snapshot.availableInputTokens)],
    lastSubmitResult: overrides.lastSubmitResult ?? null,
  };
}

class FakeInputSource implements PvpSessionTerminalCliInputSource {
  private readonly listeners = new Set<(token: string) => void>();

  subscribeCount = 0;

  unsubscribeCount = 0;

  subscribe(listener: (token: string) => void): () => void {
    this.subscribeCount += 1;
    this.listeners.add(listener);

    return () => {
      if (this.listeners.delete(listener)) {
        this.unsubscribeCount += 1;
      }
    };
  }

  emit(token: string): void {
    for (const listener of this.listeners) {
      listener(token);
    }
  }
}

class FakeScreenOutput implements PvpSessionTerminalCliScreenOutput {
  readonly repaints: Array<{ screen: string; state: PvpSessionTerminalRunnerState }> = [];

  repaint(screen: string, state: PvpSessionTerminalRunnerState): void {
    this.repaints.push({
      screen,
      state: structuredClone(state),
    });
  }
}

class FakeRunner implements PvpSessionTerminalRunnerLike {
  private state: PvpSessionTerminalRunnerState;

  private readonly listeners = new Set<PvpSessionTerminalRunnerStateListener>();

  readonly events: string[] = [];

  readonly submitTokens: string[] = [];

  subscribeCount = 0;

  unsubscribeCount = 0;

  startCalls = 0;

  stopCalls = 0;

  constructor(initialState: PvpSessionTerminalRunnerState, private readonly startedState: PvpSessionTerminalRunnerState = initialState) {
    this.state = structuredClone(initialState);
  }

  start(): PvpSessionTerminalRunnerState {
    this.startCalls += 1;
    this.events.push('runner:start');
    this.state = structuredClone(this.startedState);
    return this.getState();
  }

  stop(): PvpSessionTerminalRunnerState {
    this.stopCalls += 1;
    this.events.push('runner:stop');
    this.state = createRunnerState({
      ...this.state,
      running: false,
      revision: this.state.revision + 1,
    });
    return this.getState();
  }

  getState(): PvpSessionTerminalRunnerState {
    return structuredClone(this.state);
  }

  subscribe(listener: PvpSessionTerminalRunnerStateListener): () => void {
    this.subscribeCount += 1;
    this.events.push('runner:subscribe');
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      if (this.listeners.delete(listener)) {
        this.unsubscribeCount += 1;
        this.events.push('runner:unsubscribe');
      }
    };
  }

  submitInputToken(token: string): PvpSessionTerminalSubmitResult {
    this.submitTokens.push(token);
    this.events.push(`runner:submit:${token}`);

    const snapshot = createPvpSessionTerminalSnapshot(null);
    snapshot.screen = this.state.screen;
    snapshot.availableInputTokens = [...this.state.availableInputTokens];

    return {
      status: 'invalid_token',
      token,
      message: 'fake',
      snapshot,
    };
  }

  pushState(nextState: PvpSessionTerminalRunnerState): void {
    this.state = structuredClone(nextState);
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

describe('pvp session terminal cli', () => {
  it('runs connect bootstrap, starts the runner, and repaints the initial screen on start', async () => {
    const initialState = createRunnerState({
      running: false,
      revision: 0,
      screen: 'screen:idle',
    });
    const startedState = createRunnerState({
      running: true,
      revision: 1,
      screen: 'screen:connected',
      availableInputTokens: ['1', 'forfeit'],
    });
    const runner = new FakeRunner(initialState, startedState);
    const input = new FakeInputSource();
    const output = new FakeScreenOutput();
    const events: string[] = [];

    const cli = createPvpSessionTerminalCli({
      runner,
      input,
      output,
      bootstrap: {
        connect: async () => {
          events.push('bootstrap:connect');
        },
      },
    });

    const started = await cli.start();

    assert.deepEqual(events, ['bootstrap:connect']);
    assert.deepEqual(runner.events, ['runner:start', 'runner:subscribe']);
    assert.equal(runner.startCalls, 1);
    assert.equal(input.subscribeCount, 1);
    assert.equal(output.repaints.length, 1);
    assert.equal(output.repaints[0]?.screen, 'screen:connected');
    assert.equal(started.running, true);
    assert.equal(started.runnerState.running, true);
    assert.equal(started.runnerState.revision, 1);
    assert.deepEqual(started.runnerState.availableInputTokens, ['1', 'forfeit']);
  });

  it('normalizes input tokens and forwards them to runner.submitInputToken()', async () => {
    const runner = new FakeRunner(createRunnerState({
      running: false,
      revision: 0,
      screen: 'screen:idle',
    }), createRunnerState({
      running: true,
      revision: 1,
      screen: 'screen:connected',
    }));
    const input = new FakeInputSource();
    const output = new FakeScreenOutput();
    const cli = createPvpSessionTerminalCli({
      runner,
      input,
      output,
    });

    await cli.start();
    input.emit('   switch:2   ');
    input.emit('   ');

    assert.deepEqual(runner.submitTokens, ['switch:2']);
  });

  it('repaints whenever runner state changes after start', async () => {
    const runner = new FakeRunner(createRunnerState({
      running: false,
      revision: 0,
      screen: 'screen:idle',
    }), createRunnerState({
      running: true,
      revision: 1,
      screen: 'screen:connected',
    }));
    const input = new FakeInputSource();
    const output = new FakeScreenOutput();
    const cli = createPvpSessionTerminalCli({
      runner,
      input,
      output,
    });

    await cli.start();
    runner.pushState(createRunnerState({
      running: true,
      revision: 2,
      screen: 'screen:turn-2',
      availableInputTokens: ['2'],
    }));

    assert.equal(output.repaints.length, 2);
    assert.equal(output.repaints[1]?.screen, 'screen:turn-2');
    assert.deepEqual(output.repaints[1]?.state.availableInputTokens, ['2']);

    const cliState: PvpSessionTerminalCliState = cli.getState();
    assert.equal(cliState.running, true);
    assert.equal(cliState.runnerState.revision, 2);
    assert.equal(cliState.runnerState.screen, 'screen:turn-2');
  });

  it('cleans up input subscription, runner subscription, runner stop, and ignores later input after stop', async () => {
    const runner = new FakeRunner(createRunnerState({
      running: false,
      revision: 0,
      screen: 'screen:idle',
    }), createRunnerState({
      running: true,
      revision: 1,
      screen: 'screen:connected',
    }));
    const input = new FakeInputSource();
    const output = new FakeScreenOutput();
    const events: string[] = [];

    const cli = createPvpSessionTerminalCli({
      runner,
      input,
      output,
      bootstrap: {
        disconnect: async () => {
          events.push('bootstrap:disconnect');
        },
      },
    });

    await cli.start();
    const stopped = await cli.stop();
    input.emit('1');
    runner.pushState(createRunnerState({
      running: true,
      revision: 99,
      screen: 'screen:ignored',
    }));

    assert.deepEqual(events, ['bootstrap:disconnect']);
    assert.equal(input.unsubscribeCount, 1);
    assert.equal(runner.unsubscribeCount, 1);
    assert.equal(runner.stopCalls, 1);
    assert.deepEqual(runner.submitTokens, []);
    assert.equal(output.repaints.length, 1);
    assert.equal(stopped.running, false);
    assert.equal(stopped.runnerState.running, false);
  });
});
