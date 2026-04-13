#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createFriendlyBattleSpikeHost, connectFriendlyBattleSpikeGuest } from '../friendly-battle/spike/tcp-direct.js';
import {
  type FriendlyBattleSessionRecord,
  writeFriendlyBattleSessionRecord,
} from '../friendly-battle/session-store.js';
import { formatFriendlyBattleTurnJson } from '../friendly-battle/turn-json.js';
import { loadFriendlyBattleCurrentProfile } from '../friendly-battle/local-harness.js';
import { buildFriendlyBattlePartySnapshot } from '../friendly-battle/snapshot.js';

type Subcommand =
  | 'init-host'
  | 'init-join'
  | 'action'
  | 'refresh'
  | 'status';

interface ParsedCliArgs {
  subcommand: Subcommand;
  flags: Record<string, string | boolean | undefined>;
}

const USAGE = [
  'Usage: friendly-battle-turn [subcommand] [flags]',
  '',
  'Subcommands:',
  '  --init-host --session-code <code> [--listen-host 127.0.0.1] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]',
  '  --init-join --session-code <code> --host <host> --port <port> [--timeout-ms 4000] [--generation gen4] [--player-name Guest]',
  '  --action <move|switch:N|surrender> --session <id>',
  '  --refresh (--frame <i> | --finalize) --session <id>',
  '  --status --session <id>',
  '',
].join('\n');

const SUBCOMMAND_FLAGS = new Set<string>([
  '--init-host',
  '--init-join',
  '--action',
  '--refresh',
  '--status',
]);

const CLI_FLAG_SCHEMA = {
  'session-code': { type: 'string' as const },
  'session': { type: 'string' as const },
  'host': { type: 'string' as const },
  'listen-host': { type: 'string' as const },
  'port': { type: 'string' as const },
  'timeout-ms': { type: 'string' as const },
  'generation': { type: 'string' as const },
  'player-name': { type: 'string' as const },
  'frame': { type: 'string' as const },
  'finalize': { type: 'boolean' as const },
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

// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(`${USAGE}\n`);
}

function resolveSubcommand(argv: string[]): Subcommand | null {
  if (argv.includes('--init-host')) return 'init-host';
  if (argv.includes('--init-join')) return 'init-join';
  if (argv.includes('--action')) return 'action';
  if (argv.includes('--refresh')) return 'refresh';
  if (argv.includes('--status')) return 'status';
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

async function runInitHost(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionCode = validateSessionCode(requireFlag(flags, 'session-code'));
  const listenHost = asStringFlag(flags, 'listen-host') ?? '127.0.0.1';
  const port = requirePositiveInt(asStringFlag(flags, 'port'), 'port', 0);
  const timeoutMs = requirePositiveInt(asStringFlag(flags, 'timeout-ms'), 'timeout-ms', 4000);
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const playerName = sanitizeName(asStringFlag(flags, 'player-name'), 'player-name', 'Host');

  let currentStage: 'waiting_for_guest' | 'handshake' | 'ready' | 'battle' = 'waiting_for_guest';

  const host = await createFriendlyBattleSpikeHost({
    host: listenHost,
    port,
    sessionCode,
    hostPlayerName: playerName,
    generation,
  });

  process.stderr.write(`PORT: ${host.connectionInfo.port}\n`);

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();

  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'host',
    generation,
    sessionCode,
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: {
      host: host.connectionInfo.host,
      port: host.connectionInfo.port,
    },
    opponent: null,
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);

  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `Waiting for guest (code ${sessionCode}) — press Ctrl+C to cancel`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);
  process.stderr.write(`STAGE: waiting_for_guest\n`);

  try {
    const joined = await host.waitForGuestJoin(timeoutMs);
    currentStage = 'handshake';
    process.stderr.write(`STAGE: guest_joined (${joined.guestPlayerName})\n`);

    // Mark host ready, wait for guest ready, then start the battle so the
    // guest's waitForStarted() can resolve.
    host.markHostReady();
    await host.waitUntilCanStart(timeoutMs);
    currentStage = 'ready';
    await host.startBattle(randomUUID());
    currentStage = 'battle';

    record.phase = 'battle';
    record.status = 'select_action';
    record.opponent = { playerName: joined.guestPlayerName };
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);

    // PR43 scope: emit the ready envelope and exit 0. Turn loop (wait-next-event)
    // is PR44.
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: `🤝 vs ${joined.guestPlayerName}`,
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
  } catch (err) {
    record.phase = 'aborted';
    record.status = 'aborted';
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: `aborted`,
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
    process.stderr.write(`STAGE: ${currentStage}\n`);
    process.stderr.write(`FAILED_STAGE: ${currentStage}\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    await host.close().catch(() => undefined);
    process.exit(1);
  }
  await host.close().catch(() => undefined);
}

async function runInitJoin(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sessionCode = validateSessionCode(requireFlag(flags, 'session-code'));
  const hostAddr = requireFlag(flags, 'host');
  const portStr = asStringFlag(flags, 'port') ?? requireFlag(flags, 'port');
  const port = requirePositiveInt(portStr, 'port');
  const timeoutMs = requirePositiveInt(asStringFlag(flags, 'timeout-ms'), 'timeout-ms', 4000);
  const generation = validateGeneration(asStringFlag(flags, 'generation'));
  const playerName = sanitizeName(asStringFlag(flags, 'player-name'), 'player-name', 'Guest');

  let currentStage: 'handshake' | 'ready' | 'battle' = 'handshake';

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();
  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'guest',
    generation,
    sessionCode,
    phase: 'handshake',
    status: 'connecting',
    transport: { host: hostAddr, port },
    opponent: { playerName: 'Host' },
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);

  let guest: Awaited<ReturnType<typeof connectFriendlyBattleSpikeGuest>> | undefined;
  try {
    const guestProfile = loadFriendlyBattleCurrentProfile(generation);
    const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);

    guest = await connectFriendlyBattleSpikeGuest({
      host: hostAddr,
      port,
      sessionCode,
      guestPlayerName: playerName,
      generation,
      guestSnapshot,
      timeoutMs,
    });
    process.stderr.write(`STAGE: connected\n`);

    await guest.markReady();
    record.phase = 'ready';
    record.status = 'connecting';
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stderr.write(`STAGE: ready\n`);
    currentStage = 'ready';

    await guest.waitForStarted(timeoutMs);
    record.phase = 'battle';
    record.status = 'select_action';
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stderr.write(`STAGE: battle_started\n`);
    currentStage = 'battle';

    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: `🤝 vs Host`,
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
  } catch (err) {
    record.phase = 'aborted';
    record.status = 'aborted';
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: `aborted`,
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
    process.stderr.write(`STAGE: ${currentStage}\n`);
    process.stderr.write(`FAILED_STAGE: ${currentStage}\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    await guest?.close().catch(() => undefined);
    process.exit(1);
  }

  await guest?.close().catch(() => undefined);
}

async function runAction(_flags: Record<string, string | boolean | undefined>): Promise<void> {
  throw new Error('not implemented: --action');
}
async function runRefresh(_flags: Record<string, string | boolean | undefined>): Promise<void> {
  throw new Error('not implemented: --refresh');
}
async function runStatus(_flags: Record<string, string | boolean | undefined>): Promise<void> {
  throw new Error('not implemented: --status');
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
    case 'action':
      await runAction(parsed.flags);
      return;
    case 'refresh':
      await runRefresh(parsed.flags);
      return;
    case 'status':
      await runStatus(parsed.flags);
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
