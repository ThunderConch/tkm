#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPvpRoomHttpClient } from '../pvp/room-http-client.js';
import { createPvpSessionBootstrap, type PvpSessionBootstrapResult } from '../pvp/session-bootstrap.js';
import {
  createPvpSessionTerminalCli,
  type CreatePvpSessionTerminalCliOptions,
  type PvpSessionTerminalCliInputSource,
  type PvpSessionTerminalCliScreenOutput,
  type PvpSessionTerminalCliState,
} from '../pvp/session-terminal-cli.js';
import {
  createPvpSessionTerminalRunner,
  type PvpSessionTerminalRunnerSessionClientLike,
} from '../pvp/session-terminal-runner.js';
import type { CreatePvpSessionTerminalControllerOptions } from '../pvp/session-terminal-controller.js';
import type { PvpSessionClient } from '../pvp/session-client.js';
import { createPvpSessionTerminalStdioAdapter } from '../pvp/session-terminal-stdio.js';
import type { CreatePvpWebSocket, PvpWebSocketLike } from '../pvp/websocket-client.js';

export type PvpLiveSessionCliSessionClientLike =
  PvpSessionTerminalRunnerSessionClientLike & Partial<Pick<PvpSessionClient, 'connect' | 'disconnect'>>;

export type PvpLiveSessionCliAdapter =
  PvpSessionTerminalCliInputSource
  & PvpSessionTerminalCliScreenOutput
  & {
    setAbortHandler?(handler: (() => void) | null): void;
  };

export interface StartPvpLiveSessionCliOptions<
  TSessionClient extends PvpLiveSessionCliSessionClientLike = PvpSessionClient,
> extends Pick<CreatePvpSessionTerminalControllerOptions, 'now' | 'createClientCommandId'>,
    Pick<CreatePvpSessionTerminalCliOptions, 'normalizeInputToken'> {
  bootstrap: PvpSessionBootstrapResult<TSessionClient>;
  adapter: PvpLiveSessionCliAdapter;
  disconnectCloseInfo?: {
    code?: number;
    reason?: string;
  };
}

export interface PvpLiveSessionCliHandle<
  TSessionClient extends PvpLiveSessionCliSessionClientLike = PvpSessionClient,
> {
  readonly roomId: string;
  readonly sessionClient: TSessionClient;
  getState(): PvpSessionTerminalCliState;
  stop(): Promise<PvpSessionTerminalCliState>;
}

interface ParsedArgs {
  command: 'create' | 'join' | 'resume' | 'help';
  flags: Record<string, string>;
}

function printHelp(): void {
  console.log(`Usage: pvp-live <create|join|resume> --server-url <url> --auth-token <token> [options]

Commands:
  create    Create a new live PvP room and connect immediately.
  join      Join an existing live PvP room with a room code.
  resume    Resume an existing room session.

Required flags:
  --server-url   Base HTTP(S) URL for the PvP server (or set PVP_SERVER_URL).
  --auth-token   Auth token issued by the server (or set PVP_AUTH_TOKEN to avoid shell history exposure).

Shared flags:
  --generation   Battle generation key (for example: gen1, gen2, gen3, gen4).
  --ruleset-key  Optional ruleset key.
  --visibility   Room visibility for create (default: private_friend).
  --room-id      Room identifier for join/resume.
  --room-code    Room code required for join.
  --help         Show this help output.
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  let command: ParsedArgs['command'] = 'help';

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }

    if (!value.startsWith('--') && command === 'help') {
      if (value === 'create' || value === 'join' || value === 'resume') {
        command = value;
        continue;
      }
    }

    if (value === '--help') {
      return { command: 'help', flags };
    }

    if (!value.startsWith('--')) {
      continue;
    }

    const flagName = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${flagName}`);
    }

    flags[flagName] = next;
    index += 1;
  }

  return { command, flags };
}

const FLAG_ENV_FALLBACKS: Record<string, string> = {
  'auth-token': 'PVP_AUTH_TOKEN',
  'server-url': 'PVP_SERVER_URL',
};

