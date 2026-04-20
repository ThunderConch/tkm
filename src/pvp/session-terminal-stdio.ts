import { createInterface as createNodeReadlineInterface } from 'node:readline';

import { CLEAR_SCREEN, CURSOR_HOME, HIDE_CURSOR, SHOW_CURSOR } from '../battle-tui/ansi.js';
import type {
  PvpSessionTerminalCliInputListener,
  PvpSessionTerminalCliInputSource,
  PvpSessionTerminalCliScreenOutput,
} from './session-terminal-cli.js';
import type { PvpSessionTerminalRunnerState } from './session-terminal-runner.js';

export type PvpSessionTerminalStdioAbortReason = 'sigint' | 'eof' | 'signal';

export interface PvpSessionTerminalStdioAbortEvent {
  reason: PvpSessionTerminalStdioAbortReason;
  signal?: string;
}

export interface PvpSessionTerminalStdioInput {
  isTTY?: boolean;
  on(event: 'data', listener: (chunk: string | Buffer) => void): this;
  off?(event: 'data', listener: (chunk: string | Buffer) => void): this;
  removeListener?(event: 'data', listener: (chunk: string | Buffer) => void): this;
  setRawMode?(enabled: boolean): void;
  setEncoding?(encoding: BufferEncoding): void;
  resume(): void;
  pause(): void;
}

export interface PvpSessionTerminalStdioOutput {
  write(chunk: string): boolean;
}

export interface PvpSessionTerminalStdioSignalTarget {
  on(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

export interface PvpSessionTerminalStdioReadlineLike {
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'close', listener: () => void): this;
  off?(event: 'line' | 'close', listener: ((line: string) => void) | (() => void)): this;
  removeListener?(event: 'line' | 'close', listener: ((line: string) => void) | (() => void)): this;
  close(): void;
}

export interface CreatePvpSessionTerminalStdioAdapterOptions {
  stdin?: PvpSessionTerminalStdioInput;
  stdout?: PvpSessionTerminalStdioOutput;
  signalTarget?: PvpSessionTerminalStdioSignalTarget;
  createReadlineInterface?: () => PvpSessionTerminalStdioReadlineLike;
  onAbort?: (event: PvpSessionTerminalStdioAbortEvent) => void;
  prompt?: string;
}

export interface PvpSessionTerminalStdioAbortHandlerTarget {
  setAbortHandler(handler: (() => void) | null): void;
}

function detachListener<TEvent extends string, TListener extends (...args: any[]) => void>(
  target: {
    off?: (event: TEvent, listener: TListener) => unknown;
    removeListener?: (event: TEvent, listener: TListener) => unknown;
  },
  event: TEvent,
  listener: TListener,
): void {
  if (typeof target.off === 'function') {
    target.off(event, listener);
    return;
  }

  if (typeof target.removeListener === 'function') {
    target.removeListener(event, listener);
  }
}

function renderScreen(screen: string, prompt: string, buffer: string): string {
  const promptLine = `${prompt}${buffer}`;
  return `${HIDE_CURSOR}${CLEAR_SCREEN}${CURSOR_HOME}${screen}\n\n${promptLine}`;
}

function normalizeRawToken(rawToken: string): string {
  return rawToken.trim();
}

export class PvpSessionTerminalStdioAdapter
  implements PvpSessionTerminalCliInputSource, PvpSessionTerminalCliScreenOutput, PvpSessionTerminalStdioAbortHandlerTarget {
  private readonly stdin: PvpSessionTerminalStdioInput;

  private readonly stdout: PvpSessionTerminalStdioOutput;

  private readonly signalTarget: PvpSessionTerminalStdioSignalTarget | null;

  private readonly createReadlineInterface: () => PvpSessionTerminalStdioReadlineLike;

  private readonly onAbort: ((event: PvpSessionTerminalStdioAbortEvent) => void) | null;

  private readonly prompt: string;

  private readonly listeners = new Set<PvpSessionTerminalCliInputListener>();

  private readonly ttyDataListener = (chunk: string | Buffer): void => {
    this.handleTtyChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };

  private readonly readlineLineListener = (line: string): void => {
    this.emitResolvedToken(line);
  };

  private readonly readlineCloseListener = (): void => {
    if (this.closingReadline) {
      return;
    }

    this.dispatchAbort({ reason: 'eof' });
  };

  private readonly signalListeners = new Map<string, () => void>();

  private latestScreen = '';

  private latestState: PvpSessionTerminalRunnerState | null = null;

  private buffer = '';

  private active = false;

  private readline: PvpSessionTerminalStdioReadlineLike | null = null;

  private closingReadline = false;

  private abortHandler: (() => void) | null = null;

  constructor(options: CreatePvpSessionTerminalStdioAdapterOptions = {}) {
    this.stdin = options.stdin ?? (process.stdin as unknown as PvpSessionTerminalStdioInput);
    this.stdout = options.stdout ?? (process.stdout as unknown as PvpSessionTerminalStdioOutput);
    this.signalTarget = options.signalTarget ?? (process as unknown as PvpSessionTerminalStdioSignalTarget);
    this.createReadlineInterface = options.createReadlineInterface
      ?? (() => createNodeReadlineInterface({
        input: this.stdin as unknown as NodeJS.ReadableStream,
        output: this.stdout as unknown as NodeJS.WritableStream,
        terminal: false,
      }) as unknown as PvpSessionTerminalStdioReadlineLike);
    this.onAbort = options.onAbort ?? null;
    this.prompt = options.prompt ?? '> ';
  }

  subscribe(listener: PvpSessionTerminalCliInputListener): () => void {
    this.listeners.add(listener);

    if (!this.active) {
      this.activate();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.deactivate();
      }
    };
  }

