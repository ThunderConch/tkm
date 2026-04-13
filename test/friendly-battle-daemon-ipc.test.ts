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

describe('friendly-battle daemon IPC', () => {
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
