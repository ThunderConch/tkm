#!/usr/bin/env -S npx tsx
import { join } from 'node:path';
import {
  FriendlyBattleTransportError,
  connectFriendlyBattleSpikeGuest,
  createFriendlyBattleSpikeHost,
} from '../friendly-battle/spike/tcp-direct.js';
import {
  cleanupFriendlyBattleLocalArtifacts,
  createFriendlyBattleLocalArtifacts,
  loadFriendlyBattleCurrentProfile,
  loadFriendlyBattleProfileFromConfigDir,
  markFriendlyBattleGuestJoined,
  markFriendlyBattleReady,
  resolveFriendlyBattleLocalFirstTurn,
  startFriendlyBattleLocalBattle,
} from '../friendly-battle/local-harness.js';
import { PLUGIN_ROOT } from '../core/paths.js';

type Command = 'host' | 'join';

type ParsedArgs = {
  command: Command;
  values: Map<string, string>;
};

export type FriendlyBattleLocalCliOptions = {
  joinCommandStyle?: 'local-script' | 'tokenmon-cli';
};

function usage(): never {
  console.error('Usage:');
  console.error('  tokenmon friendly-battle local host --session-code <code> --guest-config-dir <path> [--listen-host 127.0.0.1] [--join-host <host>] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]');
  console.error('  tokenmon friendly-battle local join --host <host> --port <port> --session-code <code> [--timeout-ms 4000] [--player-name Guest]');
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [commandCandidate, ...rest] = argv;
  if (commandCandidate !== 'host' && commandCandidate !== 'join') {
    usage();
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) {
      usage();
    }

    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      usage();
    }

    values.set(key, value);
    index += 1;
  }

  return { command: commandCandidate, values };
}

function getRequiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    usage();
  }
  return value;
}

function getNumberArg(
  values: Map<string, string>,
  key: string,
  fallback: number,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const rawValue = values.get(key);
  if (!rawValue) return fallback;
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    console.error(`Invalid number for --${key}: ${rawValue}`);
    process.exit(1);
  }
  if (options.integer !== false && !Number.isInteger(parsedValue)) {
    console.error(`Invalid integer for --${key}: ${rawValue}`);
    process.exit(1);
  }
  if (options.min !== undefined && parsedValue < options.min) {
    console.error(`--${key} must be >= ${options.min}: ${rawValue}`);
    process.exit(1);
  }
  if (options.max !== undefined && parsedValue > options.max) {
    console.error(`--${key} must be <= ${options.max}: ${rawValue}`);
    process.exit(1);
  }
  return parsedValue;
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printFailure(stage: string, message: string): void {
  console.error(`FAILED_STAGE: ${stage}`);
  console.error(message);
}

async function runHost(
  values: Map<string, string>,
  options: FriendlyBattleLocalCliOptions = {},
): Promise<void> {
  const listenHost = values.get('listen-host') ?? values.get('host') ?? '127.0.0.1';
  const joinHost = values.get('join-host');
  const port = getNumberArg(values, 'port', 0, { min: 0, max: 65_535 });
  const timeoutMs = getNumberArg(values, 'timeout-ms', 4_000, { min: 1 });
  const sessionCode = getRequiredArg(values, 'session-code');
  const guestConfigDir = getRequiredArg(values, 'guest-config-dir');
  const generation = values.get('generation');
  const hostPlayerName = values.get('player-name') ?? 'Host';
  const guestPlayerName = values.get('guest-player-name') ?? 'Guest';

  const hostProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestProfile = loadFriendlyBattleProfileFromConfigDir(guestConfigDir, generation ?? hostProfile.generation);
  const artifacts = createFriendlyBattleLocalArtifacts({
    hostProfile,
    guestProfile,
    sessionCode,
    hostPlayerName,
    guestPlayerName,
  });

  let currentStage: 'listen' | 'join' | 'ready' | 'battle' = 'listen';
  let host;

  try {
    host = await createFriendlyBattleSpikeHost({
      host: listenHost,
      advertiseHost: joinHost,
      port,
      sessionCode,
      hostPlayerName,
    });

    console.log(`SESSION_PATH: ${artifacts.sessionPath}`);
    console.log(`HOST_SNAPSHOT_PATH: ${artifacts.hostSnapshotPath}`);
    console.log(`GUEST_SNAPSHOT_PATH: ${artifacts.guestSnapshotPath}`);
    console.log(`BATTLE_PATH: ${artifacts.battlePath}`);

    const joinCommand = buildJoinCommand({
      guestConfigDir,
      host: host.connectionInfo.host,
      port: host.connectionInfo.port,
      guestPlayerName,
      sessionCode,
      timeoutMs,
      style: options.joinCommandStyle ?? 'local-script',
    });

    console.log(`JOIN_INFO: ${JSON.stringify(host.connectionInfo)}`);
    console.log(`JOIN_COMMAND: ${joinCommand}`);

    currentStage = 'join';
    const joined = await host.waitForGuestJoin(timeoutMs);
    markFriendlyBattleGuestJoined(artifacts, joined.guestPlayerName);
    console.log(`STAGE: guest_joined (${joined.guestPlayerName})`);

    currentStage = 'ready';
    const hostReadyState = host.markHostReady();
    markFriendlyBattleReady(artifacts, hostReadyState);
    const readyState = await host.waitUntilCanStart(timeoutMs);
    markFriendlyBattleReady(artifacts, readyState);
    console.log('STAGE: ready');

    const { runtime } = startFriendlyBattleLocalBattle(artifacts);
    await host.startBattle();
    console.log('STAGE: battle_started');

    currentStage = 'battle';
    const guestAction = await host.waitForGuestAction(timeoutMs);
    const hostAction = host.submitHostAction('move:1');
    resolveFriendlyBattleLocalFirstTurn({
      artifacts,
      runtime,
      guestActionValue: guestAction.value,
      hostActionValue: hostAction.value,
    });
    console.log('SUCCESS: first_turn_smoke_completed');
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      printFailure(currentStage, error.message);
    }
    throw error;
  } finally {
    await host?.close().catch(() => undefined);
    cleanupFriendlyBattleLocalArtifacts(artifacts);
    console.log('CLEANUP: session_artifacts_removed');
  }
}

