#!/usr/bin/env -S npx tsx
import { getLocale } from '../i18n/index.js';
import { runFriendlyBattleLocalCli } from './friendly-battle-local.js';

type Copy = {
  title: string;
  summary: string;
  steps: string[];
  commandsTitle: string;
  hostCommand: string;
  joinCommand: string;
  readyCommand: string;
  leaveCommand: string;
  helpCommand: string;
  exampleTitle: string;
  exampleCommand: string;
  readyTitle: string;
  readyBody: string;
  readyNext: string;
  leaveTitle: string;
  leaveBody: string;
  leaveNext: string;
  unknown: (command: string) => string;
};

const KO_COPY: Copy = {
  title: '친선 배틀 (로컬 v1)',
  summary: '같은 네트워크에서 두 개의 Claude 프로필/터미널을 열고 인게임 감성의 즉석 친선전을 시작합니다.',
  steps: [
    '1) 호스트가 첫 번째 터미널에서 host 명령을 실행합니다.',
    '2) 출력된 JOIN_COMMAND를 상대 프로필 터미널에 그대로 붙여넣습니다.',
    '3) local v1에서는 두 쪽이 연결되면 ready가 자동으로 처리되고 바로 배틀이 시작됩니다.',
  ],
  commandsTitle: '명령:',
  hostCommand: '  host --session-code <코드> [--listen-host 127.0.0.1] [--join-host <host>] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]',
  joinCommand: '  join --host <host> --port <port> --session-code <코드> [--timeout-ms 4000] [--player-name Guest]',
  readyCommand: '  ready              현재 local v1에서 ready가 어떻게 동작하는지 설명',
  leaveCommand: '  leave              현재 local v1에서 세션을 빠져나오는 방법 설명',
  helpCommand: '  help               이 도움말 보기',
  exampleTitle: '예시:',
  exampleCommand: '  tokenmon friendly-battle host --session-code alpha-123 --generation gen4',
  readyTitle: 'READY_STATUS: automatic_in_local_v1',
  readyBody: 'local v1에서는 host와 join이 모두 연결되면 ready가 자동으로 처리됩니다. 지금은 별도의 ready 입력이 필요하지 않습니다.',
  readyNext: 'NEXT_ACTION: host 터미널에서 JOIN_COMMAND를 복사해 상대 프로필 터미널에서 실행하세요.',
  leaveTitle: 'LEAVE_STATUS: stop_the_running_terminal',
  leaveBody: 'local v1에서는 별도 leave 패킷 없이 현재 실행 중인 host/join 터미널을 중단하면 세션을 종료할 수 있습니다.',
  leaveNext: 'NEXT_ACTION: 실행 중인 터미널에서 Ctrl+C로 중단한 뒤 다시 host부터 시작하세요.',
  unknown: (command: string) => `알 수 없는 friendly-battle 명령: ${command}`,
};

const EN_COPY: Copy = {
  title: 'Friendly Battle (local v1)',
  summary: 'Start an in-game-style friendly battle from two Claude profiles/terminals on the same network.',
  steps: [
    '1) The host runs the host command from the first terminal.',
    '2) Copy the printed JOIN_COMMAND into the opponent profile terminal.',
    '3) In local v1, ready is automatic once both sides connect, so the battle starts immediately.',
  ],
  commandsTitle: 'Commands:',
  hostCommand: '  host --session-code <code> [--listen-host 127.0.0.1] [--join-host <host>] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]',
  joinCommand: '  join --host <host> --port <port> --session-code <code> [--timeout-ms 4000] [--player-name Guest]',
  readyCommand: '  ready              Explain how ready works in local v1',
  leaveCommand: '  leave              Explain how to leave/cancel the current local session',
  helpCommand: '  help               Show this help',
  exampleTitle: 'Example:',
  exampleCommand: '  tokenmon friendly-battle host --session-code alpha-123 --generation gen4',
  readyTitle: 'READY_STATUS: automatic_in_local_v1',
  readyBody: 'In local v1, ready becomes automatic once both host and join are connected. You do not need a separate ready input yet.',
  readyNext: 'NEXT_ACTION: copy the JOIN_COMMAND from the host terminal and run it from the opponent profile terminal.',
  leaveTitle: 'LEAVE_STATUS: stop_the_running_terminal',
  leaveBody: 'Local v1 does not send a dedicated leave packet yet. Stop the currently running host/join terminal to leave the session.',
  leaveNext: 'NEXT_ACTION: press Ctrl+C in the running terminal, then start again from host when you want a new battle.',
  unknown: (command: string) => `Unknown friendly-battle command: ${command}`,
};

function copy(): Copy {
  return getLocale() === 'ko' ? KO_COPY : EN_COPY;
}

function printFriendlyBattleHelp(): void {
  const text = copy();
  console.log(text.title);
  console.log('');
  console.log(text.summary);
  console.log('');
  for (const step of text.steps) {
    console.log(step);
  }
  console.log('');
  console.log(text.commandsTitle);
  console.log(text.hostCommand);
  console.log(text.joinCommand);
  console.log(text.readyCommand);
  console.log(text.leaveCommand);
  console.log(text.helpCommand);
  console.log('');
  console.log(text.exampleTitle);
  console.log(text.exampleCommand);
}

function printReadyGuidance(): void {
  const text = copy();
  console.log(text.readyTitle);
  console.log(text.readyBody);
  console.log(text.readyNext);
}

function printLeaveGuidance(): void {
  const text = copy();
  console.log(text.leaveTitle);
  console.log(text.leaveBody);
  console.log(text.leaveNext);
}

function isHelpArg(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export async function runFriendlyBattleCli(argv: string[]): Promise<void> {
  const [commandCandidate, ...rest] = argv;
  const command = commandCandidate ?? 'help';

  if (command === '--help' || command === '-h') {
    printFriendlyBattleHelp();
    return;
  }

  switch (command) {
    case 'help':
      printFriendlyBattleHelp();
      return;
    case 'host':
      if (isHelpArg(rest)) {
        printFriendlyBattleHelp();
        return;
      }
      await runFriendlyBattleLocalCli(['host', ...rest], {
        joinCommandStyle: 'tokenmon-cli',
      });
      return;
    case 'join':
      if (isHelpArg(rest)) {
        printFriendlyBattleHelp();
        return;
      }
      await runFriendlyBattleLocalCli(['join', ...rest]);
      return;
    case 'ready':
      printReadyGuidance();
      return;
    case 'leave':
      printLeaveGuidance();
      return;
    case 'local':
      await runFriendlyBattleLocalCli(rest);
      return;
    default:
      console.error(copy().unknown(commandCandidate ?? ''));
      console.error('');
      printFriendlyBattleHelp();
      process.exit(1);
  }
}

const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  runFriendlyBattleCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
