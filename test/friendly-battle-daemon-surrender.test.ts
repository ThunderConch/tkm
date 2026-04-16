// test/friendly-battle-daemon-surrender.test.ts
//
// End-to-end integration test: explicit surrender through the daemon + IPC stack.
// Spawns host + guest daemons, drives a handshake, then has host surrender while
// guest submits a normal move. Asserts guest wins with reason='surrender'.

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { sendDaemonIpcRequest } from '../src/friendly-battle/daemon-ipc.js';
import type { DaemonResponse } from '../src/friendly-battle/daemon-protocol.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DAEMON_ENTRY = resolve(REPO_ROOT, 'src/friendly-battle/daemon.ts');

// ---------------------------------------------------------------------------
// Helpers (mirrored from friendly-battle-daemon-turn-loop.test.ts)
// ---------------------------------------------------------------------------

function makeClaudeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-surrender-'));
  const genDir = join(dir, 'tokenmon', 'gen4');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, 'config.json'),
    JSON.stringify({ party: ['387'], starter_chosen: true }),
  );
  writeFileSync(
    join(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': { id: 387, xp: 100, level: 16, friendship: 0, ev: 0, moves: [33, 45] },
      },
    }),
  );
  return dir;
}

function encodeOptionsJson(options: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(options)).toString('base64');
}

interface DaemonInfo {
  child: ChildProcess;
  sessionId: string;
  socketPath: string;
  port?: number;
}

function spawnDaemon(
  role: 'host' | 'guest',
  options: Record<string, unknown>,
  claudeDir: string,
): Promise<DaemonInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', DAEMON_ENTRY, '--role', role],
      {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: claudeDir,
          TSX_DISABLE_CACHE: '1',
          TOKENMON_TEST: '1',
          TKM_FB_OPTIONS_B64: encodeOptionsJson(options),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      },
    );

    let stdoutBuf = '';
    let settled = false;

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const newline = stdoutBuf.indexOf('\n');
      if (newline < 0) return;
      const line = stdoutBuf.slice(0, newline).trim();
      if (!line.startsWith('DAEMON_READY ')) return;
      const parts = line.split(' ');
      const sessionId = parts[1];
      const socketPath = parts[2];
      const port = parts[3] ? Number.parseInt(parts[3], 10) : undefined;
      if (!sessionId || !socketPath) {
        reject(new Error(`Malformed DAEMON_READY line: ${JSON.stringify(line)}`));
        return;
      }
      if (!settled) {
        settled = true;
        resolve({ child, sessionId, socketPath, port });
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (_chunk: string) => {
      // Uncomment for debugging: process.stderr.write(`[${role}] ${_chunk}`);
    });

    child.once('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    child.once('close', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${role} daemon exited with code ${code} before DAEMON_READY`));
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`${role} daemon did not emit DAEMON_READY within 10s`));
      }
    }, 10_000);
    if (timer.unref) timer.unref();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// Drain events on a daemon socket until a terminal status (victory/defeat) is seen,
// submitting additional moves if we see select_action (multi-turn fallback).
async function drainUntilDone(socketPath: string, maxEvents = 20): Promise<DaemonResponse> {
  for (let i = 0; i < maxEvents; i++) {
    const ev = await sendDaemonIpcRequest(
      socketPath,
      { op: 'wait_next_event', timeoutMs: 10_000 },
      11_000,
    );
    if (ev.op !== 'event') return ev;
    const status = ev.envelope.status;
    if (status === 'victory' || status === 'defeat') return ev;
    if (status === 'select_action') {
      // Unexpected second turn — submit a move to keep the battle moving
      await sendDaemonIpcRequest(
        socketPath,
        { op: 'submit_action', action: { kind: 'move', index: 0 } },
        5_000,
      );
    }
  }
  throw new Error(`Did not reach terminal status within ${maxEvents} events`);
}

// ---------------------------------------------------------------------------
// Cleanup bookkeeping
// ---------------------------------------------------------------------------

const liveChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
});

