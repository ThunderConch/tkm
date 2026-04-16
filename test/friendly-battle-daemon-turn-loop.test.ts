// test/friendly-battle-daemon-turn-loop.test.ts
//
// End-to-end integration test: spawn host + guest daemons with real TCP
// transport and real UNIX socket IPC. Drives a full move-only turn until
// battle_finished, then asserts both daemons exit cleanly.

import { after, afterEach, before, describe, it } from 'node:test';
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
// Helpers
// ---------------------------------------------------------------------------

function makeClaudeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-turn-loop-'));
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
  port?: number;   // only for host
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
      // DAEMON_READY <sessionId> <socketPath> [port]
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
      // stderr is intentionally suppressed; uncomment for debugging:
      // process.stderr.write(`[${role} daemon] ${_chunk}`);
    });

    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // If child exits before DAEMON_READY, reject
    child.once('close', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${role} daemon exited with code ${code} before DAEMON_READY`));
      }
    });

    // Timeout guard
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`${role} daemon did not emit DAEMON_READY within 10s`));
      }
    }, 10_000);
    // Don't let the timer prevent process exit if test ends early
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

// ---------------------------------------------------------------------------
// Keep track of spawned children for afterEach cleanup
// ---------------------------------------------------------------------------
const liveChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  }
});

after(() => {
  // Final cleanup pass — belt and suspenders
  for (const child of liveChildren) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('friendly-battle daemon turn loop (end-to-end)', { concurrency: false }, () => {
  it('both daemons emit DAEMON_READY and complete a full battle turn loop', async () => {
    // One shared CLAUDE_CONFIG_DIR so both daemons load the same pokemon profile
    const claudeDir = makeClaudeConfigDir();
    try {
      const sessionId = `test-${Date.now()}`;
      const sessionCode = 'turnloop-01';

      // Spawn host with port 0 (OS picks)
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

      // Host must have emitted a port
      assert.ok(hostInfo.port && hostInfo.port > 0, `host port must be > 0, got ${hostInfo.port}`);

      // 1. Both daemons passed DAEMON_READY
      assert.ok(hostInfo.sessionId, 'host sessionId present');
      assert.ok(hostInfo.socketPath, 'host socketPath present');

      // Spawn guest connecting to host's actual port
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

      assert.ok(guestInfo.sessionId, 'guest sessionId present');
      assert.ok(guestInfo.socketPath, 'guest socketPath present');

      // 2. Both sides should serve wait_next_event with status=select_action
      const [hostFirstEvent, guestFirstEvent] = await Promise.all([
        sendDaemonIpcRequest(
          hostInfo.socketPath,
          { op: 'wait_next_event', timeoutMs: 5_000 },
          6_000,
        ),
        sendDaemonIpcRequest(
          guestInfo.socketPath,
          { op: 'wait_next_event', timeoutMs: 5_000 },
          6_000,
        ),
      ]);

      assert.equal(hostFirstEvent.op, 'event', `host first event op should be 'event', got ${hostFirstEvent.op}`);
      assert.equal(guestFirstEvent.op, 'event', `guest first event op should be 'event', got ${guestFirstEvent.op}`);

      // The first event the host gets is battle_initialized, then choices_requested.
      // Wait for the choices_requested one (status=select_action):
      let hostEventEnv = hostFirstEvent.op === 'event' ? hostFirstEvent.envelope : undefined;
      let guestEventEnv = guestFirstEvent.op === 'event' ? guestFirstEvent.envelope : undefined;

      // If the first event is battle_initialized, drain one more to get choices_requested
      if (hostEventEnv && hostEventEnv.status !== 'select_action') {
        const second = await sendDaemonIpcRequest(
          hostInfo.socketPath,
          { op: 'wait_next_event', timeoutMs: 5_000 },
          6_000,
        );
        assert.equal(second.op, 'event');
        hostEventEnv = second.op === 'event' ? second.envelope : hostEventEnv;
      }

      if (guestEventEnv && guestEventEnv.status !== 'select_action') {
        const second = await sendDaemonIpcRequest(
          guestInfo.socketPath,
          { op: 'wait_next_event', timeoutMs: 5_000 },
          6_000,
        );
        assert.equal(second.op, 'event');
        guestEventEnv = second.op === 'event' ? second.envelope : guestEventEnv;
      }

      // 3. Both sides should now have status=select_action and moveOptions
      assert.equal(hostEventEnv?.status, 'select_action', `host status: ${JSON.stringify(hostEventEnv?.status)}`);
      assert.equal(guestEventEnv?.status, 'select_action', `guest status: ${JSON.stringify(guestEventEnv?.status)}`);
      assert.ok(Array.isArray(hostEventEnv?.moveOptions) && (hostEventEnv?.moveOptions.length ?? 0) > 0, 'host has moveOptions');
      assert.ok(Array.isArray(guestEventEnv?.moveOptions) && (guestEventEnv?.moveOptions.length ?? 0) > 0, 'guest has moveOptions');

      // 4. Submit a move from each side
      const [hostAck, guestAck] = await Promise.all([
        sendDaemonIpcRequest(
          hostInfo.socketPath,
          { op: 'submit_action', action: { kind: 'move', index: 0 } },
          5_000,
        ),
        sendDaemonIpcRequest(
          guestInfo.socketPath,
          { op: 'submit_action', action: { kind: 'move', index: 0 } },
          5_000,
        ),
      ]);

      assert.equal(hostAck.op, 'ack', `host submit_action should ack, got ${hostAck.op}`);
      assert.equal(guestAck.op, 'ack', `guest submit_action should ack, got ${guestAck.op}`);

      // 5. Drain events until battle_finished on both sides
      async function drainUntilDone(socketPath: string, maxEvents = 20): Promise<DaemonResponse> {
        for (let i = 0; i < maxEvents; i++) {
          const ev = await sendDaemonIpcRequest(
            socketPath,
            { op: 'wait_next_event', timeoutMs: 10_000 },
            11_000,
          );
          if (ev.op !== 'event') return ev;
          const status = ev.envelope.status;
          if (status === 'victory' || status === 'defeat') {
            return ev;
          }
          if (status === 'select_action') {
            // Another turn needed — submit move again
            await sendDaemonIpcRequest(
              socketPath,
              { op: 'submit_action', action: { kind: 'move', index: 0 } },
              5_000,
            );
          }
        }
        throw new Error(`Did not reach battle_finished within ${maxEvents} events`);
      }

      const [hostFinalEv, guestFinalEv] = await Promise.all([
        drainUntilDone(hostInfo.socketPath),
        drainUntilDone(guestInfo.socketPath),
      ]);

      // 6. Both sides see a terminal status
      assert.equal(hostFinalEv.op, 'event', `host final op: ${hostFinalEv.op}`);
      assert.equal(guestFinalEv.op, 'event', `guest final op: ${guestFinalEv.op}`);

      const hostFinalStatus = hostFinalEv.op === 'event' ? hostFinalEv.envelope.status : undefined;
      const guestFinalStatus = guestFinalEv.op === 'event' ? guestFinalEv.envelope.status : undefined;

      assert.ok(
        hostFinalStatus === 'victory' || hostFinalStatus === 'defeat',
        `host final status should be victory or defeat, got ${hostFinalStatus}`,
      );
      assert.ok(
        guestFinalStatus === 'victory' || guestFinalStatus === 'defeat',
        `guest final status should be victory or defeat, got ${guestFinalStatus}`,
      );

      // Winners should be complementary (one wins, one loses)
      const hostWon = hostFinalStatus === 'victory';
      const guestWon = guestFinalStatus === 'victory';
      assert.ok(hostWon !== guestWon, 'exactly one side should win');

      // 7. Both daemons should exit within 5 seconds after battle_finished
      const [hostExit, guestExit] = await Promise.all([
        waitForExit(hostInfo.child, 5_000),
        waitForExit(guestInfo.child, 5_000),
      ]);

      assert.equal(hostExit, 0, `host daemon should exit 0, got ${hostExit}`);
      assert.equal(guestExit, 0, `guest daemon should exit 0, got ${guestExit}`);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});
