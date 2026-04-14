// src/friendly-battle/daemon-ipc.ts
import net from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import {
  decodeDaemonMessage,
  encodeDaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-protocol.js';

export type DaemonIpcHandler = (
  request: DaemonRequest,
) => Promise<DaemonResponse> | DaemonResponse;

export interface DaemonIpcServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Create a UNIX socket IPC server for the daemon.
 *
 * The server accepts exactly one request-response per connection — clients
 * must not pipeline multiple requests on the same connection.
 */
export async function createDaemonIpcServer(
  socketPath: string,
  handler: DaemonIpcHandler,
): Promise<DaemonIpcServer> {
  // Remove any leftover socket file from a crashed previous run.
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;

    // 5-second idle timeout — destroy the socket if the client connects but
    // never sends a request line. This is a pre-handler DoS guard; once we
    // parse a request the timeout is cleared because the handler (e.g.
    // wait_next_event) may legitimately block for a minute or more waiting
    // for a real battle event to arrive on the local queue.
    socket.setTimeout(5000, () => {
      if (!handled) socket.destroy();
    });

    const cleanup = (): void => {
      if (!socket.destroyed) {
        socket.end();
      }
    };

    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      // DoS cap: reject clients that send more than 64 KiB without a newline.
      if (buffer.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) return;

      handled = true;
      // Request line received — clear the idle timeout so long-blocking
      // handlers (wait_next_event with a multi-minute timeoutMs) are not
      // reaped while they legitimately wait for a battle event.
      socket.setTimeout(0);
      const line = buffer.slice(0, newlineIdx);
      let request: DaemonRequest;
      try {
        request = decodeDaemonMessage<DaemonRequest>(line);
      } catch (err) {
        const response: DaemonResponse = {
          op: 'error',
          code: 'bad_request',
          message: (err as Error).message,
        };
        socket.write(encodeDaemonMessage(response), () => cleanup());
        return;
      }

      Promise.resolve(handler(request))
        .then((response) => {
          socket.write(encodeDaemonMessage(response), () => cleanup());
        })
        .catch((err: unknown) => {
          const response: DaemonResponse = {
            op: 'error',
            code: 'handler_error',
            message: (err as Error).message,
          };
          socket.write(encodeDaemonMessage(response), () => cleanup());
        });
    });

    socket.on('error', () => {
      cleanup();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // Restrict socket access to owner only (security H1).
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // best effort — socket may be on a filesystem that ignores permissions
  }

  return {
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // swallow — best effort
        }
      }
    },
  };
}

export async function sendDaemonIpcRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs: number,
): Promise<DaemonResponse> {
  return new Promise<DaemonResponse>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`daemon IPC timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const finishError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(err);
    };

    client.on('error', finishError);

    client.on('connect', () => {
      client.write(encodeDaemonMessage(request));
    });

    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) return;

      const line = buffer.slice(0, newlineIdx);
      let response: DaemonResponse;
      try {
        response = decodeDaemonMessage<DaemonResponse>(line);
      } catch (err) {
        finishError(err as Error);
        return;
      }

      settled = true;
      clearTimeout(timer);
      client.end();
      resolve(response);
    });

    client.on('close', () => {
      if (!settled) {
        finishError(new Error('daemon IPC connection closed before response'));
      }
    });
  });
}
