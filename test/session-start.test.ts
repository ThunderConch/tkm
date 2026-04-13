import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = process.cwd();
let entryScriptQueue: Promise<void> = Promise.resolve();
const sharedSessionTestRoot = mkdtempSync(join(tmpdir(), 'session-start-test-'));
const sharedSessionHomeDir = join(sharedSessionTestRoot, 'home');
const sharedSessionClaudeDir = join(sharedSessionHomeDir, '.claude');
const sharedSessionTokenmonDir = join(sharedSessionClaudeDir, 'tokenmon');
const sharedSessionGenDir = join(sharedSessionTokenmonDir, 'gen4');
const sharedSessionBattleStatePath = join(sharedSessionTokenmonDir, 'battle-state.json');
const sharedSessionStatePath = join(sharedSessionGenDir, 'state.json');
const sessionStartEntry = resolve(REPO_ROOT, 'src/hooks/session-start.ts');
let childRunCounter = 0;

mkdirSync(sharedSessionGenDir, { recursive: true });
process.once('exit', () => {
  rmSync(sharedSessionTestRoot, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function makeSessionStartEnv(t: { after: (fn: () => void) => void }) {
  void t;
  rmSync(sharedSessionBattleStatePath, { force: true });

  writeJson(join(sharedSessionTokenmonDir, 'global-config.json'), {
    active_generation: 'gen4',
    language: 'en',
    voice_tone: 'claude',
    weather_enabled: false,
    weather_location: '',
  });

  writeJson(join(sharedSessionGenDir, 'config.json'), {
    tokens_per_xp: 10000,
    party: [],
    starter_chosen: false,
    volume: 0.5,
    sprite_enabled: true,
    cry_enabled: true,
    xp_formula: 'medium_fast',
    xp_bonus_multiplier: 1,
    max_party_size: 3,
    peon_ping_integration: false,
    peon_ping_port: 19998,
    current_region: '1',
    default_dispatch: null,
    sprite_mode: 'all',
    renderer: 'braille',
    info_mode: 'ace_full',
    tips_enabled: true,
    notifications_enabled: true,
    pp_enabled: true,
    language: 'en',
  });

  writeJson(sharedSessionStatePath, {
    pokemon: {},
    unlocked: [],
    achievements: {},
    total_tokens_consumed: 0,
    session_count: 0,
    error_count: 0,
    permission_count: 0,
    evolution_count: 0,
    last_session_id: null,
    xp_bonus_multiplier: 1,
    last_session_tokens: {},
    pokedex: {},
    encounter_count: 0,
    catch_count: 0,
    battle_count: 0,
    battle_wins: 0,
    battle_losses: 0,
    items: {},
    cheat_log: [],
    last_battle: null,
    last_tip: null,
    last_drop: null,
    last_achievement: null,
    notifications: [],
    dismissed_notifications: [],
    last_known_regions: 1,
    stats: {
      streak_days: 0,
      longest_streak: 0,
      last_active_date: '',
      weekly_xp: 0,
      weekly_battles_won: 0,
      weekly_battles_lost: 0,
      weekly_catches: 0,
      weekly_encounters: 0,
      total_xp_earned: 0,
      total_battles_won: 0,
      total_battles_lost: 0,
      total_catches: 0,
      total_encounters: 0,
      last_reset_week: '',
    },
    events_triggered: [],
    pokedex_milestones_claimed: [],
    type_masters: [],
    legendary_pool: [],
    legendary_pending: [],
    titles: [],
    completed_chains: [],
    star_dismissed: false,
    shiny_encounter_count: 0,
    shiny_catch_count: 0,
    shiny_escaped_count: 0,
    gym_badges: [],
    rare_weight_multiplier: 1,
    battleStats: { defeats: 7 },
  });

  return {
    battleStatePath: sharedSessionBattleStatePath,
    statePath: sharedSessionStatePath,
    env: {
      ...process.env,
      HOME: sharedSessionHomeDir,
      CLAUDE_CONFIG_DIR: sharedSessionClaudeDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    } as NodeJS.ProcessEnv,
  };
}

async function runSessionStart(env: NodeJS.ProcessEnv): Promise<string> {
  const run = entryScriptQueue.then(async () => {
    return await new Promise<string>((resolveRun, rejectRun) => {
      const runId = childRunCounter++;
      const stdoutPath = join(sharedSessionTestRoot, `child-${runId}.stdout.log`);
      const stderrPath = join(sharedSessionTestRoot, `child-${runId}.stderr.log`);
      const stdoutFd = openSync(stdoutPath, 'w');
      const stderrFd = openSync(stderrPath, 'w');
      const child = spawn(process.execPath, ['--import', 'tsx', sessionStartEntry], {
        cwd: REPO_ROOT,
        env,
        stdio: ['pipe', stdoutFd, stderrFd],
      });

      closeSync(stdoutFd);
      closeSync(stderrFd);
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        rejectRun(new Error('Timed out waiting for src/hooks/session-start.ts'));
      }, 10_000);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectRun(error);
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const stdout = readFileSync(stdoutPath, 'utf8');
        const stderr = readFileSync(stderrPath, 'utf8');
        if (signal !== null || exitCode !== 0) {
          rejectRun(
            new Error(
              `session-start exited unexpectedly with code ${exitCode} signal ${signal}: ${stdout}${stderr ? `\n${stderr}` : ''}`,
            ),
          );
          return;
        }
        resolveRun(stdout.trim());
      });
      child.stdin.end('{}');
    });
  });

  entryScriptQueue = run.then(() => undefined, () => undefined);
  return run;
}

describe('session-start orphan battle-state cleanup', { concurrency: false }, () => {
  it('deletes orphan battle-state files when the persisted sessionId mismatches the current session', async (t) => {
    const { battleStatePath, statePath, env } = makeSessionStartEnv(t);

    writeJson(battleStatePath, {
      sessionId: 'old',
      battleState: { phase: 'select_action' },
    });

    await runSessionStart({ ...env, CLAUDE_SESSION_ID: 'new' });
    assert.equal(existsSync(battleStatePath), false);
    const stateAfter = JSON.parse(readFileSync(statePath, 'utf8')) as { battleStats?: { defeats?: number } };
    assert.equal(stateAfter.battleStats?.defeats, 7);
  });

  it('preserves battle-state files when the persisted sessionId matches the current session', async (t) => {
    const { battleStatePath, env } = makeSessionStartEnv(t);

    writeJson(battleStatePath, {
      sessionId: 'same',
      battleState: { phase: 'select_action' },
    });

    await runSessionStart({ ...env, CLAUDE_SESSION_ID: 'same' });
    assert.equal(existsSync(battleStatePath), true);
  });
});
