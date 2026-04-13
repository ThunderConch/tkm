#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';

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

async function runInitHost(_flags: Record<string, string | boolean | undefined>): Promise<void> {
  throw new Error('not implemented: --init-host');
}
async function runInitJoin(_flags: Record<string, string | boolean | undefined>): Promise<void> {
  throw new Error('not implemented: --init-join');
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
