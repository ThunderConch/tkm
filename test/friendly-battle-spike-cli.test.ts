import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  FRIENDLY_BATTLE_PROTOCOL_VERSION,
  type FriendlyBattleBattleEvent,
} from '../src/friendly-battle/contracts.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectFriendlyBattleSpikeGuest,
  createFriendlyBattleSpikeHost,
} from '../src/friendly-battle/spike/tcp-direct.js';
import { buildFriendlyBattlePartySnapshot } from '../src/friendly-battle/snapshot.js';
import { makeConfig, makeState } from './helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-spike.ts');
const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_GENERATION = 'gen4';

// The `join` CLI now loads the current tokenmon profile and builds a party
// snapshot before it can announce STAGE: connected. In CI the runner has no
// persisted config/state, so we seed a dedicated CLAUDE_CONFIG_DIR with a
// single-pokemon party and point every spawned CLI at it.
const CLI_CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tkm-fb-spike-cli-'));
{
  const genDir = join(CLI_CLAUDE_CONFIG_DIR, 'tokenmon', DEFAULT_GENERATION);
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, 'config.json'),
    JSON.stringify({ party: ['387'], starter_chosen: true }),
    'utf8',
  );
  writeFileSync(
    join(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': {
          id: 387,
          xp: 100,
          level: 16,
          friendship: 0,
          ev: 0,
          moves: [33, 45],
        },
      },
    }),
    'utf8',
  );
}

type SpawnedCli = {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
  completion: Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>;
};

function makeGuestSnapshot(options: { generation?: string; snapshotId?: string } = {}) {
  return buildFriendlyBattlePartySnapshot({
    config: makeConfig({ party: ['387'] }),
    state: makeState({
      pokemon: {
        '387': {
          id: 387,
          xp: 100,
          level: 16,
          friendship: 0,
          ev: 0,
          moves: [33, 45],
        },
      },
    }),
    generation: options.generation ?? DEFAULT_GENERATION,
    pluginRoot,
    snapshotId: options.snapshotId ?? 'guest-snapshot-001',
    createdAt: '2026-04-12T12:34:56.000Z',
  });
}

function createInitialBattleEvents(battleId: string): FriendlyBattleBattleEvent[] {
  return [
    {
      type: 'battle_initialized',
      battleId,
      turn: 1,
    },
    {
      type: 'choices_requested',
      turn: 1,
      waitingFor: ['guest'],
      phase: 'waiting_for_choices',
    },
  ];
}

function createResolvedBattleEvents(): FriendlyBattleBattleEvent[] {
  return [
    {
      type: 'turn_resolved',
      turn: 1,
      messages: ['authoritative spike smoke resolved the guest choice'],
      waitingFor: [],
      nextPhase: 'completed',
      winner: 'host',
    },
    {
      type: 'battle_finished',
      winner: 'host',
      reason: 'completed',
    },
  ];
}

function parseLines(buffer: string, onLine: (line: string) => void): string {
  let remainder = buffer;

  while (true) {
    const newlineIndex = remainder.indexOf('\n');
    if (newlineIndex < 0) return remainder;

    const line = remainder.slice(0, newlineIndex).trim();
    remainder = remainder.slice(newlineIndex + 1);
    if (!line) continue;
    onLine(line);
  }
}

function spawnCli(args: string[]): SpawnedCli {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TOKENMON_TEST: '1',
      TSX_DISABLE_CACHE: '1',
      CLAUDE_CONFIG_DIR: CLI_CLAUDE_CONFIG_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output.stderr += chunk;
  });

  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion);
    child.once('close', (exitCode, signal) => {
      resolveCompletion({ stdout: output.stdout, stderr: output.stderr, exitCode, signal });
    });
  });

  return { child, output, completion };
}

async function waitForStdout(spawned: SpawnedCli, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(spawned.output.stdout)) {
      return spawned.output.stdout;
    }

    const completed = await Promise.race([
      spawned.completion.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 25)),
    ]);

    if (completed && pattern.test(spawned.output.stdout)) {
      return spawned.output.stdout;
    }

    if (completed) {
      break;
    }
  }

  throw new Error(`Timed out waiting for stdout pattern ${pattern}; stdout=${spawned.output.stdout}; stderr=${spawned.output.stderr}`);
}

async function terminate(spawned: SpawnedCli): Promise<void> {
  if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
    return;
  }

  spawned.child.kill('SIGTERM');
  await Promise.race([
    spawned.completion,
    new Promise<void>((resolveTimeout) => setTimeout(() => resolveTimeout(), 500)),
  ]);

  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    spawned.child.kill('SIGKILL');
    await spawned.completion.catch(() => undefined);
  }
}