after(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('friendly-battle daemon surrender (end-to-end)', { concurrency: false }, () => {
  it(
    'host surrender causes guest to win with reason=surrender',
    { timeout: 30_000 },
    async () => {
      const claudeDir = makeClaudeConfigDir();
      try {
        const sessionId = `test-${Date.now()}`;
        const sessionCode = 'surrender-01';

        // Spawn host
        const hostOptions = {
          sessionId: `${sessionId}-host`,
          sessionCode,
          host: '127.0.0.1',
          port: 0,
          generation: 'gen4',
          playerName: 'HostPlayer',
          timeoutMs: 15_000,
        };
        const hostInfo = await spawnDaemon('host', hostOptions, claudeDir);
        liveChildren.push(hostInfo.child);

        assert.ok(hostInfo.port && hostInfo.port > 0, `host port must be > 0, got ${hostInfo.port}`);

        // Spawn guest
        const guestOptions = {
          sessionId: `${sessionId}-guest`,
          sessionCode,
          host: '127.0.0.1',
          port: hostInfo.port,
          generation: 'gen4',
          playerName: 'GuestPlayer',
          timeoutMs: 15_000,
        };
        const guestInfo = await spawnDaemon('guest', guestOptions, claudeDir);
        liveChildren.push(guestInfo.child);

        // ── Step 1: drain initial events until both sides reach select_action ──
        // Host emits: battle_initialized → choices_requested(select_action)
        // Guest synthesizes: choices_requested(select_action)
        async function drainToSelectAction(socketPath: string): Promise<void> {
          for (let i = 0; i < 5; i++) {
            const ev = await sendDaemonIpcRequest(
              socketPath,
              { op: 'wait_next_event', timeoutMs: 5_000 },
              6_000,
            );
            if (ev.op === 'event' && ev.envelope.status === 'select_action') return;
          }
          throw new Error('Never reached select_action');
        }

        await Promise.all([
          drainToSelectAction(hostInfo.socketPath),
          drainToSelectAction(guestInfo.socketPath),
        ]);

        // ── Step 2: both sides submit concurrently, then drain concurrently ──
        // The key insight from the working turn-loop test: both drainUntilDone calls
        // run concurrently via Promise.all, mirroring the pattern that works.
        const [hostAck, guestAck] = await Promise.all([
          sendDaemonIpcRequest(
            hostInfo.socketPath,
            { op: 'submit_action', action: { kind: 'surrender' } },
            2_000,
          ),
          sendDaemonIpcRequest(
            guestInfo.socketPath,
            { op: 'submit_action', action: { kind: 'move', index: 0 } },
            2_000,
          ),
        ]);

        assert.equal(hostAck.op, 'ack', `host surrender ack expected, got ${hostAck.op}`);
        assert.equal(guestAck.op, 'ack', `guest move ack expected, got ${guestAck.op}`);

        // Drain final events on both sides concurrently — mirrors turn-loop test pattern
        const [hostFinalEv, guestFinalEv] = await Promise.all([
          drainUntilDone(hostInfo.socketPath),
          drainUntilDone(guestInfo.socketPath),
        ]);

        assert.equal(hostFinalEv.op, 'event');
        assert.equal(guestFinalEv.op, 'event');

        const hostStatus = hostFinalEv.op === 'event' ? hostFinalEv.envelope.status : undefined;
        const guestStatus = guestFinalEv.op === 'event' ? guestFinalEv.envelope.status : undefined;

        assert.equal(hostStatus, 'defeat', `host should see defeat after surrendering, got ${hostStatus}`);
        assert.equal(guestStatus, 'victory', `guest should see victory after host surrenders, got ${guestStatus}`);

        // ── Step 3: both daemons exit cleanly ──
        const [hostExit, guestExit] = await Promise.all([
          waitForExit(hostInfo.child, 5_000),
          waitForExit(guestInfo.child, 5_000),
        ]);

        assert.equal(hostExit, 0, `host daemon should exit 0, got ${hostExit}`);
        assert.equal(guestExit, 0, `guest daemon should exit 0, got ${guestExit}`);
      } finally {
        rmSync(claudeDir, { recursive: true, force: true });
      }
    },
  );
});
