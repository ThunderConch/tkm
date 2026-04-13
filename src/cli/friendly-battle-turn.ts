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
  const { values } = parseArgs({
    args: flagArgs,
    options: CLI_FLAG_SCHEMA,
    strict: false,
    allowPositionals: true,
  });

  return { subcommand, flags: values as Record<string, string | boolean | undefined> };
}

async function runInitHost(flags: Record<string, string | undefined>): Promise<void> {
  const sessionCode = requireFlag(flags, 'session-code');
  const listenHost = flags['listen-host'] ?? '127.0.0.1';
  const port = Number.parseInt(flags.port ?? '0', 10);
  const timeoutMs = Number.parseInt(flags['timeout-ms'] ?? '4000', 10);
  const generation = flags.generation ?? 'gen4';
  const playerName = flags['player-name'] ?? 'Host';

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
    process.stderr.write(`STAGE: guest_joined (${joined.guestPlayerName})\n`);

    // Mark host ready, wait for guest ready, then start the battle so the
    // guest's waitForStarted() can resolve.
    host.markHostReady();
    await host.waitUntilCanStart(timeoutMs);
    await host.startBattle(randomUUID());

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
    process.stderr.write(`STAGE: waiting_for_guest\n`);
    process.stderr.write(`FAILED_STAGE: waiting_for_guest\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    await host.close().catch(() => undefined);
    process.exit(1);
  }
  await host.close().catch(() => undefined);
}
async function runInitJoin(flags: Record<string, string | boolean | undefined>): Promise<void> {
  const stringFlags = flags as Record<string, string | undefined>;
  const sessionCode = requireFlag(stringFlags, 'session-code');
  const hostAddr = requireFlag(stringFlags, 'host');
  const port = Number.parseInt(requireFlag(stringFlags, 'port'), 10);
  const timeoutMs = Number.parseInt(stringFlags['timeout-ms'] ?? '4000', 10);
  const generation = stringFlags.generation ?? 'gen4';
  const playerName = stringFlags['player-name'] ?? 'Guest';

  const guestProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);

  const guest = await connectFriendlyBattleSpikeGuest({
    host: hostAddr,
    port,
    sessionCode,
    guestPlayerName: playerName,
    generation,
    guestSnapshot,
    timeoutMs,
  });

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
  process.stderr.write(`STAGE: connected\n`);

  await guest.markReady();
  record.phase = 'ready';
  record.status = 'connecting';
  record.updatedAt = nowIso();
  writeFriendlyBattleSessionRecord(record);
  process.stderr.write(`STAGE: ready\n`);

  await guest.waitForStarted(timeoutMs);
  record.phase = 'battle';
  record.status = 'select_action';
  record.updatedAt = nowIso();
  writeFriendlyBattleSessionRecord(record);
  process.stderr.write(`STAGE: battle_started\n`);

  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `🤝 vs Host`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);

  await guest.close().catch(() => undefined);
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

function requireFlag(flags: Record<string, string | undefined>, name: string): string {
  const value = flags[name];
  if (value === undefined) {
    process.stderr.write(`missing required flag --${name}\n`);
    process.exit(1);
  }
  return value;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  switch (parsed.subcommand) {
    case 'init-host':
      await runInitHost(parsed.flags as Record<string, string | undefined>);
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
