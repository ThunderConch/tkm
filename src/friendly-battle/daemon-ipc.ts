// src/friendly-battle/daemon-ipc.ts
import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
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

    const cleanup = (): void => {
      if (!socket.destroyed) {
        socket.end();
      }
    };

    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) return;

      handled = true;
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
