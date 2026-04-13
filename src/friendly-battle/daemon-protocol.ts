import type { FriendlyBattleTurnJson } from './turn-json.js';

export type DaemonRequest =
  | { op: 'wait_next_event'; timeoutMs: number }
  | { op: 'submit_action'; action: DaemonAction }
  | { op: 'status' }
  | { op: 'ping' }
  | { op: 'leave' };

export type DaemonAction =
  | { kind: 'move'; index: number }
  | { kind: 'switch'; pokemonIndex: number }
  | { kind: 'surrender' };

export type DaemonResponse =
  | { op: 'event'; envelope: FriendlyBattleTurnJson }
  | { op: 'ack'; envelope: FriendlyBattleTurnJson }
  | { op: 'status'; envelope: FriendlyBattleTurnJson }
  | { op: 'pong'; pid: number }
  | { op: 'error'; code: string; message: string };

export function encodeDaemonMessage(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeDaemonMessage<T extends DaemonRequest | DaemonResponse>(
  line: string,
): T {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('daemon protocol: empty line');
  }
  return JSON.parse(trimmed) as T;
}
