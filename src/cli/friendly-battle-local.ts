#!/usr/bin/env -S npx tsx
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FriendlyBattleBattleRuntime } from '../friendly-battle/battle-adapter.js';
import {
  FriendlyBattleTransportError,
  connectFriendlyBattleSpikeGuest,
  createFriendlyBattleSpikeHost,
} from '../friendly-battle/spike/tcp-direct.js';
import {
  attachFriendlyBattleGuestSnapshot,
  cleanupFriendlyBattleLocalArtifacts,
  createFriendlyBattleChoiceEnvelope,
  createFriendlyBattleLocalArtifacts,
  formatFriendlyBattleChoice,
  loadFriendlyBattleCurrentProfile,
  markFriendlyBattleReady,
  startFriendlyBattleLocalBattle,
  selectDeterministicFriendlyBattleChoiceValue,
  submitFriendlyBattleLocalChoice,
} from '../friendly-battle/local-harness.js';
import { buildFriendlyBattlePartySnapshot } from '../friendly-battle/snapshot.js';
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
  console.error('  tokenmon friendly-battle local host --session-code <code> [--listen-host 127.0.0.1] [--join-host <host>] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]');
  console.error('  tokenmon friendly-battle local join --host <host> --port <port> --session-code <code> [--timeout-ms 4000] [--generation gen4] [--player-name Guest]');
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

function getWaitingFor(runtime: FriendlyBattleBattleRuntime): Array<'host' | 'guest'> {
  if (runtime.phase === 'completed') {
    return [];
  }

  if (runtime.phase === 'waiting_for_choices') {
    return (['host', 'guest'] as const).filter(
      (role) => runtime.pendingChoices[role] === undefined,
    );
  }

  return (['host', 'guest'] as const).filter((role) => {
    if (runtime.pendingChoices[role] !== undefined) {
      return false;
    }

    const team = role === 'host' ? runtime.state.player : runtime.state.opponent;
    const activePokemon = team.pokemon[team.activeIndex];
    return activePokemon !== undefined
      && activePokemon.fainted
      && team.pokemon.some((pokemon, index) => index !== team.activeIndex && !pokemon.fainted);
  });
}

function listRuntimeChoiceOptions(
  runtime: FriendlyBattleBattleRuntime,
  actor: 'host' | 'guest',
): string[] {
  const team = actor === 'host' ? runtime.state.player : runtime.state.opponent;

  const switchChoices = team.pokemon
    .flatMap((pokemon, index) => (
      index !== team.activeIndex && !pokemon.fainted
        ? [`switch:${index}`]
        : []
    ));

  if (runtime.phase === 'awaiting_fainted_switch') {
    return [...switchChoices, 'surrender'];
  }

  const activePokemon = team.pokemon[team.activeIndex];
  const moveChoices = activePokemon?.moves
    .flatMap((move, index) => (move.currentPp > 0 ? [`move:${index}`] : []))
    ?? [];

  return [...moveChoices, ...switchChoices, 'surrender'];
}

async function promptForChoice(input: {
  promptLabel: 'HOST_PROMPT' | 'GUEST_PROMPT';
  actorLabel: string;
  turn: number;
  phase: string;
  choices: string[];
}): Promise<string> {
  const promptLine = `${input.promptLabel}: turn ${input.turn} [${input.phase}] choose ${input.choices.join(', ')}`;
  console.log(promptLine);

  while (true) {
    const answer = await new Promise<string>((resolveAnswer) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(`${input.actorLabel}> `, (value) => {
        rl.close();
        process.stdin.pause();
        resolveAnswer(value.trim());
      });
    });

    if (input.choices.includes(answer)) {
      return answer;
    }

    console.log(`INVALID_CHOICE: ${answer || '<empty>'}`);
    console.log(promptLine);
  }
}

function stdinSupportsPromptChoices(): boolean {
  if (process.stdin.isTTY) {
    return true;
  }

  return process.stdin.constructor?.name === 'Socket';
}

