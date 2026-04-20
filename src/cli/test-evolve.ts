#!/usr/bin/env -S npx tsx
/**
 * test-evolve.ts — Dev-only manual test harness for the evolution AskUserQuestion flow.
 *
 * Subcommands:
 *   --list               list all scenarios
 *   --setup <scenario>   backup, swap hooks.json, seed state/config
 *   --verify             compare live state vs scenario expected_after
 *   --restore            restore backup and clean up current.json
 *   --help               print usage
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { DATA_DIR, configPath, getActiveGeneration, statePath } from '../core/paths.js';
import { createBackup, restoreBackup, swapHooksJson } from '../test-evolve/backup.js';
import { verifyState, type Scenario } from '../test-evolve/verify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCENARIOS_DIR = join(REPO_ROOT, 'src', 'test-scenarios');
const CURRENT_PTR = join(DATA_DIR, 'test-backup', 'current.json');

interface CurrentPtr { backupDir: string; scenario: string; gen: string }

// ── Scenario loading ──

function loadScenarios(): Scenario[] {
  if (!existsSync(SCENARIOS_DIR)) throw new Error(`test-evolve: scenarios dir missing: ${SCENARIOS_DIR}`);
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(SCENARIOS_DIR, f), 'utf-8')) as Scenario);
}

function loadScenarioByName(name: string): Scenario {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`test-evolve: scenario not found: ${name} (expected at ${path})`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Scenario;
}

// ── Seed writer ──

function writeSeed(gen: string, scenario: Scenario, backupDir: string): void {
  const sfile = statePath(gen);
  const cfile = configPath(gen);
  mkdirSync(dirname(sfile), { recursive: true });
  mkdirSync(dirname(cfile), { recursive: true });

  const sBackup = join(backupDir, 'state.json');
  const cBackup = join(backupDir, 'config.json');
  const baseState: Record<string, unknown> = existsSync(sBackup)
    ? JSON.parse(readFileSync(sBackup, 'utf-8')) : {};
  const baseConfig: Record<string, unknown> = existsSync(cBackup)
    ? JSON.parse(readFileSync(cBackup, 'utf-8')) : {};

  // Merge scenario items on top of backed-up state.items so the evolve CLI's
  // condition check sees the needed stones/held-items. Backs-up take
  // precedence only for keys the scenario did not set.
  const mergedItems = {
    ...(baseState.items as Record<string, number> | undefined ?? {}),
    ...(scenario.seed.items ?? {}),
  };

  writeFileSync(sfile, JSON.stringify({
    ...baseState,
    pokemon: scenario.seed.pokemon,
    unlocked: scenario.seed.unlocked,
    items: mergedItems,
  }, null, 2), 'utf-8');

  const configOverlay: Record<string, unknown> = {
    ...baseConfig,
    party: scenario.seed.party,
    starter_chosen: true,
  };
  if (scenario.seed.current_region) configOverlay.current_region = scenario.seed.current_region;
  writeFileSync(cfile, JSON.stringify(configOverlay, null, 2), 'utf-8');
}

// ── Subcommands ──

function doList(): void {
  const scenarios = loadScenarios();
  process.stdout.write(`\ntest-evolve scenarios (${scenarios.length}):\n\n`);
  for (const s of scenarios) {
    const readyCount = Object.values(s.seed.pokemon).filter((p: any) => p?.evolution_ready).length;
    process.stdout.write(`  ${s.name.padEnd(26)}  ${s.description}\n`);
    process.stdout.write(`  ${''.padEnd(26)}  party=${s.seed.party.join(',')}  ready=${readyCount}  choice=${s.expected_choice}\n\n`);
  }
}

function doSetup(scenarioName: string): void {
  const gen = getActiveGeneration();
  const scenario = loadScenarioByName(scenarioName);
  const backup = createBackup(gen);
  process.stdout.write(`test-evolve: backup @ ${backup.dir}\n`);

  const swap = swapHooksJson(REPO_ROOT);
  process.stdout.write(`test-evolve: hooks.json swapped (mode=${swap.mode} path=${swap.hooksPath})\n`);

  writeSeed(gen, scenario, backup.dir);
  process.stdout.write(`test-evolve: state seeded for scenario "${scenarioName}"\n`);

  mkdirSync(dirname(CURRENT_PTR), { recursive: true });
  const ptr: CurrentPtr = { backupDir: backup.dir, scenario: scenarioName, gen };
  writeFileSync(CURRENT_PTR, JSON.stringify(ptr, null, 2), 'utf-8');
  process.stdout.write(`test-evolve: pointer written to ${CURRENT_PTR}\n`);
  process.stdout.write(`\nReady. Send any short message to trigger the evolution prompt.\nWhen done: tokenmon test-evolve --verify  then  tokenmon test-evolve --restore\n`);
}

function doVerify(): void {
  if (!existsSync(CURRENT_PTR)) {
    process.stderr.write('test-evolve --verify: no current.json found. Run --setup first.\n');
    process.exit(1);
  }
  const ptr = JSON.parse(readFileSync(CURRENT_PTR, 'utf-8')) as CurrentPtr;
  const scenario = loadScenarioByName(ptr.scenario);
  const result = verifyState(scenario, ptr.gen);

  process.stdout.write(`\ntest-evolve verify: scenario=${ptr.scenario}\n`);
  for (const [field, expected] of Object.entries(scenario.expected_after)) {
    const diff = result.diffs.find((d) => d.field === field || d.field.startsWith(`${field}[`));
    const pass = !diff;
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${field}: expected=${JSON.stringify(expected)}${diff ? `  actual=${JSON.stringify(diff.actual)}` : ''}\n`);
  }
  process.stdout.write(`\nOverall: ${result.pass ? 'PASS' : `FAIL (${result.diffs.length} diff(s))`}\n\n`);
  if (!result.pass) process.exit(1);
}

function doRestore(): void {
  if (!existsSync(CURRENT_PTR)) {
    process.stderr.write('test-evolve --restore: no current.json found. Nothing to restore.\n');
    process.exit(1);
  }
  const ptr = JSON.parse(readFileSync(CURRENT_PTR, 'utf-8')) as CurrentPtr;
  restoreBackup(ptr.backupDir, ptr.gen);
  process.stdout.write(`test-evolve: restored from ${ptr.backupDir}\n`);
  unlinkSync(CURRENT_PTR);
  process.stdout.write('test-evolve: current.json removed. Restore complete.\n');
}

function printHelp(): void {
  process.stdout.write([
    'test-evolve — dev-only manual harness for the evolution AskUserQuestion flow',
    '',
    'Usage:',
    '  tokenmon test-evolve --list                list all scenarios',
    '  tokenmon test-evolve --setup <scenario>    backup + seed + swap hooks.json',
    '  tokenmon test-evolve --verify              compare live state vs expected_after',
    '  tokenmon test-evolve --restore             restore backup, remove current.json',
    '  tokenmon test-evolve --help                show this help',
    '',
  ].join('\n'));
}

// ── Main ──

function main(): void {
  const argv = process.argv.slice(2);
  const flag = argv[0];

  if (!flag || flag === '--help' || flag === '-h') { printHelp(); return; }
  if (flag === '--list') { doList(); return; }
  if (flag === '--setup') {
    const name = argv[1];
    if (!name) { process.stderr.write('test-evolve --setup: scenario name required\n'); process.exit(1); }
    doSetup(name); return;
  }
  if (flag === '--verify') { doVerify(); return; }
  if (flag === '--restore') { doRestore(); return; }

  process.stderr.write(`test-evolve: unknown subcommand: ${flag}\nRun with --help for usage.\n`);
  process.exit(1);
}

main();
