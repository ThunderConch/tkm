#!/usr/bin/env -S npx tsx
import { FriendlyBattleTransportError, connectFriendlyBattleSpikeGuest, createFriendlyBattleSpikeHost } from '../friendly-battle/spike/tcp-direct.js';
import type { FriendlyBattleBattleEvent, FriendlyBattleChoice } from '../friendly-battle/contracts.js';
import { loadFriendlyBattleCurrentProfile } from '../friendly-battle/local-harness.js';
import { buildFriendlyBattlePartySnapshot } from '../friendly-battle/snapshot.js';

type Command = 'host' | 'join';

type ParsedArgs = {
  command: Command;
  values: Map<string, string>;
};

function usage(): never {
  console.error('Usage:');
  console.error('  tokenmon friendly-battle spike host --session-code <code> [--listen-host 127.0.0.1] [--join-host <host>] [--port 0] [--timeout-ms 4000] [--generation gen4]');
  console.error('  tokenmon friendly-battle spike join --host <host> --port <port> --session-code <code> [--timeout-ms 4000] [--generation gen4]');
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

function getNumberArg(values: Map<string, string>, key: string, fallback: number): number {
  const rawValue = values.get(key);
  if (!rawValue) return fallback;
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    console.error(`Invalid number for --${key}: ${rawValue}`);
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

function formatRetryHintFromError(errorMessage: string, fallbackCommand: string): string {
  const sessionCodeMatch = errorMessage.match(/session code\(([^)]+)\)/i);
  if (!sessionCodeMatch) {
    return fallbackCommand;
  }

  return fallbackCommand.replace(/--session-code\s+\S+/, `--session-code ${sessionCodeMatch[1]}`);
}

function printFriendlyBattleFailure(args: {
  stage: string;
  nextAction: string;
  inputHint: string;
  retryHint: string;
}): void {
  console.error(`FAILED_STAGE: ${args.stage}`);
  console.error(`NEXT_ACTION: ${args.nextAction}`);
  console.error(`INPUT_HINT: ${args.inputHint}`);
  console.error(`RETRY_HINT: ${args.retryHint}`);
}

function formatFriendlyBattleChoice(choice: FriendlyBattleChoice): string {
  switch (choice.type) {
    case 'move':
      return `move:${choice.moveIndex}`;
    case 'switch':
      return `switch:${choice.pokemonIndex}`;
    case 'surrender':
      return 'surrender';
  }
}

async function runHost(values: Map<string, string>): Promise<void> {
  const listenHost = values.get('listen-host') ?? values.get('host') ?? '127.0.0.1';
  const joinHost = values.get('join-host');
  const port = getNumberArg(values, 'port', 0);
  const timeoutMs = getNumberArg(values, 'timeout-ms', 4_000);
  const sessionCode = getRequiredArg(values, 'session-code');
  const generation = values.get('generation') ?? 'gen4';
  const hostHintLabel = values.has('listen-host') ? 'listenHost' : 'host';
  const inputHint = `${hostHintLabel}=${listenHost}${joinHost ? ` joinHost=${joinHost}` : ''} port=${port} sessionCode=${sessionCode}`;
  let currentStage: 'listen' | 'join' | 'ready' | 'battle' = 'listen';
  const retryCommandParts = [
    process.execPath,
    '--import',
    'tsx',
    'src/cli/friendly-battle-spike.ts',
    'host',
    '--listen-host',
    listenHost,
    '--port',
    String(port),
    '--session-code',
    sessionCode,
    '--timeout-ms',
    String(timeoutMs),
    '--generation',
    generation,
  ];
  if (joinHost) {
    retryCommandParts.push('--join-host', joinHost);
  }
  const retryCommand = retryCommandParts.map(shellEscape).join(' ');

  const withStageTimeout = async <T>(
    promise: Promise<T>,
    code: string,
    message: string,
  ): Promise<T> => {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof FriendlyBattleTransportError && error.code === 'timeout') {
        throw new FriendlyBattleTransportError(code, message);
      }
      throw error;
    }
  };

  const handleFriendlyBattleError = (error: FriendlyBattleTransportError): never => {
    const stage = error.code === 'listen_failed'
      || error.code === 'advertise_host_required'
      ? 'listen'
      : error.code === 'join_timeout' || error.code === 'not_connected'
        ? 'join'
        : error.code === 'socket_closed'
          ? currentStage
        : error.code === 'ready_timeout' || error.code === 'not_ready'
          ? 'ready'
          : error.code === 'guest_choice_timeout' || error.code === 'battle_not_started'
            ? 'battle'
            : 'host';

    const nextAction = stage === 'listen' && error.code === 'advertise_host_required'
      ? 'guest가 접속할 실제 join host를 --join-host 로 지정한 뒤 다시 host 하세요.'
      : stage === 'listen'
        ? '입력한 host/port를 확인하거나 이미 같은 포트를 쓰는 프로세스를 종료한 뒤 다시 host 하세요.'
      : stage === 'ready'
        ? 'guest가 join 후 ready 단계까지 완료했는지 확인한 뒤 다시 host 하세요.'
        : stage === 'join'
          ? 'guest가 올바른 host/port/session code로 join 했는지 확인하세요.'
          : stage === 'battle'
            ? 'battle 시작 후 상대 행동이 도착하는지 확인하고, 필요하면 다시 host 하세요.'
          : '입력한 host/port/session code와 guest 진행 상태를 확인한 뒤 다시 host 하세요.';

    printFriendlyBattleFailure({
      stage,
      nextAction,
      inputHint,
      retryHint: retryCommand,
    });
    throw error;
  };

  let host;
  try {
    host = await createFriendlyBattleSpikeHost({
      host: listenHost,
      advertiseHost: joinHost,
      port,
      sessionCode,
      hostPlayerName: values.get('player-name') ?? 'Host',
      generation,
    });
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      handleFriendlyBattleError(error);
    }
    throw error;
  }

  try {
    const joinCommand = [
      process.execPath,
      '--import',
      'tsx',
      'src/cli/friendly-battle-spike.ts',
      'join',
      '--host',
      host.connectionInfo.host,
      '--port',
      String(host.connectionInfo.port),
      '--session-code',
      sessionCode,
      '--timeout-ms',
      String(timeoutMs),
      '--generation',
      generation,
    ].map(shellEscape).join(' ');

    console.log(`JOIN_INFO: ${JSON.stringify(host.connectionInfo)}`);
    console.log(`JOIN_COMMAND: ${joinCommand}`);

    currentStage = 'join';
    const joined = await withStageTimeout(
      host.waitForGuestJoin(timeoutMs),
      'join_timeout',
      'guest join 대기 중 시간이 초과되었습니다.',
    );
    console.log(`STAGE: guest_joined (${joined.guestPlayerName})`);

    currentStage = 'ready';
    host.markHostReady();
    await withStageTimeout(
      host.waitUntilCanStart(timeoutMs),
      'ready_timeout',
      'guest ready 대기 중 시간이 초과되었습니다.',
    );
    const battleId = `spike-${sessionCode}`;
    await host.startBattle(battleId);
    console.log('STAGE: battle_started');

    currentStage = 'battle';
    const initialEvents: FriendlyBattleBattleEvent[] = [
      {
        type: 'battle_initialized',
        battleId,
        turn: 1,
      },
      {
        type: 'choices_requested',
        turn: 1,
        waitingFor: ['guest'],
        phase: 'waiting_for_choices',
      },
    ];
    host.sendBattleEvents(initialEvents);
    for (const event of initialEvents) {
      console.log(`EVENT_SENT: ${event.type}`);
    }

    const guestChoice = await withStageTimeout(
      host.waitForGuestChoice(timeoutMs),
      'guest_choice_timeout',
      'guest choice 대기 중 시간이 초과되었습니다.',
    );
    console.log(`GUEST_CHOICE: ${formatFriendlyBattleChoice(guestChoice.choice)}`);

    const resultEvents: FriendlyBattleBattleEvent[] = [
      {
        type: 'turn_resolved',
        turn: 1,
        messages: ['authoritative spike smoke resolved the guest choice'],
        waitingFor: [],
        nextPhase: 'completed',
        winner: 'host',
      },
      {
        type: 'battle_finished',
        winner: 'host',
        reason: 'completed',
      },
    ];
    host.sendBattleEvents(resultEvents);
    for (const event of resultEvents) {
      console.log(`EVENT_SENT: ${event.type}`);
    }
    console.log('WINNER: host');
    console.log('SUCCESS: authoritative_event_smoke_completed');
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      handleFriendlyBattleError(error);
    }
    throw error;
  } finally {
    await host.close();
  }
}

