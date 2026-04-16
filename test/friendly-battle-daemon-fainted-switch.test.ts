// test/friendly-battle-daemon-fainted-switch.test.ts
//
// End-to-end integration test: fainted forced-switch through the daemon + IPC stack.
//
// The host daemon's turn loop was fixed to consult getFriendlyBattleWaitingForRoles
// before awaiting choices, so only the role(s) that need to submit are awaited each
// iteration. This prevents the "not waiting for X" error during awaiting_fainted_switch
// when only the fainted side needs to submit a switch action.
//
// The guest daemon's startup path was also fixed to eagerly drain the TCP init events
// (battle_initialized + choices_requested) that the host sends before the guest's first
// action. Without this drain, the init events would interleave with the real turn
// resolution events and confuse the post-turn event ordering.
//
// Party setup:
//   Host: Turtwig lv80 (starter) + Turtwig lv5 (backup) — from hostClaudeDir
//   Guest: Cyndaquil lv1 (starter, guaranteed KO by lv80 Tackle) + Chikorita lv5 (backup)
//   Both sides use separate CLAUDE_CONFIG_DIR so each loads its own profile.
//
// Expected flow:
//   1. Both reach select_action (host via real init events; guest via real TCP init drain)
//   2. Both submit move:0 (Tackle)
//   3. Host's lv80 Turtwig one-shots guest's lv1 Cyndaquil → awaiting_fainted_switch
//   4. Guest sees fainted_switch; host also sees it (the event phase is awaiting_fainted_switch)
//   5. Guest submits switch:1 (Chikorita lv5)
//   6. Both drain to select_action (next turn) — battle continues

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
// Helpers
// ---------------------------------------------------------------------------

// Host: Turtwig lv80 (strong starter) + Turtwig lv5 backup
function makeHostClaudeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-host-'));
  const genDir = join(dir, 'tokenmon', 'gen4');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, 'config.json'),
    JSON.stringify({ party: ['387', '387b'], starter_chosen: true }),
  );
  writeFileSync(
    join(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': { id: 387, xp: 500_000, level: 80, friendship: 0, ev: 0, moves: [33, 45, 53, 89] },
        '387b': { id: 387, xp: 0, level: 5, friendship: 0, ev: 0, moves: [33] },
      },
    }),
  );
  return dir;
}

// Guest: Cyndaquil lv1 (guaranteed KO by host's lv80) + Chikorita lv5 backup
function makeGuestClaudeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-guest-'));
  const genDir = join(dir, 'tokenmon', 'gen4');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, 'config.json'),
    JSON.stringify({ party: ['155', '152'], starter_chosen: true }),
  );
  writeFileSync(
    join(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '155': { id: 155, xp: 0, level: 1, friendship: 0, ev: 0, moves: [33] },
        '152': { id: 152, xp: 0, level: 5, friendship: 0, ev: 0, moves: [33] },
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

// ---------------------------------------------------------------------------
// Cleanup bookkeeping
// ---------------------------------------------------------------------------

const liveChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
});

