#!/usr/bin/env -S npx tsx
/**
 * test-evolve.ts — Dev-only E2E test harness orchestrator for the evolution
 * AskUserQuestion flow.
 *
 * Subcommands:
 *   (default)            run all 6 scenarios sequentially
 *   --scenario <name>    run a single scenario by name
 *   --restore            restore from the latest backup and exit
 *   --dry-run            validate scenarios + check tmux, no LLM cost
 *   --help               print usage
 *
 * Global try/finally ensures state is restored even on crash or SIGINT.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { getActiveGeneration } from '../core/paths.js';
import {
  createBackup,
  getLatestBackup,
  restoreBackup,
  restoreHooksJson,
  swapHooksJson,
  type BackupManifest,
} from '../test-evolve/backup.js';
import {
  ASK_USER_QUESTION_UI_REGEX,
  capturePane,
  checkTmux,
  killSession,
  makeScenarioConfigDir,
  sendKeys,
  spawnPane,
  waitForPattern,
} from '../test-evolve/tmux-driver.js';
import { verifyScenario, type Scenario, type VerifyResult } from '../test-evolve/verify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCENARIOS_DIR = join(REPO_ROOT, 'src', 'test-scenarios');

// ── CLI parsing ──

interface CliArgs {
  help: boolean;
  dryRun: boolean;
  restore: boolean;
  scenario: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, dryRun: false, restore: false, scenario: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--restore':
        args.restore = true;
        break;
      case '--scenario':
        args.scenario = argv[++i] ?? null;
        break;
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`test-evolve: unknown flag ${a}\n`);
        }
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'test-evolve — dev-only E2E harness for the evolution AskUserQuestion flow',
      '',
      'Usage:',
      '  test-evolve                        Run all 6 scenarios sequentially',
      '  test-evolve --scenario <name>      Run a single scenario by name',
      '  test-evolve --restore              Restore from latest backup and exit',
      '  test-evolve --dry-run              Validate scenarios + tmux, no LLM cost',
      '  test-evolve --help                 Show this help',
      '',
      'Scenarios:',
      '  branch-eevee, single-charmander, multi-3, overflow-5,',
      '  refuse-persist, accept-clear-reprompt',
      '',
    ].join('\n'),
  );
}

// ── Scenario loading ──

function loadScenarios(): Scenario[] {
  if (!existsSync(SCENARIOS_DIR)) {
    throw new Error(`test-evolve: scenarios dir missing: ${SCENARIOS_DIR}`);
  }
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(SCENARIOS_DIR, f), 'utf-8')) as Scenario);
}

function loadScenarioByName(name: string): Scenario {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`test-evolve: scenario not found: ${name} (expected at ${path})`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Scenario;
}

// ── Seed writer ──

interface SeedState {
  pokemon: Record<string, any>;
  unlocked: string[];
  [k: string]: any;
}

interface SeedConfig {
  party: string[];
  [k: string]: any;
}

function writeSeed(configDir: string, gen: string, scenario: Scenario): void {
  const tokenmonDir = join(configDir, 'tokenmon', gen);
  mkdirSync(tokenmonDir, { recursive: true });

  const state: SeedState = {
    pokemon: scenario.seed.pokemon,
    unlocked: scenario.seed.unlocked,
  };
  const config: SeedConfig = { party: scenario.seed.party };

  writeFileSync(join(tokenmonDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  writeFileSync(join(tokenmonDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

// ── Scenario runner ──

interface ScenarioResult {
  name: string;
  verify: VerifyResult | null;
  error: string | null;
  durationMs: number;
  cost_estimate_usd: number;
}

async function runScenario(scenario: Scenario, gen: string): Promise<ScenarioResult> {
  const start = Date.now();
  const sessionName = `tkm-test-${scenario.name}`;
  const configDir = makeScenarioConfigDir(scenario.name);
  let paneId: string | null = null;

  try {
    writeSeed(configDir, gen, scenario);

    // Spawn a claude pane. Minimal prompt asks LLM to just say "ok" to
    // trigger the Stop hook which will emit the block.
    const claudePrompt = `just say ok. if you get an AskUserQuestion about pokemon evolution, pick option ${scenario.expected_choice}.`;
    const handle = spawnPane({
      sessionName,
      envVars: {
        CLAUDE_CONFIG_DIR: configDir,
        TOKENMON_HOOK_MODE: '1',
      },
      cwd: REPO_ROOT,
      command: `claude -p ${JSON.stringify(claudePrompt)}`,
    });
    paneId = handle.paneId;

    // Wait for AskUserQuestion UI to render (numbered option prefixes)
    const uiMatch = await waitForPattern(paneId, ASK_USER_QUESTION_UI_REGEX, 120_000);
    if (!uiMatch) {
      return {
        name: scenario.name,
        verify: null,
        error: 'timeout waiting for AskUserQuestion UI',
        durationMs: Date.now() - start,
        cost_estimate_usd: 0.1,
      };
    }

    // Inject choice
    sendKeys(paneId, scenario.expected_choice);

    // Wait for evolution completion — look for `tokenmon evolve` call
    // signature or scenario completion markers.
    await waitForPattern(paneId, /tokenmon\s+evolve\s+\d+/, 60_000);

    const captured = capturePane(paneId, { history: true });
    const verify = verifyScenario(captured, scenario, gen, configDir);

    return {
      name: scenario.name,
      verify,
      error: null,
      durationMs: Date.now() - start,
      cost_estimate_usd: 0.2,
    };
  } catch (err: any) {
    return {
      name: scenario.name,
      verify: null,
      error: err?.message ?? String(err),
      durationMs: Date.now() - start,
      cost_estimate_usd: 0.05,
    };
  } finally {
    killSession(sessionName);
  }
}

// ── Report ──

function printReport(results: ScenarioResult[]): void {
  const lines: string[] = [];
  lines.push('');
  lines.push('┌──────────────────────────┬────────┬────────┬─────────┬────────┬──────────┐');
  lines.push('│ scenario                 │ result │ UI     │ Tool    │ State  │ cost$    │');
  lines.push('├──────────────────────────┼────────┼────────┼─────────┼────────┼──────────┤');
  let totalCost = 0;
  for (const r of results) {
    const name = r.name.padEnd(24).slice(0, 24);
    const overall = r.verify?.pass ? 'PASS  ' : 'FAIL  ';
    const ui = r.verify?.layer_ui.pass ? 'ok    ' : 'x     ';
    const tool = r.verify?.layer_tool.pass ? 'ok     ' : 'x      ';
    const state = r.verify?.layer_state.pass ? 'ok    ' : 'x     ';
    const cost = `$${r.cost_estimate_usd.toFixed(2)}`.padEnd(8);
    totalCost += r.cost_estimate_usd;
    lines.push(`│ ${name} │ ${overall} │ ${ui} │ ${tool} │ ${state} │ ${cost} │`);
    if (r.error) {
      lines.push(`│   error: ${r.error.slice(0, 62).padEnd(62)} │`);
    }
    if (r.verify && !r.verify.pass) {
      if (!r.verify.layer_ui.pass) lines.push(`│   UI: ${r.verify.layer_ui.detail.slice(0, 66).padEnd(66)} │`);
      if (!r.verify.layer_tool.pass) lines.push(`│   Tool: ${r.verify.layer_tool.detail.slice(0, 64).padEnd(64)} │`);
      if (!r.verify.layer_state.pass) {
        for (const d of r.verify.layer_state.diffs.slice(0, 4)) {
          const detail = `${d.field}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`;
          lines.push(`│   State: ${detail.slice(0, 63).padEnd(63)} │`);
        }
      }
    }
  }
  lines.push('└──────────────────────────┴────────┴────────┴─────────┴────────┴──────────┘');
  const passed = results.filter((r) => r.verify?.pass).length;
  lines.push(`Total: ${passed}/${results.length} passed, estimated cost $${totalCost.toFixed(2)}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

// ── Subcommand implementations ──

async function runAll(scenarios: Scenario[], gen: string, backup: BackupManifest): Promise<void> {
  process.stdout.write(`test-evolve: backup @ ${backup.dir}\n`);
  process.stdout.write(`test-evolve: swapping hooks.json -> ${REPO_ROOT}\n`);
  const swap = swapHooksJson(REPO_ROOT);
  process.stdout.write(`test-evolve: swap mode=${swap.mode} path=${swap.hooksPath}\n`);

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    process.stdout.write(`\n── running ${s.name} ──\n`);
    const r = await runScenario(s, gen);
    results.push(r);
    process.stdout.write(`   done in ${r.durationMs}ms — ${r.verify?.pass ? 'PASS' : 'FAIL'}${r.error ? ` (${r.error})` : ''}\n`);
  }
  printReport(results);
}

async function dryRun(scenarios: Scenario[], gen: string): Promise<void> {
  checkTmux();
  process.stdout.write(`test-evolve dry-run (gen=${gen})\n`);
  process.stdout.write(`tmux: available\n`);
  process.stdout.write(`scenarios loaded: ${scenarios.length}\n`);
  for (const s of scenarios) {
    const readyCount = Object.values(s.seed.pokemon).filter((p: any) => p?.evolution_ready).length;
    process.stdout.write(
      `  - ${s.name.padEnd(24)}  party=${s.seed.party.length}  ready=${readyCount}  choice=${s.expected_choice}\n`,
    );
  }
  process.stdout.write(`\nNo LLM cost incurred. Run without --dry-run to execute.\n`);
}

function doRestore(gen: string): void {
  const latest = getLatestBackup();
  if (!latest) {
    process.stderr.write('test-evolve --restore: no backup found under .tokenmon/test-backup/\n');
    process.exit(1);
  }
  process.stdout.write(`test-evolve: restoring from ${latest}\n`);
  restoreBackup(latest, gen);
  process.stdout.write(`test-evolve: restore complete\n`);
}

// ── Main entry ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const gen = getActiveGeneration();

  if (args.restore) {
    doRestore(gen);
    return;
  }

  // Load scenarios early so --dry-run can validate them.
  let scenarios: Scenario[];
  try {
    scenarios = args.scenario ? [loadScenarioByName(args.scenario)] : loadScenarios();
  } catch (err: any) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }

  if (args.dryRun) {
    await dryRun(scenarios, gen);
    return;
  }

  checkTmux();
  const backup = createBackup(gen);

  // SIGINT handler — ensure restore even on Ctrl+C
  const sigintHandler = () => {
    process.stderr.write('\ntest-evolve: SIGINT — restoring backup before exit\n');
    try {
      restoreBackup(backup.dir, gen);
      restoreHooksJson(backup.dir);
    } catch (err) {
      process.stderr.write(`test-evolve: restore on SIGINT failed: ${err}\n`);
    }
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  try {
    await runAll(scenarios, gen, backup);
  } finally {
    process.off('SIGINT', sigintHandler);
    try {
      restoreBackup(backup.dir, gen);
      restoreHooksJson(backup.dir);
      process.stdout.write(`test-evolve: state restored from ${backup.dir}\n`);
    } catch (err) {
      process.stderr.write(`test-evolve: restore failed: ${err}\n`);
      process.stderr.write(`test-evolve: manual recovery: test-evolve --restore\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`test-evolve: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
