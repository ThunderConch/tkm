/**
 * E2E test: evolution AskUserQuestion via stop hook block emission.
 *
 * Verifies that when party pokemon have `evolution_ready && !evolution_prompt_shown`,
 * the stop hook emits `{decision:"block", reason}` containing the AskUserQuestion
 * instruction, and then sets `evolution_prompt_shown=true` on the scanned candidates.
 *
 * NOTE: Per plan Step 8, the canonical harness is tmux-based (spec AC9 calls for
 * full Claude Code session launch). That infrastructure is heavier than the current
 * time budget for this PR, so this test uses the `child_process` fallback path the
 * plan explicitly permits (Risk 4 mitigation). It isolates the tokenmon data dir
 * via `CLAUDE_CONFIG_DIR`, pipes a fake stdin JSON into stop.ts, captures stdout,
 * and asserts on the block output. The tmux variant is TODO: see AC9 — the rationale
 * is that the actual block JSON contract is fully tested here; tmux only adds coverage
 * for the real-session harness integration which is a separate concern.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeState, makeConfig } from '../helpers.js';
import type { State, Config } from '../../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const STOP_HOOK_PATH = join(REPO_ROOT, 'src', 'hooks', 'stop.ts');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runStopHook(dataDir: string, stdinJson: string): RunOutput {
  // Write minimal gen-map so session is recognized without session-start hook
  const genMapPath = join(dataDir, 'tokenmon', 'session-gen-map.json');
  if (!existsSync(dirname(genMapPath))) mkdirSync(dirname(genMapPath), { recursive: true });

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', STOP_HOOK_PATH],
    {
      input: stdinJson,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: dataDir,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      },
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      timeout: 15000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function seedState(dataDir: string, gen: string, stateOverrides: Partial<State>, configOverrides: Partial<Config>): void {
  const genDir = join(dataDir, 'tokenmon', gen);
  mkdirSync(genDir, { recursive: true });
  const state = makeState(stateOverrides);
  const config = makeConfig(configOverrides);
  writeFileSync(join(genDir, 'state.json'), JSON.stringify(state, null, 2));
  writeFileSync(join(genDir, 'config.json'), JSON.stringify(config, null, 2));
  // global config for active generation
  const globalConfig = {
    active_generation: gen,
    language: 'en',
    voice_tone: 'claude',
    weather_enabled: false,
    weather_location: '',
  };
  mkdirSync(join(dataDir, 'tokenmon'), { recursive: true });
  writeFileSync(join(dataDir, 'tokenmon', 'global-config.json'), JSON.stringify(globalConfig, null, 2));
  // common state
  writeFileSync(join(dataDir, 'tokenmon', 'common_state.json'), JSON.stringify({
    achievements: {},
    encounter_rate_bonus: 0,
    xp_bonus_multiplier: 1.0,
    items: {},
    max_party_size_bonus: 0,
    session_count: 0,
    total_tokens_consumed: 0,
    battle_count: 0,
    battle_wins: 0,
    catch_count: 0,
    evolution_count: 0,
    error_count: 0,
    permission_count: 0,
    total_gym_badges: 0,
    completed_gym_gens: 0,
    titles: [],
    rare_weight_multiplier: 1.0,
    last_codex_tokens_total: 0,
    last_turn_ts: Date.now(),
  }, null, 2));
}

describe('evolve AskUserQuestion via stop hook', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkm-evolve-e2e-'));
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('block JSON is emitted with AskUserQuestion instruction when candidate is evolution_ready', () => {
    const gen = 'gen4';
    const sessionId = 'test-session-evolve-1';
    // Turtwig (387) with evolution_ready already set, not yet prompted
    seedState(tmpDir, gen, {
      pokemon: {
        '387': {
          id: 387, xp: 5000, level: 18, friendship: 0, ev: 0,
          evolution_ready: true, evolution_options: ['388'],
        },
      },
      unlocked: ['387'],
      last_session_tokens: { [sessionId]: 1000 }, // avoid first_stop
    }, {
      party: ['387'],
      language: 'en',
    });

    const stdinJson = JSON.stringify({ session_id: sessionId });
    const out = runStopHook(tmpDir, stdinJson);

    assert.equal(out.status, 0, `stop hook should exit 0; stderr: ${out.stderr}`);
    // Find the last JSON line in stdout (in case cry or other stdout appears)
    const lines = out.stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
    assert.ok(lines.length > 0, `expected JSON output, got: ${out.stdout}`);
    const lastLine = lines[lines.length - 1];
    let parsed: any;
    try {
      parsed = JSON.parse(lastLine);
    } catch (e) {
      assert.fail(`could not parse JSON line "${lastLine}": ${e}`);
    }

    // AC1 / AC2: decision:"block" with reason containing AskUserQuestion instruction
    assert.equal(parsed.decision, 'block', `expected decision:"block", got: ${JSON.stringify(parsed)}`);
    assert.ok(typeof parsed.reason === 'string', 'reason should be a string');
    assert.match(parsed.reason, /AskUserQuestion/i, 'reason should instruct to call AskUserQuestion');
    assert.match(parsed.reason, /tokenmon evolve/i, 'reason should include the tokenmon evolve command');

    // Verify flag was set after block emission
    const stateAfter = JSON.parse(
      readFileSync(join(tmpDir, 'tokenmon', gen, 'state.json'), 'utf-8'),
    );
    assert.equal(
      stateAfter.pokemon['387'].evolution_prompt_shown, true,
      'evolution_prompt_shown should be set after block emission',
    );
  });

  it('no block when evolution_prompt_shown is already true', () => {
    // Fresh tmp dir for isolation
    const isolatedDir = mkdtempSync(join(tmpdir(), 'tkm-evolve-e2e-skip-'));
    try {
      const gen = 'gen4';
      const sessionId = 'test-session-evolve-2';
      seedState(isolatedDir, gen, {
        pokemon: {
          '387': {
            id: 387, xp: 5000, level: 18, friendship: 0, ev: 0,
            evolution_ready: true, evolution_options: ['388'],
            evolution_prompt_shown: true, // already prompted
          },
        },
        unlocked: ['387'],
        last_session_tokens: { [sessionId]: 1000 },
      }, {
        party: ['387'],
        language: 'en',
      });

      const stdinJson = JSON.stringify({ session_id: sessionId });
      const out = runStopHook(isolatedDir, stdinJson);

      assert.equal(out.status, 0);
      const lines = out.stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
      const lastLine = lines[lines.length - 1];
      const parsed = JSON.parse(lastLine);

      // Should be a normal continue, not a block
      assert.notEqual(parsed.decision, 'block', 'should not block when prompt_shown is true');
      assert.equal(parsed.continue, true, 'should continue normally');
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