describe('friendly battle spike CLI', { concurrency: false }, () => {
  after(() => {
    rmSync(CLI_CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  });

  it('prints a copyable join command and lets the host CLI finish an authoritative event smoke', async () => {
    const hostStartupTimeoutMs = 60_000;
    const battleExchangeTimeoutMs = 15_000;
    const host = spawnCli([
      'host',
      '--session-code',
      'alpha-123',
      '--timeout-ms',
      String(battleExchangeTimeoutMs),
    ]);
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_COMMAND: .+$/m, hostStartupTimeoutMs);
    const joinCommand = hostStdout.match(/^JOIN_COMMAND: (.+)$/m)?.[1];
    assert.ok(joinCommand, `expected JOIN_COMMAND line in host stdout:\n${hostStdout}`);
    assert.match(joinCommand, /friendly-battle-spike\.ts join --host 127\.0\.0\.1 --port \d+ --session-code alpha-123 --timeout-ms 15000 --generation gen4/);

    const joinInfoJson = hostStdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostStdout}`);
    const joinInfo = JSON.parse(joinInfoJson) as { host: string; port: number };

    const guest = await connectFriendlyBattleSpikeGuest({
      host: joinInfo.host,
      port: joinInfo.port,
      sessionCode: 'alpha-123',
      guestPlayerName: 'Guest',
      generation: DEFAULT_GENERATION,
      guestSnapshot: makeGuestSnapshot(),
      timeoutMs: battleExchangeTimeoutMs,
    });
    after(async () => guest.close().catch(() => undefined));

    const readyState = await guest.markReady();
    assert.equal(readyState.guestReady, true);

    const started = await guest.waitForStarted(battleExchangeTimeoutMs);
    assert.equal(started.type, 'battle_started');
    assert.ok(started.battleId === '' || started.battleId === 'spike-alpha-123');
    const initialEvents = createInitialBattleEvents('spike-alpha-123');
    assert.deepEqual(await guest.waitForBattleEvent(battleExchangeTimeoutMs), initialEvents[0]);
    const choicesRequested = await guest.waitForBattleEvent(battleExchangeTimeoutMs);
    assert.deepEqual(choicesRequested, initialEvents[1]);

    const guestChoice = await guest.submitChoice('move:1');
    const resolvedEvents = createResolvedBattleEvents();
    assert.deepEqual(await guest.waitForBattleEvent(battleExchangeTimeoutMs), resolvedEvents[0]);
    assert.deepEqual(await guest.waitForBattleEvent(battleExchangeTimeoutMs), resolvedEvents[1]);
    const hostResult = await host.completion;

    assert.deepEqual(guestChoice.choice, {
      type: 'move',
      moveIndex: 1,
    });
    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 0, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.match(hostResult.stdout, /STAGE: guest_joined \(Guest\)/);
    assert.match(hostResult.stdout, /STAGE: battle_started/);
    assert.match(hostResult.stdout, /GUEST_CHOICE: move:1/);
    assert.match(hostResult.stdout, /EVENT_SENT: battle_finished/);
    assert.match(hostResult.stdout, /WINNER: host/);
    assert.match(hostResult.stdout, /SUCCESS: authoritative_event_smoke_completed/);
  });

  it('lets the join CLI complete an authoritative event smoke against an in-process host', async () => {
    const guestStartupTimeoutMs = 60_000;
    const battleExchangeTimeoutMs = 15_000;
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'beta-123',
      hostPlayerName: 'Host',
      generation: DEFAULT_GENERATION,
    });
    after(async () => host.close());

    const guest = spawnCli([
      'join',
      '--host',
      host.connectionInfo.host,
      '--port',
      String(host.connectionInfo.port),
      '--session-code',
      'beta-123',
      '--generation',
      DEFAULT_GENERATION,
      '--timeout-ms',
      String(battleExchangeTimeoutMs),
    ]);
    after(async () => terminate(guest));

    await waitForStdout(guest, /STAGE: connected/, guestStartupTimeoutMs);

    const joined = await host.waitForGuestJoin(battleExchangeTimeoutMs);
    assert.equal(joined.guestPlayerName, 'Guest');
    assert.equal(joined.guestSnapshot.generation, DEFAULT_GENERATION);

    const readyState = host.markHostReady();
    assert.equal(readyState.hostReady, true);
    await host.waitUntilCanStart(battleExchangeTimeoutMs);
    const battleId = 'beta-battle';
    await host.startBattle(battleId);
    const initialEvents = createInitialBattleEvents(battleId);
    host.sendBattleEvents(initialEvents);

    const guestChoice = await host.waitForGuestChoice(battleExchangeTimeoutMs);
    const resolvedEvents = createResolvedBattleEvents();
    host.sendBattleEvents(resolvedEvents);
    const guestResult = await guest.completion;

    assert.deepEqual(guestChoice.choice, {
      type: 'move',
      moveIndex: 1,
    });
    assert.equal(guestResult.signal, null, `guest stderr:\n${guestResult.stderr}`);
    assert.equal(guestResult.exitCode, 0, `guest stdout:\n${guestResult.stdout}\n--- stderr ---\n${guestResult.stderr}`);
    assert.match(guestResult.stdout, /STAGE: connected/);
    assert.match(guestResult.stdout, /STAGE: ready/);
    assert.match(guestResult.stdout, /STAGE: battle_started/);
    assert.match(guestResult.stdout, /EVENT_RECEIVED: battle_initialized/);
    assert.match(guestResult.stdout, /EVENT_RECEIVED: choices_requested/);
    assert.match(guestResult.stdout, /GUEST_CHOICE: move:1/);
    assert.match(guestResult.stdout, /EVENT_RECEIVED: battle_finished/);
    assert.match(guestResult.stdout, /WINNER: host/);
    assert.match(guestResult.stdout, /SUCCESS: authoritative_event_smoke_completed/);
  });

  it('prints a guest-facing join command from --join-host even when the host listens on 0.0.0.0', async () => {
    const host = spawnCli([
      'host',
      '--listen-host',
      '0.0.0.0',
      '--join-host',
      '192.168.0.24',
      '--session-code',
      'alpha-123',
      '--timeout-ms',
      '50',
    ]);

    const result = await host.completion;
    assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
    assert.notEqual(result.exitCode, 0, 'host should still time out without a guest');
    assert.match(result.stdout, /JOIN_COMMAND: .+--host 192\.168\.0\.24 /);

    const joinInfoJson = result.stdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${result.stdout}`);
    const joinInfo = JSON.parse(joinInfoJson) as { host: string; listenHost: string };
    assert.equal(joinInfo.host, '192.168.0.24');
    assert.equal(joinInfo.listenHost, '0.0.0.0');
  });

  it('requires --join-host when the host listens on a wildcard address', async () => {
    const host = spawnCli([
      'host',
      '--listen-host',
      '0.0.0.0',
      '--session-code',
      'alpha-123',
      '--timeout-ms',
      '50',
    ]);

    const result = await host.completion;
    assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
    assert.notEqual(result.exitCode, 0, 'host should fail fast without a guest-facing join host');
    assert.match(result.stderr, /FAILED_STAGE: listen/);
    assert.match(result.stderr, /NEXT_ACTION: .*join host/i);
    assert.match(result.stderr, /INPUT_HINT: .*listenHost=0\.0\.0\.0/);
    assert.match(result.stderr, /RETRY_HINT: .*--listen-host 0\.0\.0\.0/);
  });

  it('rejects wildcard --join-host values so the printed guest command stays reachable', async () => {
    const host = spawnCli([
      'host',
      '--listen-host',
      '0.0.0.0',
      '--join-host',
      '0.0.0.0',
      '--session-code',
      'alpha-123',
      '--timeout-ms',
      '50',
    ]);

    const result = await host.completion;
    assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
    assert.notEqual(result.exitCode, 0, 'host should fail fast with a wildcard guest-facing join host');
    assert.match(result.stderr, /FAILED_STAGE: listen/);
    assert.match(result.stderr, /NEXT_ACTION: .*join host/i);
    assert.match(result.stderr, /INPUT_HINT: .*joinHost=0\.0\.0\.0/);
    assert.match(result.stderr, /RETRY_HINT: .*--join-host 0\.0\.0\.0/);
  });

  it('surfaces handshake failures with stage, next action, and retry hint', async () => {
    const host = spawnCli(['host', '--session-code', 'alpha-123', '--timeout-ms', '4000']);
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_INFO: .+$/m, 4_000);
    const joinInfoJson = hostStdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostStdout}`);

    const joinInfo = JSON.parse(joinInfoJson) as { host: string; port: number };
    const guest = spawnCli([
      'join',
      '--host',
      joinInfo.host,
      '--port',
      String(joinInfo.port),
      '--session-code',
      'wrong-code',
      '--timeout-ms',
      '2000',
    ]);

    const result = await guest.completion;
    assert.equal(result.signal, null, `guest stderr:\n${result.stderr}`);
    assert.notEqual(result.exitCode, 0, 'guest should fail with wrong session code');
    assert.match(result.stderr, /FAILED_STAGE: handshake/);
    assert.match(result.stderr, /NEXT_ACTION: .*session code/i);
    assert.match(result.stderr, /INPUT_HINT: .*wrong-code/);
    assert.match(result.stderr, /RETRY_HINT: .*--session-code alpha-123/);
  });

  it('surfaces listen failures with stage, next action, and retry hint on host', async () => {
    const occupiedServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = occupiedServer.address();
    assert.ok(address && typeof address !== 'string', 'expected occupied server to have a TCP address');

    try {
      const host = spawnCli([
        'host',
        '--host',
        '127.0.0.1',
        '--port',
        String(address.port),
        '--session-code',
        'alpha-123',
        '--timeout-ms',
        '2000',
      ]);

      const result = await host.completion;
      assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'host should fail when port is already in use');
      assert.match(result.stderr, /FAILED_STAGE: listen/);
      assert.match(result.stderr, /NEXT_ACTION: .*포트.*다시 host/i);
      assert.match(result.stderr, /INPUT_HINT: .*host=127\.0\.0\.1.*sessionCode=alpha-123/);
      assert.match(result.stderr, new RegExp(`RETRY_HINT: .*--port ${address.port} .*--session-code alpha-123`));
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('surfaces ready-stage failures on host when the guest never becomes ready', async () => {
    const host = spawnCli(['host', '--session-code', 'alpha-123', '--timeout-ms', '400']);
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_INFO: .+$/m, 4_000);
    const joinInfoJson = hostStdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostStdout}`);

    const joinInfo = JSON.parse(joinInfoJson) as { host: string; port: number };
    const socket = net.createConnection(joinInfo.port, joinInfo.host);
    socket.setEncoding('utf8');

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => resolve());
      });
      socket.write(`${JSON.stringify({
        type: 'hello',
        protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'IdleGuest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'idle-guest-snapshot' }),
      })}\n`);

      const result = await host.completion;
      assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'host should fail when guest never becomes ready');
      assert.match(result.stderr, /FAILED_STAGE: ready/);
      assert.match(result.stderr, /NEXT_ACTION: .*ready 단계/i);
      assert.match(result.stderr, /INPUT_HINT: .*sessionCode=alpha-123/);
      assert.match(result.stderr, /RETRY_HINT: .*friendly-battle-spike\.ts host/);
    } finally {
      socket.destroy();
    }
  });

  it('surfaces host battle-stage failures when the guest disconnects after battle starts', async () => {
    const host = spawnCli(['host', '--session-code', 'alpha-123', '--timeout-ms', '500']);
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_INFO: .+$/m, 4_000);
    const joinInfoJson = hostStdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostStdout}`);

    const joinInfo = JSON.parse(joinInfoJson) as { host: string; port: number };
    const socket = net.createConnection(joinInfo.port, joinInfo.host);
    socket.setEncoding('utf8');

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => resolve());
      });

      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer = parseLines(buffer + chunk, (line) => {
          const message = JSON.parse(line) as { type: string };

          if (message.type === 'hello_ack') {
            socket.write(`${JSON.stringify({ type: 'guest_ready' })}\n`);
            return;
          }

          if (message.type === 'battle_started') {
            socket.end();
          }
        });
      });

      socket.write(`${JSON.stringify({
        type: 'hello',
        protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'BattleDropGuest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'battle-drop-guest-snapshot' }),
      })}\n`);

      const result = await host.completion;
      assert.equal(result.signal, null, `host stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'host should fail when guest disconnects after battle starts');
      assert.match(result.stdout, /STAGE: guest_joined \(BattleDropGuest\)/);
      assert.match(result.stdout, /STAGE: battle_started/);
      assert.match(result.stderr, /FAILED_STAGE: battle/);
      assert.match(result.stderr, /NEXT_ACTION: .*상대 행동이 도착하는지 확인/i);
      assert.match(result.stderr, /guest 연결이 종료되었습니다/);
    } finally {
      socket.destroy();
    }
  });

  it('honors join timeout-ms while waiting for hello acknowledgement', async () => {
    const dummyServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', () => {
        // Intentionally swallow the hello message without replying.
      });
    });

    await new Promise<void>((resolve, reject) => {
      dummyServer.once('error', reject);
      dummyServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = dummyServer.address();
    assert.ok(address && typeof address !== 'string', 'expected dummy server to have a TCP address');

    try {
      const startedAt = Date.now();
      const guest = spawnCli([
        'join',
        '--host',
        '127.0.0.1',
        '--port',
        String(address.port),
        '--session-code',
        'alpha-123',
        '--timeout-ms',
        '200',
      ]);

      const result = await guest.completion;
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.signal, null, `guest stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'guest should fail when hello acknowledgement never arrives');
      assert.match(result.stderr, /FAILED_STAGE: join/);
      assert.match(result.stderr, /NEXT_ACTION: .*host.*session code/i);
      assert.match(result.stderr, /INPUT_HINT: .*sessionCode=alpha-123/);
      assert.match(result.stderr, /RETRY_HINT: .*--timeout-ms 200/);
      assert.match(result.stderr, /hello (acknowledgement|handshake) 대기 중 시간이 초과/);
      // Wall-clock timing signal is unreliable on CI runners when other test
      // files are spawning child processes in parallel — a 200ms setTimeout
      // can drift past 1s via scheduler starvation. Keep the check as a local
      // dev guard; on CI the RETRY_HINT regex above is what proves the flag
      // was received, and the test still fails hard if the CLI silently hangs
      // forever (exit code assertion above).
      if (!process.env.CI) {
        assert.ok(
          elapsedMs < 900,
          `expected join timeout to honor 200ms input without leaking a 1s internal wait (elapsed=${elapsedMs}ms)\nstdout=${result.stdout}\nstderr=${result.stderr}`,
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        dummyServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('surfaces guest ready-stage failures when the host disconnects after hello acknowledgement', async () => {
    const dummyServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';

      socket.on('data', (chunk: string) => {
        buffer = parseLines(buffer + chunk, (line) => {
          const message = JSON.parse(line) as { type: string };

          if (message.type === 'hello') {
            socket.write(`${JSON.stringify({
              type: 'hello_ack',
              protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
              generation: DEFAULT_GENERATION,
              hostPlayerName: 'Host',
              readyState: { hostReady: false, guestReady: false, canStart: false },
            })}\n`);
            return;
          }

          if (message.type === 'guest_ready') {
            socket.end();
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      dummyServer.once('error', reject);
      dummyServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = dummyServer.address();
    assert.ok(address && typeof address !== 'string', 'expected dummy server to have a TCP address');

    try {
      const guest = spawnCli([
        'join',
        '--host',
        '127.0.0.1',
        '--port',
        String(address.port),
        '--session-code',
        'alpha-123',
        '--timeout-ms',
        '500',
      ]);

      const result = await guest.completion;
      assert.equal(result.signal, null, `guest stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'guest should fail when host disconnects during ready stage');
      assert.match(result.stdout, /STAGE: connected/);
      assert.doesNotMatch(result.stdout, /STAGE: ready/);
      assert.match(result.stderr, /FAILED_STAGE: ready/);
      assert.match(result.stderr, /NEXT_ACTION: .*다시 join/i);
      assert.match(result.stderr, /host 연결이 종료되었습니다/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        dummyServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('surfaces guest battle-stage failures when the host disconnects after ready completes', async () => {
    const dummyServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';

      socket.on('data', (chunk: string) => {
        buffer = parseLines(buffer + chunk, (line) => {
          const message = JSON.parse(line) as { type: string };

          if (message.type === 'hello') {
            socket.write(`${JSON.stringify({
              type: 'hello_ack',
              protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
              generation: DEFAULT_GENERATION,
              hostPlayerName: 'Host',
              readyState: { hostReady: false, guestReady: false, canStart: false },
            })}\n`);
            return;
          }

          if (message.type === 'guest_ready') {
            socket.write(`${JSON.stringify({
              type: 'ready_state',
              readyState: { hostReady: false, guestReady: true, canStart: false },
            })}\n`);
            setTimeout(() => socket.end(), 10);
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      dummyServer.once('error', reject);
      dummyServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = dummyServer.address();
    assert.ok(address && typeof address !== 'string', 'expected dummy server to have a TCP address');

    try {
      const guest = spawnCli([
        'join',
        '--host',
        '127.0.0.1',
        '--port',
        String(address.port),
        '--session-code',
        'alpha-123',
        '--timeout-ms',
        '500',
      ]);

      const result = await guest.completion;
      assert.equal(result.signal, null, `guest stderr:\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0, 'guest should fail when host disconnects after ready completes');
      assert.match(result.stdout, /STAGE: connected/);
      assert.match(result.stdout, /STAGE: ready/);
      assert.doesNotMatch(result.stdout, /STAGE: battle_started/);
      assert.match(result.stderr, /FAILED_STAGE: battle/);
      assert.match(result.stderr, /NEXT_ACTION: .*battle 시작 단계/i);
      assert.match(result.stderr, /host 연결이 종료되었습니다/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        dummyServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
