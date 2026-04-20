#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  type FriendlyBattleSessionRecord,
  writeFriendlyBattleSessionRecord,
  readFriendlyBattleSessionRecord,
  listFriendlyBattleSessionRecords,
  isPidAlive,
} from '../friendly-battle/session-store.js';
import { formatFriendlyBattleTurnJson } from '../friendly-battle/turn-json.js';
import { sendDaemonIpcRequest } from '../friendly-battle/daemon-ipc.js';

// Pick the daemon entry based on how this CLI was invoked:
//   - When the compiled dist/cli/friendly-battle-turn.js runs, import.meta.url
//     ends in .js and a sibling dist/friendly-battle/daemon.js exists, so we
//     point at that and spawn it with a plain `node daemon.js` (no tsx load).
//   - When the source src/cli/friendly-battle-turn.ts runs under tsx, we
//     point at daemon.ts and spawn it with `node --import tsx daemon.ts`.
// Falling back on existsSync() handles the edge case where only one side of
// the pair is present (e.g. dist/ was partially synced).
const DAEMON_ENTRY: string = (() => {
  const jsEntry = resolve(fileURLToPath(new URL('../friendly-battle/daemon.js', import.meta.url)));
  const tsEntry = resolve(fileURLToPath(new URL('../friendly-battle/daemon.ts', import.meta.url)));
  if (import.meta.url.endsWith('.js') && existsSync(jsEntry)) return jsEntry;
  if (existsSync(tsEntry)) return tsEntry;
  if (existsSync(jsEntry)) return jsEntry;
  return tsEntry;
})();
const DAEMON_USES_TSX = DAEMON_ENTRY.endsWith('.ts');
// Plugin root — used as spawn() cwd so the daemon child can resolve the
// `tsx` package from the plugin's node_modules regardless of the parent's
// cwd. Node ESM's `--import tsx` specifier resolution is cwd-relative, so
// without this the daemon crashes with ERR_MODULE_NOT_FOUND whenever the
// user's shell cwd is outside the plugin dir.
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
function daemonSpawnArgs(role: 'host' | 'guest'): string[] {
  return DAEMON_USES_TSX
    ? ['--import', 'tsx', DAEMON_ENTRY, '--role', role]
    : [DAEMON_ENTRY, '--role', role];
}

type Subcommand =
  | 'init-host'
  | 'init-join'
  | 'wait-next-event'
  | 'action'
  | 'status'
  | 'leave'
  | 'list-active';

interface ParsedCliArgs {
  subcommand: Subcommand;
  flags: Record<string, string | boolean | undefined>;
}

const USAGE = [
  'Usage: friendly-battle-turn [subcommand] [flags]',
  '',
  'Subcommands:',
  '  --init-host --session-code <code> [--listen-host 127.0.0.1] [--join-host <advertise-host>] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]',
  '  --init-join --session-code <code> --host <host> --port <port> [--timeout-ms 4000] [--generation gen4] [--player-name Guest]',
  '  --wait-next-event --session <id> --generation <gen> [--timeout-ms 60000]',
  '  --action <move:N|switch:N|surrender> --session <id> --generation <gen>',
  '  --status --session <id> --generation <gen>',
  '  --list-active --generation <gen>',
  '',
].join('\n');

const SUBCOMMAND_FLAGS = new Set<string>([
  '--init-host',
  '--init-join',
  '--wait-next-event',
  // '--action' is intentionally absent: it carries a value and is parsed by parseArgs directly
  '--status',
  '--leave',
  '--list-active',
]);