async function runJoin(values: Map<string, string>): Promise<void> {
  const hostAddress = getRequiredArg(values, 'host');
  const port = getNumberArg(values, 'port', Number.NaN);
  const timeoutMs = getNumberArg(values, 'timeout-ms', 4_000);
  const sessionCode = getRequiredArg(values, 'session-code');
  const generation = values.get('generation') ?? 'gen4';
  const guestProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);
  let currentStage: 'join' | 'ready' | 'battle' = 'join';

  const fallbackRetryCommand = [
    process.execPath,
    '--import',
    'tsx',
    'src/cli/friendly-battle-spike.ts',
    'join',
    '--host',
    hostAddress,
    '--port',
    String(port),
    '--session-code',
    sessionCode,
    '--timeout-ms',
    String(timeoutMs),
    '--generation',
    generation,
  ].map(shellEscape).join(' ');

  const handleFriendlyBattleError = (error: FriendlyBattleTransportError): never => {
    const stage = error.code === 'bad_session_code'
      ? 'handshake'
      : error.code === 'connection_failed'
        ? 'connect'
        : error.code === 'battle_not_started'
          ? 'battle'
          : currentStage;

    const nextAction = stage === 'handshake'
      ? 'host가 보여준 session code를 다시 확인한 뒤 다시 join 하세요.'
      : stage === 'connect' || stage === 'join'
        ? 'host 프로세스와 입력한 host/port/session code를 다시 확인하세요.'
        : stage === 'ready'
          ? 'host가 battle 시작 전까지 유지되고 있는지 확인한 뒤 다시 join 하세요.'
          : 'host가 battle 시작 단계까지 진행됐는지 확인한 뒤 다시 join 하세요.';

    printFriendlyBattleFailure({
      stage,
      nextAction,
      inputHint: `host=${hostAddress} port=${port} sessionCode=${sessionCode}`,
      retryHint: formatRetryHintFromError(error.message, fallbackRetryCommand),
    });
    throw error;
  };

  let guest;
  try {
    guest = await connectFriendlyBattleSpikeGuest({
      host: hostAddress,
      port,
      sessionCode,
      guestPlayerName: values.get('player-name') ?? 'Guest',
      generation,
      guestSnapshot,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      handleFriendlyBattleError(error);
    }
    throw error;
  }

  try {
    console.log('STAGE: connected');
    currentStage = 'ready';
    await guest.markReady();
    console.log('STAGE: ready');

    currentStage = 'battle';
    await guest.waitForStarted(timeoutMs);
    console.log('STAGE: battle_started');

    let battleFinished = false;
    while (!battleFinished) {
      const event = await guest.waitForBattleEvent(timeoutMs);
      console.log(`EVENT_RECEIVED: ${event.type}`);

      if (event.type === 'choices_requested' && event.waitingFor.includes('guest')) {
        const choiceValue = event.phase === 'awaiting_fainted_switch' ? 'surrender' : 'move:1';
        const submittedChoice = await guest.submitChoice(choiceValue);
        console.log(`GUEST_CHOICE: ${formatFriendlyBattleChoice(submittedChoice.choice)}`);
        continue;
      }

      if (event.type === 'battle_finished') {
        console.log(`WINNER: ${event.winner ?? 'none'}`);
        console.log('SUCCESS: authoritative_event_smoke_completed');
        battleFinished = true;
      }
    }
  } catch (error) {
    if (error instanceof FriendlyBattleTransportError) {
      handleFriendlyBattleError(error);
    }
    throw error;
  } finally {
    await guest.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === 'host') {
    await runHost(values);
    return;
  }

  await runJoin(values);
}

main().catch((error: unknown) => {
  if (error instanceof FriendlyBattleTransportError) {
    console.error(error.message);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