function shouldPromptForChoices(): boolean {
  if (process.env.TOKENMON_FORCE_PROMPTS === '1') {
    return true;
  }

  if (process.env.TOKENMON_AUTO_CHOICES === '1') {
    return false;
  }

  return stdinSupportsPromptChoices();
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
  const generation = values.get('generation');
  const hostPlayerName = values.get('player-name') ?? 'Host';
  const guestPlayerName = values.get('guest-player-name') ?? 'Guest';

  const hostProfile = loadFriendlyBattleCurrentProfile(generation);
  const artifacts = createFriendlyBattleLocalArtifacts({
    hostProfile,
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
      generation: hostProfile.generation,
    });

    console.log(`SESSION_PATH: ${artifacts.sessionPath}`);
    console.log(`HOST_SNAPSHOT_PATH: ${artifacts.hostSnapshotPath}`);
    console.log(`BATTLE_PATH: ${artifacts.battlePath}`);

    const joinCommand = buildJoinCommand({
      host: host.connectionInfo.host,
      port: host.connectionInfo.port,
      guestPlayerName,
      sessionCode,
      timeoutMs,
      generation: hostProfile.generation,
      style: options.joinCommandStyle ?? 'local-script',
    });

    console.log(`JOIN_INFO: ${JSON.stringify(host.connectionInfo)}`);
    console.log(`JOIN_COMMAND: ${joinCommand}`);

    currentStage = 'join';
    const joined = await host.waitForGuestJoin(timeoutMs);
    attachFriendlyBattleGuestSnapshot(artifacts, {
      guestPlayerName: joined.guestPlayerName,
      guestSnapshot: joined.guestSnapshot,
    });
    console.log(`GUEST_SNAPSHOT_PATH: ${artifacts.guestSnapshotPath}`);
    console.log(`STAGE: guest_joined (${joined.guestPlayerName})`);

    currentStage = 'ready';
    const hostReadyState = host.markHostReady();
    markFriendlyBattleReady(artifacts, hostReadyState);
    const readyState = await host.waitUntilCanStart(timeoutMs);
    markFriendlyBattleReady(artifacts, readyState);
    console.log('STAGE: ready');

    const battle = startFriendlyBattleLocalBattle(artifacts);
    await host.startBattle(battle.runtime.battleId);
    host.sendBattleEvents(battle.events);
    console.log('STAGE: battle_started');

    currentStage = 'battle';
    let winner: 'host' | 'guest' | null = null;

    while (true) {
      if (battle.runtime.phase === 'completed') {
        break;
      }

      if (getWaitingFor(battle.runtime).includes('host')) {
        const hostChoiceValue = shouldPromptForChoices()
          ? await promptForChoice({
            promptLabel: 'HOST_PROMPT',
            actorLabel: 'host',
            turn: battle.runtime.state.turn + 1,
            phase: battle.runtime.phase,
            choices: listRuntimeChoiceOptions(battle.runtime, 'host'),
          })
          : selectDeterministicFriendlyBattleChoiceValue(battle.runtime, 'host');
        console.log(`HOST_CHOICE: ${hostChoiceValue}`);
        const hostEvents = submitFriendlyBattleLocalChoice({
          artifacts,
          battle,
          envelope: createFriendlyBattleChoiceEnvelope('host', hostChoiceValue),
        });

        if (hostEvents.length > 0) {
          host.sendBattleEvents(hostEvents);
          const finished = hostEvents.find((event) => event.type === 'battle_finished');
          if (finished) {
            winner = finished.winner;
          }
        }
      }

      if (getWaitingFor(battle.runtime).includes('guest')) {
        const guestEnvelope = await host.waitForGuestChoice(timeoutMs);
        console.log(`GUEST_CHOICE: ${formatFriendlyBattleChoice(guestEnvelope.choice)}`);
        const guestEvents = submitFriendlyBattleLocalChoice({
          artifacts,
          battle,
          envelope: guestEnvelope,
        });

        if (guestEvents.length > 0) {
          host.sendBattleEvents(guestEvents);
          const finished = guestEvents.find((event) => event.type === 'battle_finished');
          if (finished) {
            winner = finished.winner;
          }
        }
      }
    }

    console.log(`WINNER: ${winner ?? 'none'}`);
    console.log('SUCCESS: battle_completed');
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
  const generation = values.get('generation');
  const guestPlayerName = values.get('player-name') ?? 'Guest';
  const guestProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);

  let currentStage: 'connect' | 'ready' | 'battle' = 'connect';
  let guest;
  try {
    guest = await connectFriendlyBattleSpikeGuest({
      host: hostAddress,
      port,
      sessionCode,
      guestPlayerName,
      generation: guestProfile.generation,
      guestSnapshot,
      timeoutMs,
    });

    console.log('STAGE: connected');
    currentStage = 'ready';
    await guest.markReady();
    console.log('STAGE: ready');

    currentStage = 'battle';
    await guest.waitForStarted(timeoutMs);
    console.log('STAGE: battle_started');

    while (true) {
      const event = await guest.waitForBattleEvent(timeoutMs);
      console.log(`EVENT_RECEIVED: ${event.type}`);

      if (event.type === 'choices_requested' && event.waitingFor.includes('guest')) {
        const guestChoiceValue = shouldPromptForChoices()
          ? await promptForChoice({
            promptLabel: 'GUEST_PROMPT',
            actorLabel: 'guest',
            turn: event.turn,
            phase: event.phase,
            choices: event.phase === 'awaiting_fainted_switch'
              ? guestSnapshot.pokemon
                .slice(1)
                .map((_, index) => `switch:${index + 1}`)
                .concat('surrender')
              : ['move:0', 'surrender'],
          })
          : (event.phase === 'awaiting_fainted_switch' ? 'surrender' : 'move:0');
        await guest.submitChoice(guestChoiceValue);
        console.log(`GUEST_CHOICE: ${guestChoiceValue}`);
      }

      if (event.type === 'battle_finished') {
        console.log(`WINNER: ${event.winner ?? 'none'}`);
        console.log('SUCCESS: battle_completed');
        break;
      }
    }
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
  host: string;
  port: number;
  guestPlayerName: string;
  sessionCode: string;
  timeoutMs: number;
  generation: string;
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
    ...command,
    '--host',
    shellEscape(params.host),
    '--port',
    shellEscape(String(params.port)),
    '--session-code',
    shellEscape(params.sessionCode),
    '--timeout-ms',
    shellEscape(String(params.timeoutMs)),
    '--generation',
    shellEscape(params.generation),
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
