#!/usr/bin/env -S npx tsx
import { FriendlyBattleTransportError, connectFriendlyBattleSpikeGuest, createFriendlyBattleSpikeHost } from '../friendly-battle/spike/tcp-direct.js';

type Command = 'host' | 'join';

type ParsedArgs = {
  command: Command;
  values: Map<string, string>;
};

function usage(): never {
  console.error('Usage:');
  console.error('  tokenmon friendly-battle spike host --session-code <code> [--host 127.0.0.1] [--port 0] [--timeout-ms 4000]');
  console.error('  tokenmon friendly-battle spike join --host <host> --port <port> --session-code <code> [--timeout-ms 4000]');
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

async function runHost(values: Map<string, string>): Promise<void> {
  const hostAddress = values.get('host') ?? '127.0.0.1';
  const port = getNumberArg(values, 'port', 0);
  const timeoutMs = getNumberArg(values, 'timeout-ms', 4_000);
  const sessionCode = getRequiredArg(values, 'session-code');
  let currentStage: 'listen' | 'join' | 'ready' | 'battle' = 'listen';
  const retryCommand = [
    process.execPath,
    '--import',
    'tsx',
    'src/cli/friendly-battle-spike.ts',
    'host',
    '--host',
    hostAddress,
    '--port',
    String(port),
    '--session-code',
    sessionCode,
    '--timeout-ms',
    String(timeoutMs),
  ].map(shellEscape).join(' ');

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
      ? 'listen'
      : error.code === 'join_timeout' || error.code === 'not_connected'
        ? 'join'
        : error.code === 'socket_closed'
          ? currentStage
        : error.code === 'ready_timeout' || error.code === 'not_ready'
          ? 'ready'
          : error.code === 'guest_action_timeout' || error.code === 'battle_not_started'
            ? 'battle'
            : 'host';

    const nextAction = stage === 'listen'
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
      inputHint: `host=${hostAddress} port=${port} sessionCode=${sessionCode}`,
      retryHint: retryCommand,
    });
    throw error;
  };

  let host;
  try {
    host = await createFriendlyBattleSpikeHost({
      host: hostAddress,
      port,
      sessionCode,
      hostPlayerName: values.get('player-name') ?? 'Host',
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
    await host.startBattle();
    console.log('STAGE: battle_started');

    currentStage = 'battle';
    const guestActionPromise = withStageTimeout(
      host.waitForGuestAction(timeoutMs),
      'guest_action_timeout',
      'guest action 대기 중 시간이 초과되었습니다.',
    );
    const guestAction = await guestActionPromise;
    console.log(`GUEST_ACTION: ${guestAction.value}`);

    const hostAction = host.submitHostAction('move:1');
    console.log(`HOST_ACTION: ${hostAction.value}`);
    console.log('SUCCESS: first_action_exchange_completed');
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

    const guestAction = await guest.submitAction('move:1');
    console.log(`GUEST_ACTION: ${guestAction.value}`);

    const hostAction = await guest.waitForHostAction(timeoutMs);
    console.log(`HOST_ACTION: ${hostAction.value}`);
    console.log('SUCCESS: first_action_exchange_completed');
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
