import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDaemonMessage,
  encodeDaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
} from '../src/friendly-battle/daemon-protocol.js';

describe('friendly-battle daemon protocol', { concurrency: false }, () => {
  it('encodes and decodes each DaemonRequest variant', () => {
    const variants: DaemonRequest[] = [
      { op: 'wait_next_event', timeoutMs: 1000 },
      { op: 'submit_action', action: { kind: 'move', index: 2 } },
      { op: 'submit_action', action: { kind: 'switch', pokemonIndex: 1 } },
      { op: 'submit_action', action: { kind: 'surrender' } },
      { op: 'status' },
      { op: 'ping' },
      { op: 'leave' },
    ];

    for (const variant of variants) {
      const encoded = encodeDaemonMessage(variant);
      assert.ok(encoded.endsWith('\n'), 'encoded message must end with newline');
      const decoded = decodeDaemonMessage<DaemonRequest>(encoded);
      assert.deepEqual(decoded, variant);
    }
  });

  it('encodes and decodes each DaemonResponse variant', () => {
    const stubEnvelope = {
      sessionId: 'fb-001',
      role: 'host' as const,
      phase: 'battle',
      status: 'select_action',
      questionContext: 'ctx',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    };
    const variants: DaemonResponse[] = [
      { op: 'event', envelope: stubEnvelope },
      { op: 'ack', envelope: stubEnvelope },
      { op: 'status', envelope: stubEnvelope },
      { op: 'pong', pid: 12345 },
      { op: 'error', code: 'not_ready', message: 'daemon not ready' },
    ];

    for (const variant of variants) {
      const decoded = decodeDaemonMessage<DaemonResponse>(encodeDaemonMessage(variant));
      assert.deepEqual(decoded, variant);
    }
  });

  it('rejects empty or whitespace-only lines', () => {
    assert.throws(() => decodeDaemonMessage(''), /empty line/);
    assert.throws(() => decodeDaemonMessage('   \n'), /empty line/);
  });
});