function requireFlag(flags: Record<string, string>, name: string): string {
  const envKey = FLAG_ENV_FALLBACKS[name];
  const value = (flags[name] ?? (envKey ? process.env[envKey] : undefined))?.trim();
  if (!value) {
    const envHint = envKey ? ` (or set ${envKey})` : '';
    throw new Error(`--${name} is required${envHint}`);
  }

  return value;
}

function requireWebSocketConstructor(): CreatePvpWebSocket {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error('Global WebSocket is not available in this runtime.');
  }

  return (url: string) => new WebSocketCtor(url) as unknown as PvpWebSocketLike;
}

export async function startPvpLiveSessionCli<
  TSessionClient extends PvpLiveSessionCliSessionClientLike = PvpSessionClient,
>(
  options: StartPvpLiveSessionCliOptions<TSessionClient>,
): Promise<PvpLiveSessionCliHandle<TSessionClient>> {
  const { bootstrap, adapter } = options;
  const sessionClient = bootstrap.sessionClient;
  const disconnectCloseInfo = options.disconnectCloseInfo ?? {
    code: 1000,
    reason: 'terminal_cli_stop',
  };

  const runner = createPvpSessionTerminalRunner({
    sessionClient,
    now: options.now,
    createClientCommandId: options.createClientCommandId,
  });
  const cli = createPvpSessionTerminalCli({
    runner,
    input: adapter,
    output: adapter,
    normalizeInputToken: options.normalizeInputToken,
    bootstrap: {
      connect: () => {
        sessionClient.connect?.();
      },
      disconnect: () => {
        sessionClient.disconnect?.(disconnectCloseInfo);
      },
    },
  });

  await cli.start();

  return {
    roomId: bootstrap.roomId,
    sessionClient,
    getState: () => cli.getState(),
    stop: () => cli.stop(),
  };
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'help') {
    printHelp();
    return;
  }

  const serverUrl = requireFlag(parsed.flags, 'server-url');
  const authToken = requireFlag(parsed.flags, 'auth-token');
  const roomClient = createPvpRoomHttpClient({
    serverUrl,
    fetch: globalThis.fetch.bind(globalThis),
  });
  const bootstrapper = createPvpSessionBootstrap({
    serverUrl,
    roomClient,
    createSocket: requireWebSocketConstructor(),
  });

  const bootstrap = parsed.command === 'create'
    ? await bootstrapper.createRoomSession({
      authToken,
      generation: requireFlag(parsed.flags, 'generation'),
      rulesetKey: parsed.flags['ruleset-key'],
      visibility: parsed.flags.visibility ?? 'private_friend',
    })
    : parsed.command === 'join'
      ? await bootstrapper.joinRoomSession({
        authToken,
        generation: requireFlag(parsed.flags, 'generation'),
        roomId: requireFlag(parsed.flags, 'room-id'),
        roomCode: requireFlag(parsed.flags, 'room-code'),
      })
      : await bootstrapper.resumeRoomSession({
        authToken,
        roomId: requireFlag(parsed.flags, 'room-id'),
      });

  const adapter = createPvpSessionTerminalStdioAdapter({
    stdin: process.stdin as never,
    stdout: process.stdout,
    signalTarget: process,
  });
  const liveCli = await startPvpLiveSessionCli({
    bootstrap,
    adapter,
  });

  try {
    await new Promise<void>((resolvePromise) => {
      adapter.setAbortHandler(() => {
        void liveCli.stop().finally(resolvePromise);
      });
    });
  } finally {
    adapter.setAbortHandler(null);
    await liveCli.stop();
  }
}

const invokedPath = process.argv[1];
const invokedUrl = invokedPath ? pathToFileURL(resolve(invokedPath)).href : null;
if (invokedUrl && import.meta.url === invokedUrl) {
  void run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pvp-live] ${message}`);
    process.exitCode = 1;
  });
}
