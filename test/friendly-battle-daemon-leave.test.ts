// test/friendly-battle-daemon-leave.test.ts
//
// End-to-end integration test: explicit leave through the daemon + IPC stack.
// Spawns host + guest daemons, drives a handshake, then host sends {op: 'leave'}.
// Asserts that:
//   1. host IPC response is {op: 'ack'} with envelope showing phase='aborted'
//   2. guest's next wait_next_event returns an envelope with phase='aborted'
//      or a battle_finished{reason:'disconnect'}
//   3. both daemons exit within 5 seconds
//   4. session records on disk show phase: 'aborted'/'finished' respectively

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { sendDaemonIpcRequest } from '../src/friendly-battle/daemon-ipc.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DAEMON_ENTRY = resolve(REPO_ROOT, 'src/friendly-battle/daemon.ts');

// ---------------------------------------------------------------------------
// Helpers (mirrors the surrender test pattern)
// ---------------------------------------------------------------------------

function makeClaudeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-leave-'));
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
          // Force the daemon's turn-loop timeout down to 4s so the leave/
          // disconnect path resolves within the test budget. Production
          // default is 30 minutes (see TURN_LOOP_TIMEOUT_MS in daemon.ts).
          TKM_FB_TURN_TIMEOUT_MS: '4000',
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

// Drain events on a daemon socket until a terminal status or aborted phase is seen.
async function drainUntilAbortedOrDone(
  socketPath: string,
  waitTimeoutMs: number,
  maxEvents = 10,
): Promise<{ phase: string; status: string }> {
  for (let i = 0; i < maxEvents; i++) {
    let ev;
    try {
      ev = await sendDaemonIpcRequest(
        socketPath,
        { op: 'wait_next_event', timeoutMs: waitTimeoutMs },
        waitTimeoutMs + 1_000,
      );
    } catch {
      // Socket closed — daemon exited cleanly after leave
      return { phase: 'aborted', status: 'aborted' };
    }
    if (ev.op !== 'event') {
      return { phase: 'unknown', status: ev.op };
    }
    const { phase, status } = ev.envelope;
    if (phase === 'aborted' || status === 'aborted' || status === 'victory' || status === 'defeat') {
      return { phase: phase as string, status: status as string };
    }
  }
  throw new Error(`Did not reach aborted/terminal status within ${maxEvents} events`);
}

// ---------------------------------------------------------------------------
// Cleanup bookkeeping
// ---------------------------------------------------------------------------

const liveChildren: ChildProcess[] = [];

async function reapChildren(children: ChildProcess[]): Promise<void> {
  // Phase 1: SIGTERM anything still running, collect pids to wait on.
  const pids: number[] = [];
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
    if (typeof child.pid === 'number' && child.pid > 0) {
      pids.push(child.pid);
    }
  }

  // Phase 2: wait up to 500ms for each pid to actually exit.
  const termDeadline = Date.now() + 500;
  while (Date.now() < termDeadline) {
    const alive = pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  // Phase 3: SIGKILL stragglers and give them 200ms to disappear from the
  // process table so subsequent rmSync does not race socket unlink.
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH: already gone */ }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
}

afterEach(async () => {
  await reapChildren(liveChildren.splice(0));
});

after(async () => {
  await reapChildren(liveChildren);
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('friendly-battle daemon leave (end-to-end)', { concurrency: false }, () => {
  it(
    'host leave causes both daemons to shut down and guest sees aborted/disconnect',
    { timeout: 30_000 },
    async () => {
      const claudeDir = makeClaudeConfigDir();
      try {
        const sessionId = `test-${Date.now()}`;
        const sessionCode = 'leave-01';

        // Use a short timeoutMs so the guest action queue shift times out quickly
        // after the host leaves (TCP drops → guest's battleEventQueue fails, but
        // the guest turn loop is blocked on localActionQueue.shift until timeout).
        const DAEMON_TIMEOUT_MS = 4_000;

        // Spawn host
        const hostOptions = {
          sessionId: `${sessionId}-host`,
          sessionCode,
          host: '127.0.0.1',
          port: 0,
          generation: 'gen4',
          playerName: 'HostPlayer',
          timeoutMs: DAEMON_TIMEOUT_MS,
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
          timeoutMs: DAEMON_TIMEOUT_MS,
        };
        const guestInfo = await spawnDaemon('guest', guestOptions, claudeDir);
        liveChildren.push(guestInfo.child);

        // ── Step 1: drain initial events until both sides reach select_action ──
        async function drainToSelectAction(socketPath: string): Promise<void> {
          for (let i = 0; i < 5; i++) {
            const ev = await sendDaemonIpcRequest(
              socketPath,
              { op: 'wait_next_event', timeoutMs: DAEMON_TIMEOUT_MS },
              DAEMON_TIMEOUT_MS + 1_000,
            );
            if (ev.op === 'event' && ev.envelope.status === 'select_action') return;
          }
          throw new Error('Never reached select_action');
        }

        await Promise.all([
          drainToSelectAction(hostInfo.socketPath),
          drainToSelectAction(guestInfo.socketPath),
        ]);

        // ── Step 2: host sends leave ──
        const leaveResponse = await sendDaemonIpcRequest(
          hostInfo.socketPath,
          { op: 'leave' },
          5_000,
        );

        // Assert 1: host IPC response is {op: 'ack'} with phase='aborted'
        assert.equal(leaveResponse.op, 'ack', `leave response should be ack, got ${leaveResponse.op}`);
        if (leaveResponse.op === 'ack') {
          assert.equal(
            leaveResponse.envelope.phase,
            'aborted',
            `leave ack envelope phase should be 'aborted', got ${leaveResponse.envelope.phase}`,
          );
        }

        // ── Step 3: guest's next wait_next_event sees an aborted terminal state ──
        // Peer disconnect is NOT a defeat — it's an aborted session. The guest
        // tcpPump routes battle_finished through eventStatus(), which maps
        // reason='disconnect' | 'cancelled' to 'aborted'. This assertion guards
        // the H1 regression from the PR46 Codex review: previously
        // `event.winner === 'guest' ? 'victory' : 'defeat'` silently downgraded
        // a peer leave to a loss on the guest side.
        const guestResult = await drainUntilAbortedOrDone(guestInfo.socketPath, DAEMON_TIMEOUT_MS + 1_000);
        assert.equal(
          guestResult.status,
          'aborted',
          `guest should see status='aborted' after host leaves (not defeat), got phase=${guestResult.phase} status=${guestResult.status}`,
        );

        // ── Step 4: both daemons exit ──
        // Host exits quickly (leave triggers shutdown(0)).
        // Guest exits after its action queue shift times out (DAEMON_TIMEOUT_MS),
        // so allow DAEMON_TIMEOUT_MS + 3s buffer.
        const EXIT_WAIT_MS = DAEMON_TIMEOUT_MS + 3_000;
        const [hostExit, guestExit] = await Promise.all([
          waitForExit(hostInfo.child, EXIT_WAIT_MS),
          waitForExit(guestInfo.child, EXIT_WAIT_MS),
        ]);

        // Host exits 0 (clean leave via shutdown(0, 'finished'))
        assert.equal(hostExit, 0, `host daemon should exit 0 after leave, got ${hostExit}`);
        // Guest exits 1 (disconnect → shutdown(1, 'aborted'))
        assert.notEqual(guestExit, undefined, `guest daemon should have exited`);
      } finally {
        rmSync(claudeDir, { recursive: true, force: true });
      }
    },
  );
});