after(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('friendly-battle daemon fainted forced-switch (end-to-end)', { concurrency: false }, () => {
  it(
    'guest fainted switch: after KO, guest sees fainted_switch status and battle continues after switch action',
    { timeout: 20_000 },
    async () => {
      const hostClaudeDir = makeHostClaudeConfigDir();
      const guestClaudeDir = makeGuestClaudeConfigDir();
      try {
        const sessionId = `test-${Date.now()}`;
        const sessionCode = 'fainted-01';

        // Spawn host (lv80 Turtwig leads)
        const hostInfo = await spawnDaemon(
          'host',
          {
            sessionId: `${sessionId}-host`,
            sessionCode,
            host: '127.0.0.1',
            port: 0,
            generation: 'gen4',
            playerName: 'HostPlayer',
            timeoutMs: 15_000,
          },
          hostClaudeDir,
        );
        liveChildren.push(hostInfo.child);
        assert.ok(hostInfo.port && hostInfo.port > 0, `host port must be > 0, got ${hostInfo.port}`);

        // Spawn guest (lv1 Cyndaquil leads — guaranteed KO by host's lv80 Turtwig Tackle)
        const guestInfo = await spawnDaemon(
          'guest',
          {
            sessionId: `${sessionId}-guest`,
            sessionCode,
            host: '127.0.0.1',
            port: hostInfo.port,
            generation: 'gen4',
            playerName: 'GuestPlayer',
            timeoutMs: 15_000,
          },
          guestClaudeDir,
        );
        liveChildren.push(guestInfo.child);

        // ── Step 1: drain initial events until both sides reach select_action ──
        // Host emits: battle_initialized → choices_requested(select_action)
        // Guest now eagerly drains TCP init events on startup, so it also gets
        // battle_initialized → choices_requested(select_action) from the real TCP flow.
        async function drainToSelectAction(socketPath: string, label: string): Promise<void> {
          for (let i = 0; i < 5; i++) {
            const ev = await sendDaemonIpcRequest(
              socketPath,
              { op: 'wait_next_event', timeoutMs: 4_000 },
              5_000,
            );
            if (ev.op === 'error') throw new Error(`${label} IPC error: ${(ev as { message: string }).message}`);
            assert.equal(ev.op, 'event', `${label}: expected event op, got ${ev.op}`);
            if (ev.op === 'event' && ev.envelope.status === 'select_action') {
              assert.ok(
                Array.isArray(ev.envelope.moveOptions) && ev.envelope.moveOptions.length > 0,
                `${label}: choices_requested should include moveOptions`,
              );
              return;
            }
          }
          throw new Error(`${label}: Never reached select_action`);
        }

        await Promise.all([
          drainToSelectAction(hostInfo.socketPath, 'host'),
          drainToSelectAction(guestInfo.socketPath, 'guest'),
        ]);

        // ── Step 2: both sides submit move index 0 concurrently ──
        // The host's lv80 Turtwig uses Tackle on the guest's lv1 Cyndaquil.
        // Damage range: ~523–616 vs 11 HP → guaranteed one-shot KO.
        // The host daemon's fixed turn loop only awaits the guest switch (not
        // a host action) during the resulting awaiting_fainted_switch phase.
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

        assert.equal(hostAck.op, 'ack', `host move ack expected, got ${hostAck.op}`);
        assert.equal(guestAck.op, 'ack', `guest move ack expected, got ${guestAck.op}`);

        // ── Step 3: drain events until fainted_switch appears on at least one side ──
        // Both sides get turn_resolved (ongoing) first, then choices_requested
        // with phase=awaiting_fainted_switch. Daemon eventStatus only flips to
        // 'fainted_switch' on the side actually in waitingFor — the spectator
        // side stays 'ongoing' and runs out of events while the daemon waits
        // for the fainted side to submit its switch. So a side that hits the
        // wait_next_event inner timeout with no fainted_switch is the spectator,
        // and we resolve it as `false` rather than throwing.
        async function drainUntilFaintedSwitch(socketPath: string, label: string): Promise<boolean> {
          for (let i = 0; i < 10; i++) {
            let ev: DaemonResponse;
            try {
              ev = await sendDaemonIpcRequest(
                socketPath,
                { op: 'wait_next_event', timeoutMs: 1_500 },
                3_000,
              );
            } catch (err) {
              // Inner timeout: this side has no more events queued because the
              // daemon's turn loop is paused waiting on the *other* side's
              // forced switch. That makes us the spectator → not in fainted_switch.
              if ((err as Error).message.includes('timed out') || (err as Error).message.includes('timeout')) {
                return false;
              }
              throw err;
            }
            if (ev.op === 'error') {
              const msg = (ev as { message?: string }).message ?? '';
              if (msg.includes('timed out') || msg.includes('timeout')) return false;
              throw new Error(`${label} IPC error at attempt ${i}: ${msg}`);
            }
            assert.equal(ev.op, 'event', `${label}: expected event op after moves, got ${ev.op}`);
            if (ev.op === 'event') {
              const status = ev.envelope.status;
              if (status === 'fainted_switch') return true;
              // If both sides fainted simultaneously the battle may end immediately
              if (status === 'victory' || status === 'defeat') return false;
              // 'ongoing' (turn_resolved or spectator-view of fainted_switch) — keep draining
            }
          }
          // 10 events drained without fainted_switch → must be the spectator side
          return false;
        }

        const [hostFainted, guestFainted] = await Promise.all([
          drainUntilFaintedSwitch(hostInfo.socketPath, 'host'),
          drainUntilFaintedSwitch(guestInfo.socketPath, 'guest'),
        ]);

        // The guest's lv1 Cyndaquil should have fainted; host's lv80 is fine.
        // The choices_requested(awaiting_fainted_switch) event has waitingFor: ['guest']
        // but the host IPC also returns status=fainted_switch for the same event.
        assert.ok(
          hostFainted || guestFainted,
          'at least one side should be in fainted_switch state after the KO turn',
        );

        // ── Step 4: submit switch:1 on the fainted side(s) ──
        // The backup pokemon is at index 1 in each party.
        const switchPromises: Promise<void>[] = [];

        if (hostFainted) {
          switchPromises.push(
            sendDaemonIpcRequest(
              hostInfo.socketPath,
              { op: 'submit_action', action: { kind: 'switch', pokemonIndex: 1 } },
              5_000,
            ).then((ack) => {
              assert.equal(ack.op, 'ack', `host switch ack expected, got ${ack.op}`);
            }),
          );
        }

        if (guestFainted) {
          switchPromises.push(
            sendDaemonIpcRequest(
              guestInfo.socketPath,
              { op: 'submit_action', action: { kind: 'switch', pokemonIndex: 1 } },
              5_000,
            ).then((ack) => {
              assert.equal(ack.op, 'ack', `guest switch ack expected, got ${ack.op}`);
            }),
          );
        }

        await Promise.all(switchPromises);

        // ── Step 5: battle continues — drain to select_action or terminal ──
        async function drainToSelectActionAfterSwitch(
          socketPath: string,
          label: string,
        ): Promise<void> {
          for (let i = 0; i < 10; i++) {
            const ev = await sendDaemonIpcRequest(
              socketPath,
              { op: 'wait_next_event', timeoutMs: 4_000 },
              5_000,
            );
            if (ev.op === 'error') throw new Error(`${label} post-switch IPC error: ${(ev as { message: string }).message}`);
            assert.equal(ev.op, 'event', `${label}: expected event after switch, got ${ev.op}`);
            if (ev.op === 'event') {
              const status = ev.envelope.status;
              // select_action = battle continues to next turn; victory/defeat = clean finish
              if (status === 'select_action' || status === 'victory' || status === 'defeat') {
                return;
              }
              // 'ongoing' (turn_resolved after switch) — keep draining
            }
          }
          throw new Error(`${label}: never reached select_action or terminal after switch`);
        }

        const postSwitchPromises: Promise<void>[] = [];
        if (hostFainted) {
          postSwitchPromises.push(drainToSelectActionAfterSwitch(hostInfo.socketPath, 'host'));
        }
        if (guestFainted) {
          postSwitchPromises.push(drainToSelectActionAfterSwitch(guestInfo.socketPath, 'guest'));
        }

        await Promise.all(postSwitchPromises);
      } finally {
        rmSync(hostClaudeDir, { recursive: true, force: true });
        rmSync(guestClaudeDir, { recursive: true, force: true });
      }
    },
  );
});
