import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-spike.ts');

type SpawnedCli = {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
  completion: Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>;
};

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
  it('prints a copyable join command and completes the first action exchange with two terminals', async () => {
    const host = spawnCli(['host', '--session-code', 'alpha-123', '--timeout-ms', '4000']);
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_COMMAND: .+$/m, 4_000);
    const joinCommand = hostStdout.match(/^JOIN_COMMAND: (.+)$/m)?.[1];
    assert.ok(joinCommand, `expected JOIN_COMMAND line in host stdout:\n${hostStdout}`);

    const guest = spawn('zsh', ['-lc', joinCommand], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TOKENMON_TEST: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let guestStdout = '';
    let guestStderr = '';
    guest.stdout.setEncoding('utf8');
    guest.stderr.setEncoding('utf8');
    guest.stdout.on('data', (chunk: string) => {
      guestStdout += chunk;
    });
    guest.stderr.on('data', (chunk: string) => {
      guestStderr += chunk;
    });

    const [hostResult, guestResult] = await Promise.all([
      host.completion,
      new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveGuest, rejectGuest) => {
        guest.once('error', rejectGuest);
        guest.once('close', (exitCode, signal) => resolveGuest({ exitCode, signal }));
      }),
    ]);

    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 0, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.equal(guestResult.signal, null, `guest stderr:\n${guestStderr}`);
    assert.equal(guestResult.exitCode, 0, `guest stdout:\n${guestStdout}\n--- stderr ---\n${guestStderr}`);

    assert.match(hostResult.stdout, /STAGE: guest_joined/);
    assert.match(hostResult.stdout, /STAGE: battle_started/);
    assert.match(hostResult.stdout, /GUEST_ACTION: move:1/);
    assert.match(hostResult.stdout, /HOST_ACTION: move:1/);
    assert.match(hostResult.stdout, /SUCCESS: first_action_exchange_completed/);

    assert.match(guestStdout, /STAGE: connected/);
    assert.match(guestStdout, /STAGE: ready/);
    assert.match(guestStdout, /STAGE: battle_started/);
    assert.match(guestStdout, /GUEST_ACTION: move:1/);
    assert.match(guestStdout, /HOST_ACTION: move:1/);
    assert.match(guestStdout, /SUCCESS: first_action_exchange_completed/);
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
      socket.write(`${JSON.stringify({ type: 'hello', sessionCode: 'alpha-123', guestPlayerName: 'IdleGuest' })}\n`);

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

      socket.write(`${JSON.stringify({ type: 'hello', sessionCode: 'alpha-123', guestPlayerName: 'BattleDropGuest' })}\n`);

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
      assert.match(result.stderr, /hello acknowledgement 대기 중 시간이 초과/);
      assert.ok(
        elapsedMs < 900,
        `expected join timeout to honor 200ms input without leaking a 1s internal wait (elapsed=${elapsedMs}ms)\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
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
      assert.notEqual(result.exitCode, 0, 'guest should fail when host disconnects during battle stage');
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
