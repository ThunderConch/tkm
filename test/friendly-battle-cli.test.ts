import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/tokenmon.ts');

type RunResult = {
  output: string;
  status: number | null;
};

type CreatedProfile = {
  profileDir: string;
  cleanup: () => void;
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function createProfile(name: string, language: 'en' | 'ko' = 'en'): CreatedProfile {
  const tempRoot = mkdtempSync(join(tmpdir(), `friendly-battle-cli-${name}-`));
  const configDir = join(tempRoot, '.claude');
  const tokenmonDir = join(configDir, 'tokenmon');
  const genDir = join(tokenmonDir, 'gen4');

  writeJson(join(tokenmonDir, 'global-config.json'), {
    active_generation: 'gen4',
    language,
    voice_tone: 'claude',
    weather_enabled: false,
    weather_location: '',
  });

  writeJson(join(genDir, 'config.json'), {
    party: ['387'],
  });

  writeJson(join(genDir, 'state.json'), {
    pokemon: {
      '387': {
        id: 387,
        xp: 100,
        level: 16,
        friendship: 0,
        ev: 0,
        moves: [33, 45],
      },
    },
  });

  return {
    profileDir: configDir,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function runTokenmon(args: string[], options?: { configDir?: string }): RunResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKENMON_TEST: '1',
      TSX_DISABLE_CACHE: '1',
      ...(options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
    },
  });

  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status,
  };
}

describe('friendly battle product CLI', () => {
  it('shows a product-facing help surface from tokenmon friendly-battle', () => {
    const profile = createProfile('help');
    after(() => profile.cleanup());

    const result = runTokenmon(['friendly-battle'], { configDir: profile.profileDir });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Friendly Battle \(local v1\)/);
    assert.match(result.output, /same network/i);
    assert.match(result.output, /two Claude profiles\/terminals/i);
    assert.match(result.output, /host --session-code <code> \[--listen-host/i);
    assert.match(result.output, /\[--join-host <host>\]/i);
    assert.match(result.output, /join --host <host> --port <port> --session-code <code>/i);
    assert.match(result.output, /ready\s+Explain how ready works/i);
    assert.match(result.output, /leave\s+Explain how to leave/i);
  });

  it('explains that ready is automatic in local v1', () => {
    const profile = createProfile('ready');
    after(() => profile.cleanup());

    const result = runTokenmon(['friendly-battle', 'ready'], { configDir: profile.profileDir });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /READY_STATUS: automatic_in_local_v1/);
    assert.match(result.output, /ready becomes automatic/i);
  });

  it('explains how to leave the current local session', () => {
    const profile = createProfile('leave');
    after(() => profile.cleanup());

    const result = runTokenmon(['friendly-battle', 'leave'], { configDir: profile.profileDir });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /LEAVE_STATUS: stop_the_running_terminal/);
    assert.match(result.output, /Ctrl\+C/i);
  });

  it('adds friendly-battle to the main tokenmon help output', () => {
    const profile = createProfile('tokenmon-help');
    after(() => profile.cleanup());

    const result = runTokenmon(['help'], { configDir: profile.profileDir });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /friendly-battle\s+Friendly battle commands \(local v1\)/i);
  });

  it('forwards product host args into the local runner and preserves numeric validation', () => {
    const hostProfile = createProfile('host');
    after(() => hostProfile.cleanup());

    const result = runTokenmon([
      'friendly-battle',
      'host',
      '--session-code',
      'alpha-local-123',
      '--port',
      '-1',
    ], {
      configDir: hostProfile.profileDir,
    });

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /--port must be >= 0/);
  });

  it('prints a product-facing JOIN_COMMAND that re-enters through tokenmon friendly-battle join', () => {
    const hostProfile = createProfile('host-join-command');
    after(() => hostProfile.cleanup());

    const result = runTokenmon([
      'friendly-battle',
      'host',
      '--session-code',
      'alpha-join-command-123',
      '--timeout-ms',
      '50',
    ], {
      configDir: hostProfile.profileDir,
    });

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /JOIN_COMMAND: .+/);
    assert.match(result.output, /friendly-battle join/);
    assert.match(result.output, /--generation gen4/);
    assert.doesNotMatch(result.output, /friendly-battle-local\.ts join/);
    assert.match(result.output, /FAILED_STAGE: join/);
    assert.match(result.output, /CLEANUP: session_artifacts_removed/);
  });

  it('preserves a guest-facing --join-host through the product host entrypoint', () => {
    const hostProfile = createProfile('host-product-join-host');
    after(() => hostProfile.cleanup());

    const result = runTokenmon([
      'friendly-battle',
      'host',
      '--session-code',
      'alpha-product-join-host-123',
      '--listen-host',
      '0.0.0.0',
      '--join-host',
      '192.168.0.24',
      '--timeout-ms',
      '50',
    ], {
      configDir: hostProfile.profileDir,
    });

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /JOIN_COMMAND: .+friendly-battle join --host 192\.168\.0\.24 /);
    assert.match(result.output, /JOIN_INFO: .+"host":"192\.168\.0\.24"/);
    assert.match(result.output, /JOIN_INFO: .+"listenHost":"0\.0\.0\.0"/);
    assert.match(result.output, /FAILED_STAGE: join/);
    assert.match(result.output, /CLEANUP: session_artifacts_removed/);
  });
});
