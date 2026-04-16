import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  createDaemonIpcServer,
  sendDaemonIpcRequest,
  type DaemonIpcServer,
} from '../src/friendly-battle/daemon-ipc.js';
import type { DaemonRequest, DaemonResponse } from '../src/friendly-battle/daemon-protocol.js';

const tmpDirs: string[] = [];
const servers: DaemonIpcServer[] = [];

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-ipc-'));
  tmpDirs.push(dir);
  return join(dir, 'daemon.sock');
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close().catch(() => undefined);
  }
});

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('friendly-battle daemon IPC', { concurrency: false }, () => {
  it('round-trips a ping/pong via UNIX socket', async () => {
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, (req) => {
      assert.equal(req.op, 'ping');
      return { op: 'pong', pid: 12345 };
    });
    servers.push(server);

    const response = await sendDaemonIpcRequest(socketPath, { op: 'ping' }, 1000);
    assert.deepEqual(response, { op: 'pong', pid: 12345 });
  });

  it('handles async handler errors as error responses', async () => {
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, async () => {
      throw new Error('simulated failure');
    });
    servers.push(server);

    const response = await sendDaemonIpcRequest(socketPath, { op: 'ping' }, 1000);
    assert.equal(response.op, 'error');
    if (response.op === 'error') {
      assert.equal(response.code, 'handler_error');
      assert.match(response.message, /simulated failure/);
    }
  });

  it('rejects the client with a timeout when the server is down', async () => {
    const socketPath = tempSocketPath();
    await assert.rejects(
      () => sendDaemonIpcRequest(socketPath, { op: 'ping' }, 200),
      /(timeout|ENOENT|ECONNREFUSED|connection closed)/,
    );
  });

  it('rejects a client that writes 128 KiB without a newline', async () => {
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, () => {
      throw new Error('handler should not run on oversized request');
    });
    servers.push(server);

    // Send 128 KiB of data with no newline — the server should destroy the socket.
    const bigBuf = Buffer.alloc(128 * 1024, 'x');
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(bigBuf);
      });
      client.on('close', () => resolve());
      client.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNRESET or EPIPE is expected when the server destroys the socket
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
          resolve();
        } else {
          reject(err);
        }
      });
      // Safety timeout
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('server did not close the connection after 2s'));
      }, 2000);
      if (timer.unref) timer.unref();
    });
  });

  it('handler that blocks longer than the idle timeout still delivers its response', async () => {
    // Regression: the initial 5s idle timeout on the socket used to fire
    // during wait_next_event long polls, destroying the connection and
    // dropping the response. Once a request is parsed the timeout must
    // be cleared so handlers can legitimately block for minutes.
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, async (_req) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
      return { op: 'pong', pid: 98765 };
    });
    servers.push(server);

    const response = await sendDaemonIpcRequest(socketPath, { op: 'ping' }, 10_000);
    assert.equal(response.op, 'pong');
    if (response.op === 'pong') {
      assert.equal(response.pid, 98765);
    }
  });

  it('destroys a client that connects but never sends a request line', async () => {
    // Pre-handler idle guard: a client that opens the socket and then
    // stalls without writing anything should be destroyed within the
    // idle window (5s default). This verifies the guard still protects
    // the pre-request phase after the long-handler fix.
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, () => {
      throw new Error('handler must not run for a client that never wrote');
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketPath);
      let closedAt: number | null = null;
      const startedAt = Date.now();

      client.on('close', () => {
        closedAt = Date.now();
        try {
          const elapsed = closedAt - startedAt;
          // The idle guard is 5000ms; allow 4.5s lower bound for scheduler
          // jitter on CI and 7s upper bound so a never-firing guard still
          // fails the test.
          // Allow a wide window — node:test under parallel CPU load can fire
          // setTimeout up to ~700ms early on slow boxes. The actual contract
          // is "destroyed roughly within ~5s" rather than an exact threshold.
          assert.ok(elapsed >= 4_000, `expected idle destroy near the 5s mark, elapsed=${elapsed}ms`);
          assert.ok(elapsed <= 7_000, `expected idle destroy within 7s, elapsed=${elapsed}ms`);
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
      client.on('error', () => {
        // ECONNRESET or similar is fine — we only care about the close timing
      });
    });
  });

  it('rejects a bad request with op=error code=bad_request', async () => {
    const socketPath = tempSocketPath();
    const server = await createDaemonIpcServer(socketPath, () => {
      throw new Error('handler should not run on bad request');
    });
    servers.push(server);

    // Send garbage bytes directly via net (imported at top of file)
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write('not json\n');
      });
      client.setEncoding('utf8');
      let buffer = '';
      client.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.includes('\n')) {
          const line = buffer.slice(0, buffer.indexOf('\n'));
          const response = JSON.parse(line) as DaemonResponse;
          try {
            assert.equal(response.op, 'error');
            if (response.op === 'error') {
              assert.equal(response.code, 'bad_request');
            }
            resolve();
          } catch (err) {
            reject(err as Error);
          } finally {
            client.destroy();
          }
        }
      });
      client.on('error', reject);
    });
  });
});