async function runJoin(values: Map<string, string>): Promise<void> {
  const hostAddress = getRequiredArg(values, 'host');
  const port = getNumberArg(values, 'port', Number.NaN, { min: 1, max: 65_535 });
  const timeoutMs = getNumberArg(values, 'timeout-ms', 4_000, { min: 1 });
  const sessionCode = getRequiredArg(values, 'session-code');
  const guestPlayerName = values.get('player-name') ?? 'Guest';

  let currentStage: 'connect' | 'ready' | 'battle' = 'connect';
  let guest;
  try {
    guest = await connectFriendlyBattleSpikeGuest({
      host: hostAddress,
      port,
      sessionCode,
      guestPlayerName,
      timeoutMs,
    });

    console.log('STAGE: connected');
    currentStage = 'ready';
    await guest.markReady();
    console.log('STAGE: ready');

    currentStage = 'battle';
    await guest.waitForStarted(timeoutMs);
    console.log('STAGE: battle_started');

    await guest.submitAction('move:1');
    await guest.waitForHostAction(timeoutMs);
    console.log('SUCCESS: first_turn_smoke_completed');
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      printFailure(currentStage, error.message);
    }
    throw error;
  } finally {
    await guest?.close().catch(() => undefined);
  }
}

function buildJoinCommand(params: {
  guestConfigDir: string;
  host: string;
  port: number;
  guestPlayerName: string;
  sessionCode: string;
  timeoutMs: number;
  style: 'local-script' | 'tokenmon-cli';
}): string {
  const command =
    params.style === 'tokenmon-cli'
      ? [
          shellEscape(process.execPath),
          '--import',
          'tsx',
          shellEscape(join(PLUGIN_ROOT, 'src', 'cli', 'tokenmon.ts')),
          'friendly-battle',
          'join',
        ]
      : [
          shellEscape(process.execPath),
          '--import',
          'tsx',
          'src/cli/friendly-battle-local.ts',
          'join',
        ];

  return [
    'env',
    `CLAUDE_CONFIG_DIR=${shellEscape(params.guestConfigDir)}`,
    ...command,
    '--host',
    shellEscape(params.host),
    '--port',
    shellEscape(String(params.port)),
    '--session-code',
    shellEscape(params.sessionCode),
    '--timeout-ms',
    shellEscape(String(params.timeoutMs)),
    '--player-name',
    shellEscape(params.guestPlayerName),
  ].join(' ');
}

export async function runFriendlyBattleLocalCli(
  argv: string[],
  options: FriendlyBattleLocalCliOptions = {},
): Promise<void> {
  const { command, values } = parseArgs(argv);
  if (command === 'host') {
    await runHost(values, options);
    return;
  }

  await runJoin(values);
}

const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  runFriendlyBattleLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof FriendlyBattleTransportError) {
      console.error(error.message);
      process.exit(1);
    }

    console.error(error);
    process.exit(1);
  });
}