const CLI_FLAG_SCHEMA = {
  'session-code': { type: 'string' as const },
  'session': { type: 'string' as const },
  'host': { type: 'string' as const },
  'listen-host': { type: 'string' as const },
  'join-host': { type: 'string' as const },
  'port': { type: 'string' as const },
  'timeout-ms': { type: 'string' as const },
  'generation': { type: 'string' as const },
  'player-name': { type: 'string' as const },
  'action': { type: 'string' as const },
};

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requirePositiveInt(value: string | undefined, name: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    process.stderr.write(`missing required flag --${name}\n`);
    process.exit(1);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    process.stderr.write(`REASON: flag --${name} must be a non-negative integer, got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return parsed;
}

const SAFE_NAME = /^[\p{L}\p{N}_.\- ]{1,32}$/u;
function sanitizeName(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  // strip control chars + cap length
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 32);
  if (!SAFE_NAME.test(cleaned)) {
    process.stderr.write(`REASON: flag --${name} must match /^[A-Za-z0-9 _.-]{1,32}$/, got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return cleaned;
}

const SAFE_CODE = /^[A-Za-z0-9_-]{1,48}$/;
function validateSessionCode(value: string): string {
  if (!SAFE_CODE.test(value)) {
    process.stderr.write(`REASON: --session-code must match /^[A-Za-z0-9_-]{1,48}$/, got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return value;
}

const SAFE_GEN = /^gen[0-9]{1,2}$/;
function validateGeneration(value: string | undefined): string {
  const gen = value ?? 'gen4';
  if (!SAFE_GEN.test(gen)) {
    process.stderr.write(`REASON: --generation must match /^gen[0-9]+$/, got ${JSON.stringify(gen)}\n`);
    process.exit(1);
  }
  return gen;
}

function asStringFlag(flags: Record<string, string | boolean | undefined>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
function validateSafeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    process.stderr.write(`REASON: --${name} must match /^[A-Za-z0-9_.-]{1,128}$/, got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return value;
}

// Host args (listen-host, join-host, --host) are shell-safety filtered only.
// This is NOT semantic host validation: inputs like `::::`, `foo..bar`, or
// `[::1` (unmatched bracket) will pass this check and fail later inside
// Node's net layer with its own error. The purpose here is strictly to
// reject shell metacharacters and control bytes so a malicious value can't
// traverse into downstream command paths — semantic parsing (IPv4/IPv6
// literal, hostname labels) is intentionally deferred to `net.listen` /
// `net.connect`, which already has the right behavior and error messages.
const SAFE_HOST = /^[A-Za-z0-9._:\-\[\]%]{1,253}$/;
function sanitizeHostArg(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!SAFE_HOST.test(value)) {
    process.stderr.write(`REASON: --${name} contains characters outside the shell-safe set [A-Za-z0-9._:\\-\\[\\]%], got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(`${USAGE}\n`);
}

function resolveSubcommand(argv: string[]): Subcommand | null {
  if (argv.includes('--init-host')) return 'init-host';
  if (argv.includes('--init-join')) return 'init-join';
  if (argv.includes('--wait-next-event')) return 'wait-next-event';
  if (argv.includes('--action')) return 'action';
  if (argv.includes('--status')) return 'status';
  if (argv.includes('--leave')) return 'leave';
  if (argv.includes('--list-active')) return 'list-active';
  return null;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const subcommand = resolveSubcommand(argv);
  if (!subcommand) {
    process.stderr.write('unknown subcommand\n');
    printUsage();
    process.exit(1);
  }

  const flagArgs = argv.filter((token) => !SUBCOMMAND_FLAGS.has(token));
  let values: Record<string, string | boolean | undefined>;
  try {
    const result = parseArgs({
      args: flagArgs,
      options: CLI_FLAG_SCHEMA,
      strict: true,
      allowPositionals: true,
    });
    values = result.values as Record<string, string | boolean | undefined>;
  } catch (err) {
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    process.exit(1);
  }

  return { subcommand, flags: values };
}

// ---------------------------------------------------------------------------
// Reads lines from a Readable stream until a predicate matches, with timeout.
// Returns the first matching line.
// ---------------------------------------------------------------------------
function readLineUntil(
  stream: NodeJS.ReadableStream,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      reject(new Error(`readLineUntil: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(chunk: Buffer | string): void {
      if (settled) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (predicate(line)) {
          settled = true;
          clearTimeout(timer);
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          resolve(line);
          return;
        }
      }
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('readLineUntil: stream ended before predicate matched'));
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

async function runInitHost(flags: Record<string, string | boolean | undefined>): Promise<void> {
  // --- Input validation (must run before forking daemon) ---
  const sessionCode = validateSessionCode(requireFlag(flags, 'session-code'));
  // Run every host-shaped flag through sanitizeHostArg so shell-unsafe
  // input is rejected with a consistent `REASON:` line before we spawn a
  // daemon or open a socket. Semantic validity of the host is left to
  // Node's net layer. --listen-host defaults to 127.0.0.1 when omitted.
  const listenHost = sanitizeHostArg(asStringFlag(flags, 'listen-host'), 'listen-host') ?? '127.0.0.1';
  // --join-host is the address guests will actually connect to. Required
  // whenever --listen-host is a wildcard (0.0.0.0, ::) because the daemon's
  // TCP transport rejects wildcard-without-advertise combinations upfront.
  const advertiseHost = sanitizeHostArg(asStringFlag(flags, 'join-host'), 'join-host');
  const port = requirePositiveInt(asStringFlag(flags, 'port'), 'port', 0);
  const timeoutMs = requirePositiveInt(asStringFlag(flags, 'timeout-ms'), 'timeout-ms', 4000);
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const playerName = sanitizeName(asStringFlag(flags, 'player-name'), 'player-name', 'Host');

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();

  // Build options JSON for the daemon
  const daemonOptions = {
    sessionId,
    sessionCode,
    host: listenHost,
    advertiseHost,
    port,
    generation,
    playerName,
    timeoutMs,
  };
  const optionsB64 = Buffer.from(JSON.stringify(daemonOptions), 'utf8').toString('base64');

  // Fork the daemon as a detached child. cwd is pinned to PLUGIN_ROOT so
  // `--import tsx` can resolve tsx from the plugin's node_modules even when
  // the parent Claude Code session runs in an unrelated project directory.
  const child = spawn(
    process.execPath,
    daemonSpawnArgs('host'),
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TKM_FB_OPTIONS_B64: optionsB64 },
      cwd: PLUGIN_ROOT,
    },
  );

  // Relay daemon stderr to our stderr so errors are visible
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let daemonReadyLine: string;
  try {
    // Wait for DAEMON_READY <sessionId> <socketPath> <port>
    // Use timeoutMs + 5s buffer so validation still fires even if daemon takes a moment
    daemonReadyLine = await readLineUntil(
      child.stdout,
      (line) => line.startsWith('DAEMON_READY '),
      timeoutMs + 5000,
    );
  } catch (err) {
    // Daemon failed to start — emit aborted envelope and exit 1
    child.kill('SIGTERM');
    child.unref();
    const record: FriendlyBattleSessionRecord = {
      sessionId,
      role: 'host',
      generation,
      sessionCode,
      phase: 'aborted',
      status: 'aborted',
      transport: { host: advertiseHost ?? listenHost, port },
      opponent: null,
      pid: process.pid,
      daemonPid: 0,
      socketPath: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: 'aborted',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
    process.stderr.write(`STAGE: waiting_for_guest\n`);
    process.stderr.write(`FAILED_STAGE: waiting_for_guest\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Parse DAEMON_READY <sessionId> <socketPath> <boundPort>
  // Host emits 4 tokens; guest emits 3 (no port).
  const parts = daemonReadyLine.trim().split(' ');
  // parts[0] = 'DAEMON_READY', parts[1] = sessionId, parts[2] = socketPath, parts[3] = port
  const socketPath = parts[2] ?? '';
  const boundPort = parts[3] !== undefined ? Number.parseInt(parts[3], 10) : port;

  const daemonPid = child.pid ?? 0;

  // Detach from the daemon's stdio so the CLI's event loop can exit.
  // Must happen before child.unref() so no handles keep the parent alive.
  child.stdout.destroy();
  child.stderr?.destroy();
  child.unref();

  // Write the session record with daemon PID and socket path
  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'host',
    generation,
    sessionCode,
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: { host: advertiseHost ?? listenHost, port: boundPort },
    opponent: null,
    pid: process.pid,
    daemonPid,
    socketPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);

  // Emit PORT and STAGE on stderr (tests rely on these)
  process.stderr.write(`PORT: ${boundPort}\n`);
  process.stderr.write(`STAGE: waiting_for_guest\n`);

  // Emit the first JSON envelope on stdout
  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `Waiting for guest (code ${sessionCode}) — see /tkm:friendly-battle status`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);
}

async function runInitJoin(flags: Record<string, string | boolean | undefined>): Promise<void> {
  // --- Input validation (must run before forking daemon) ---
  const sessionCode = validateSessionCode(requireFlag(flags, 'session-code'));
  // --host is required; sanitizeHostArg returns undefined only for empty input,
  // which requireFlag already rejects, so the `!` assertion is safe.
  const hostAddr = sanitizeHostArg(requireFlag(flags, 'host'), 'host')!;
  const portStr = asStringFlag(flags, 'port') ?? requireFlag(flags, 'port');
  const port = requirePositiveInt(portStr, 'port');
  const timeoutMs = requirePositiveInt(asStringFlag(flags, 'timeout-ms'), 'timeout-ms', 4000);
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const playerName = sanitizeName(asStringFlag(flags, 'player-name'), 'player-name', 'Guest');

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();

  // Build options JSON for the daemon
  const daemonOptions = {
    sessionId,
    sessionCode,
    host: hostAddr,
    port,
    generation,
    playerName,
    timeoutMs,
  };
  const optionsB64 = Buffer.from(JSON.stringify(daemonOptions), 'utf8').toString('base64');

  // Fork the daemon as a detached child. See init-host spawn for why cwd is
  // pinned to PLUGIN_ROOT.
  const child = spawn(
    process.execPath,
    daemonSpawnArgs('guest'),
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TKM_FB_OPTIONS_B64: optionsB64 },
      cwd: PLUGIN_ROOT,
    },
  );

  // Relay daemon stderr to our stderr so errors are visible
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let daemonReadyLine: string;
  try {
    // Wait for DAEMON_READY <sessionId> <socketPath>  (guest: 3 tokens, no port)
    daemonReadyLine = await readLineUntil(
      child.stdout,
      (line) => line.startsWith('DAEMON_READY '),
      timeoutMs + 5000,
    );
  } catch (err) {
    // Daemon failed to start — emit aborted envelope and exit 1
    child.kill('SIGTERM');
    child.unref();
    const record: FriendlyBattleSessionRecord = {
      sessionId,
      role: 'guest',
      generation,
      sessionCode,
      phase: 'aborted',
      status: 'aborted',
      transport: { host: hostAddr, port },
      opponent: null,
      pid: process.pid,
      daemonPid: 0,
      socketPath: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: 'aborted',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
    process.stderr.write(`STAGE: handshake\n`);
    process.stderr.write(`FAILED_STAGE: handshake\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Parse DAEMON_READY <sessionId> <socketPath>  (guest: 3 tokens)
  const parts = daemonReadyLine.trim().split(' ');
  const socketPath = parts[2] ?? '';

  const daemonPid = child.pid ?? 0;

  // Detach from the daemon's stdio so the CLI's event loop can exit.
  child.stdout.destroy();
  child.stderr?.destroy();
  child.unref();

  // Write the session record with daemon PID and socket path
  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'guest',
    generation,
    sessionCode,
    phase: 'handshake',
    status: 'connecting',
    transport: { host: hostAddr, port },
    opponent: null,
    pid: process.pid,
    daemonPid,
    socketPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);

  // Emit the first JSON envelope on stdout
  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `Joining battle (code ${sessionCode}) — see /tkm:friendly-battle status`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);
}

async function runWaitNextEvent(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionId = validateSafeId(requireFlag(flags, 'session'), 'session');
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const timeoutMs = requirePositiveInt(asStringFlag(flags, 'timeout-ms'), 'timeout-ms', 60_000);

  const record = readFriendlyBattleSessionRecord(sessionId, generation);
  if (!record || !record.socketPath || !record.daemonPid) {
    process.stderr.write(`REASON: unknown session ${sessionId}\n`);
    process.exit(1);
  }

  try {
    const response = await sendDaemonIpcRequest(record.socketPath, { op: 'wait_next_event', timeoutMs }, timeoutMs + 2_000);
    if (response.op === 'error') {
      process.stderr.write(`REASON: ${response.message}\n`);
      process.exit(1);
    }
    if (response.op !== 'event') {
      process.stderr.write(`REASON: unexpected daemon response ${response.op}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(response.envelope)}\n`);
  } catch (err) {
    // If the daemon has already exited cleanly (socket gone), synthesize a
    // terminal envelope from the session record on disk so the skill can
    // render a final "You won!" / "You lost!" / "Battle ended." message
    // instead of bubbling up an ENOENT/ECONNREFUSED crash. This matches the
    // "status never fails" pattern used by the `--status` subcommand.
    const msg = (err as Error).message;
    if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
      const frozen = readFriendlyBattleSessionRecord(sessionId, generation);
      if (frozen && (frozen.phase === 'finished' || frozen.phase === 'aborted')) {
        const questionContext = frozen.status === 'victory'
          ? 'You won!'
          : frozen.status === 'aborted'
            ? 'Battle ended.'
            : 'You lost!';
        const envelope = formatFriendlyBattleTurnJson({
          record: frozen,
          questionContext,
          moveOptions: [],
          partyOptions: [],
          animationFrames: [],
          currentFrameIndex: 0,
        });
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
        return;
      }
    }
    process.stderr.write(`REASON: ${msg}\n`);
    process.exit(1);
  }
}

async function runAction(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionId = validateSafeId(requireFlag(flags, 'session'), 'session');
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const token = requireFlag(flags, 'action');

  let action: import('../friendly-battle/daemon-protocol.js').DaemonAction;
  if (/^move:([1-4])$/.test(token)) {
    const match = /^move:([1-4])$/.exec(token)!;
    action = { kind: 'move', index: Number.parseInt(match[1], 10) - 1 };
  } else if (/^switch:([1-6])$/.test(token)) {
    const match = /^switch:([1-6])$/.exec(token)!;
    action = { kind: 'switch', pokemonIndex: Number.parseInt(match[1], 10) - 1 };
  } else if (token === 'surrender') {
    action = { kind: 'surrender' };
  } else {
    process.stderr.write(`REASON: unknown action token ${JSON.stringify(token)}\n`);
    process.exit(1);
  }

  const record = readFriendlyBattleSessionRecord(sessionId, generation);
  if (!record || !record.socketPath || !record.daemonPid) {
    process.stderr.write(`REASON: unknown session ${sessionId}\n`);
    process.exit(1);
  }

  try {
    const response = await sendDaemonIpcRequest(record.socketPath, { op: 'submit_action', action }, 10_000);
    if (response.op === 'error') {
      process.stderr.write(`REASON: ${response.message}\n`);
      process.exit(1);
    }
    if (response.op !== 'ack') {
      process.stderr.write(`REASON: unexpected daemon response ${response.op}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(response.envelope)}\n`);
  } catch (err) {
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

async function runStatus(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionId = validateSafeId(requireFlag(flags, 'session'), 'session');
  const generation = validateGeneration(asStringFlag(flags, 'generation'));

  const record = readFriendlyBattleSessionRecord(sessionId, generation);
  if (!record) {
    process.stderr.write(`REASON: unknown session ${sessionId}\n`);
    process.exit(1);
  }

  const daemonAlive = typeof record.daemonPid === 'number' && isPidAlive(record.daemonPid);
  if (daemonAlive && record.socketPath) {
    try {
      const response = await sendDaemonIpcRequest(record.socketPath, { op: 'status' }, 2_000);
      if (response.op === 'status') {
        process.stdout.write(`${JSON.stringify(response.envelope)}\n`);
        return;
      }
    } catch {
      // fall through to persisted snapshot
    }
  }

  // Daemon is dead or unreachable — synthesize a frozen envelope from the record
  const envelope = formatFriendlyBattleTurnJson({
    record,
    questionContext: daemonAlive ? 'Daemon unreachable' : 'Daemon no longer running',
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

async function runLeave(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionId = validateSafeId(requireFlag(flags, 'session'), 'session');
  const generation = validateGeneration(asStringFlag(flags, 'generation'));

  const record = readFriendlyBattleSessionRecord(sessionId, generation);
  if (!record) {
    process.stderr.write(`REASON: unknown session ${sessionId}\n`);
    process.exit(1);
  }

  const daemonAlive = typeof record.daemonPid === 'number' && isPidAlive(record.daemonPid);
  if (!daemonAlive || !record.socketPath) {
    // Daemon is already gone — emit a "you left" envelope and exit idempotently
    const envelope = formatFriendlyBattleTurnJson({
      record,
      questionContext: 'You left the battle. (daemon already gone)',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }

  try {
    const response = await sendDaemonIpcRequest(record.socketPath, { op: 'leave' }, 5_000);
    if (response.op === 'error') {
      process.stderr.write(`REASON: ${response.message}\n`);
      process.exit(1);
    }
    if (response.op !== 'ack') {
      process.stderr.write(`REASON: unexpected daemon response ${response.op}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(response.envelope)}\n`);
  } catch (err) {
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * List sessions whose daemon is still alive. Used by the skill's `resume`
 * flow when the conversation has lost the in-memory `sessionId` (e.g. the
 * conversation was compacted, restarted, or handed off mid-battle). The
 * output is a single JSON array on stdout — one entry per live session,
 * sorted by `updatedAt` descending so the caller can trivially pick the
 * most recent one.
 *
 * Terminal phases (`finished` / `aborted`) and dead daemons are filtered
 * out so a stale file never gets adopted as an "active" session.
 */
function runListActive(flags: Record<string, string | boolean | undefined>): void {
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const all = listFriendlyBattleSessionRecords(generation);
  const active = all
    .filter((r) => r.phase !== 'finished' && r.phase !== 'aborted')
    .filter((r) => typeof r.daemonPid === 'number' && r.daemonPid > 0 && isPidAlive(r.daemonPid))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Keep the payload small and skill-friendly: only the fields the resume
  // flow actually needs. Full records are still readable via --status.
  const payload = active.map((r) => ({
    sessionId: r.sessionId,
    role: r.role,
    generation: r.generation,
    sessionCode: r.sessionCode,
    phase: r.phase,
    status: r.status,
    transport: r.transport,
    updatedAt: r.updatedAt,
  }));
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function requireFlag(flags: Record<string, string | boolean | undefined>, name: string): string {
  const v = flags[name];
  if (typeof v === 'string') return v;
  process.stderr.write(`missing required flag --${name}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  switch (parsed.subcommand) {
    case 'init-host':
      await runInitHost(parsed.flags);
      return;
    case 'init-join':
      await runInitJoin(parsed.flags);
      return;
    case 'wait-next-event':
      await runWaitNextEvent(parsed.flags);
      return;
    case 'action':
      await runAction(parsed.flags);
      return;
    case 'status':
      await runStatus(parsed.flags);
      return;
    case 'leave':
      await runLeave(parsed.flags);
      return;
    case 'list-active':
      runListActive(parsed.flags);
      return;
  }
}

const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