  repaint(screen: string, state: PvpSessionTerminalRunnerState): void {
    this.latestScreen = screen;
    this.latestState = structuredClone(state);

    if (this.active) {
      this.stdout.write(renderScreen(this.latestScreen, this.prompt, this.buffer));
    }
  }

  setAbortHandler(handler: (() => void) | null): void {
    this.abortHandler = handler;
  }

  private activate(): void {
    this.active = true;
    this.buffer = '';

    if (this.stdin.isTTY) {
      this.stdin.setEncoding?.('utf8');
      this.stdin.setRawMode?.(true);
      this.stdin.resume();
      this.stdin.on('data', this.ttyDataListener);
    } else {
      this.readline = this.createReadlineInterface();
      this.readline.on('line', this.readlineLineListener);
      this.readline.on('close', this.readlineCloseListener);
    }

    this.bindSignals();
    this.stdout.write(renderScreen(this.latestScreen, this.prompt, this.buffer));
  }

  private deactivate(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.unbindSignals();

    if (this.stdin.isTTY) {
      detachListener(this.stdin, 'data', this.ttyDataListener);
      this.stdin.setRawMode?.(false);
      this.stdin.pause();
    }

    if (this.readline) {
      this.closingReadline = true;
      detachListener(this.readline, 'line', this.readlineLineListener);
      detachListener(this.readline, 'close', this.readlineCloseListener);
      this.readline.close();
      this.readline = null;
      this.closingReadline = false;
    }

    this.stdout.write(SHOW_CURSOR);
    this.buffer = '';
  }

  private bindSignals(): void {
    if (!this.signalTarget || this.signalListeners.size > 0) {
      return;
    }

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const listener = (): void => {
        this.dispatchAbort({
          reason: signal === 'SIGINT' ? 'sigint' : 'signal',
          signal,
        });
      };

      this.signalListeners.set(signal, listener);
      this.signalTarget.on(signal, listener);
    }
  }

  private unbindSignals(): void {
    if (!this.signalTarget) {
      return;
    }

    for (const [signal, listener] of this.signalListeners.entries()) {
      detachListener(this.signalTarget, signal, listener);
    }

    this.signalListeners.clear();
  }

  private handleTtyChunk(chunk: string): void {
    if (!chunk) {
      return;
    }

    const trimmedChunk = normalizeRawToken(chunk);
    if (trimmedChunk && !chunk.includes('\n') && !chunk.includes('\r')) {
      const immediateToken = this.resolveAlias(trimmedChunk);
      if (immediateToken) {
        this.publishToken(immediateToken);
        return;
      }
    }

    for (const char of chunk) {
      if (char === '\u0003') {
        this.dispatchAbort({ reason: 'sigint' });
        continue;
      }

      if (char === '\u0004') {
        this.dispatchAbort({ reason: 'eof' });
        continue;
      }

      if (char === '\r' || char === '\n') {
        this.emitResolvedToken(this.buffer);
        continue;
      }

      if (char === '\u007f') {
        this.buffer = this.buffer.slice(0, -1);
        this.repaintBuffer();
        continue;
      }

      const immediateToken = this.resolveAlias(char);
      if (immediateToken) {
        this.publishToken(immediateToken);
        continue;
      }

      this.buffer += char;
      this.repaintBuffer();
    }
  }

  private emitResolvedToken(rawToken: string): void {
    const token = normalizeRawToken(rawToken || this.buffer);
    this.buffer = '';
    this.repaintBuffer();

    if (!token) {
      return;
    }

    this.publishToken(this.resolveAlias(token) ?? token);
  }

  private publishToken(token: string): void {
    this.buffer = '';
    this.repaintBuffer();

    for (const listener of this.listeners) {
      listener(token);
    }
  }

  private repaintBuffer(): void {
    if (!this.active) {
      return;
    }

    this.stdout.write(renderScreen(this.latestScreen, this.prompt, this.buffer));
  }

  private resolveAlias(rawToken: string): string | null {
    const token = normalizeRawToken(rawToken);
    if (!token) {
      return null;
    }

    const availableInputTokens = this.latestState?.availableInputTokens ?? [];
    if (availableInputTokens.includes(token)) {
      return token;
    }

    if (/^\d+$/.test(token)) {
      const switchToken = `switch:${token}`;
      if (availableInputTokens.includes(switchToken)) {
        return switchToken;
      }
    }

    if (/^[fF]$/.test(token) && availableInputTokens.includes('forfeit')) {
      return 'forfeit';
    }

    return null;
  }

  private dispatchAbort(event: PvpSessionTerminalStdioAbortEvent): void {
    this.onAbort?.(event);
    this.abortHandler?.();
  }
}

export function createPvpSessionTerminalStdioAdapter(
  options: CreatePvpSessionTerminalStdioAdapterOptions = {},
): PvpSessionTerminalStdioAdapter {
  return new PvpSessionTerminalStdioAdapter(options);
}
