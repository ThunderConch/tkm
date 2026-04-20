import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createPvpSessionTerminalSnapshot,
  createPvpSessionTerminalStdioAdapter,
  type PvpSessionTerminalRunnerState,
  type PvpSessionTerminalStdioAbortEvent,
} from '../src/pvp/index.js';
import { CLEAR_SCREEN, CURSOR_HOME, HIDE_CURSOR, SHOW_CURSOR } from '../src/battle-tui/ansi.js';

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

class FakeStdin extends EventEmitter {
  isTTY: boolean;

  readonly rawModeCalls: boolean[] = [];

  readonly encodings: string[] = [];

  resumeCalls = 0;

  pauseCalls = 0;

  constructor(options: { isTTY: boolean }) {
    super();
    this.isTTY = options.isTTY;
  }

  setRawMode(enabled: boolean): void {
    this.rawModeCalls.push(enabled);
  }

  resume(): void {
    this.resumeCalls += 1;
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  setEncoding(encoding: string): void {
    this.encodings.push(encoding);
  }
}

class FakeStdout {
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

class FakeReadline extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
    this.emit('close');
  }
}

describe('pvp session terminal stdio adapter', () => {
  it('maps tty single-key aliases from the latest rendered state and restores raw mode on unsubscribe', () => {
    const stdin = new FakeStdin({ isTTY: true });
    const stdout = new FakeStdout();
    const signals = new EventEmitter();
    const aborts: PvpSessionTerminalStdioAbortEvent[] = [];
    const adapter = createPvpSessionTerminalStdioAdapter({
      stdin,
      stdout,
      signalTarget: signals,
      onAbort: (event) => {
        aborts.push(event);
      },
    });
    const observed: string[] = [];

    adapter.repaint('screen:turn', createRunnerState({
      running: true,
      revision: 2,
      screen: 'screen:turn',
      availableInputTokens: ['switch:2', 'forfeit'],
    }));

    const unsubscribe = adapter.subscribe((token) => {
      observed.push(token);
    });

    stdin.emit('data', '2');
    stdin.emit('data', 'f');
    stdin.emit('data', 'switch:2');
    stdin.emit('data', '\x03');

    assert.deepEqual(observed, ['switch:2', 'forfeit', 'switch:2']);
    assert.equal(aborts.length, 1);
    assert.equal(aborts[0]?.reason, 'sigint');
    assert.deepEqual(stdin.rawModeCalls, [true]);
    assert.equal(stdin.resumeCalls, 1);
    assert.deepEqual(stdin.encodings, ['utf8']);
    assert.equal((stdout.writes[0] ?? '').includes(`${HIDE_CURSOR}${CLEAR_SCREEN}${CURSOR_HOME}screen:turn`), true);

    unsubscribe();

    assert.deepEqual(stdin.rawModeCalls, [true, false]);
    assert.equal(stdin.pauseCalls, 1);
    assert.equal(stdout.writes.at(-1), SHOW_CURSOR);
  });

  it('uses readline fallback for non-tty stdin and does not emit abort while closing explicitly', () => {
    const stdin = new FakeStdin({ isTTY: false });
    const stdout = new FakeStdout();
    const signals = new EventEmitter();
    const aborts: PvpSessionTerminalStdioAbortEvent[] = [];
    const readline = new FakeReadline();
    const adapter = createPvpSessionTerminalStdioAdapter({
      stdin,
      stdout,
      signalTarget: signals,
      createReadlineInterface: () => readline,
      onAbort: (event) => {
        aborts.push(event);
      },
    });
    const observed: string[] = [];

    adapter.repaint('screen:switch', createRunnerState({
      running: true,
      revision: 3,
      screen: 'screen:switch',
      availableInputTokens: ['1', 'switch:2', 'forfeit'],
    }));

    const unsubscribe = adapter.subscribe((token) => {
      observed.push(token);
    });

    readline.emit('line', ' 2 ');
    readline.emit('line', ' forfeit ');

    assert.deepEqual(observed, ['switch:2', 'forfeit']);

    unsubscribe();

    assert.equal(readline.closeCalls, 1);
    assert.equal(aborts.length, 0);
  });

  it('treats unexpected readline close as eof abort', () => {
    const stdin = new FakeStdin({ isTTY: false });
    const stdout = new FakeStdout();
    const aborts: PvpSessionTerminalStdioAbortEvent[] = [];
    const readline = new FakeReadline();
    const adapter = createPvpSessionTerminalStdioAdapter({
      stdin,
      stdout,
      createReadlineInterface: () => readline,
      onAbort: (event) => {
        aborts.push(event);
      },
    });

    const unsubscribe = adapter.subscribe(() => {});
    readline.emit('close');

    assert.equal(aborts.length, 1);
    assert.equal(aborts[0]?.reason, 'eof');

    unsubscribe();
  });
});
