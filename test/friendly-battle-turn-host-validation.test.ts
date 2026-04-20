// test/friendly-battle-turn-host-validation.test.ts
//
// Regression coverage for PR #56:
//   1. --listen-host / --join-host / --host all run through validateHostArg,
//      not just --join-host (reviewer-flagged).
//   2. Wildcard --listen-host + --join-host writes the advertise host into
//      the on-disk session record (not the wildcard).
//   3. The CLI can be invoked from a cwd outside the plugin root without
//      tripping Node's cwd-relative `--import tsx` resolution (i.e. the
//      daemon still reaches DAEMON_READY, so `PORT:` appears on stderr).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
// Use the shell wrapper so tsx is resolved via absolute paths (the same
// entry point the skill invokes). This mirrors real-world invocation and
// lets the cwd-outside-plugin test exercise the actual code path that the
// bug report.md hit.
const LAUNCHER = resolve(REPO_ROOT, 'bin/run-friendly-battle-turn.sh');
const GENERATION = 'gen4';

function makeClaudeConfigDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tkm-fb-turn-host-val-${tag}-`));
  const genDir = join(dir, 'tokenmon', GENERATION);
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(dir, 'tokenmon', 'global-config.json'),
    JSON.stringify({ active_generation: GENERATION, language: 'en', voice_tone: 'claude' }),
    'utf8',
  );
  writeFileSync(
    join(genDir, 'config.json'),
    JSON.stringify({ party: ['387'], starter_chosen: true }),
    'utf8',
  );
  writeFileSync(
    join(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': { id: 387, xp: 100, level: 16, friendship: 0, ev: 0, moves: [33, 45] },
      },
    }),
    'utf8',
  );
  return dir;
}

function runCli(
  args: string[],
  options: { configDir: string; cwd?: string; timeoutMs?: number },
) {
  return spawnSync(LAUNCHER, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 8000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_CONFIG_DIR: options.configDir,
      TSX_DISABLE_CACHE: '1',
    },
  });
}

function readLatestSessionRecord(configDir: string): Record<string, unknown> {
  const sessionsDir = join(configDir, 'tokenmon', GENERATION, 'friendly-battle', 'sessions');
  const entries = readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
  assert.ok(entries.length > 0, `expected at least one session record in ${sessionsDir}`);
  // Deterministic pick: most recently written file.
  const sorted = entries
    .map((name) => ({ name, path: join(sessionsDir, name) }))
    .sort((a, b) => readFileSync(b.path, 'utf8').localeCompare(readFileSync(a.path, 'utf8')));
  return JSON.parse(readFileSync(sorted[0].path, 'utf8'));
}

describe('friendly-battle-turn — host-arg validation is uniform across flags', () => {
  const badHost = '";rm -rf /"';

  it('rejects a malformed --listen-host with a clean REASON line', () => {
    const profile = makeClaudeConfigDir('bad-listen');
    after(() => rmSync(profile, { recursive: true, force: true }));

    const result = runCli(
      [
        '--init-host',
        '--session-code', 'alpha-listen-valid',
        '--generation', GENERATION,
        '--listen-host', badHost,
        '--port', '0',
        '--timeout-ms', '200',
        '--player-name', 'Host',
      ],
      { configDir: profile },
    );

    assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /REASON: --listen-host must match/);
  });

  it('rejects a malformed --join-host with a clean REASON line', () => {
    const profile = makeClaudeConfigDir('bad-join');
    after(() => rmSync(profile, { recursive: true, force: true }));

    const result = runCli(
      [
        '--init-host',
        '--session-code', 'alpha-join-valid',
        '--generation', GENERATION,
        '--listen-host', '127.0.0.1',
        '--join-host', badHost,
        '--port', '0',
        '--timeout-ms', '200',
        '--player-name', 'Host',
      ],
      { configDir: profile },
    );

    assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /REASON: --join-host must match/);
  });

  it('rejects a malformed --host on the join path with a clean REASON line', () => {
    const profile = makeClaudeConfigDir('bad-host');
    after(() => rmSync(profile, { recursive: true, force: true }));

    const result = runCli(
      [
        '--init-join',
        '--session-code', 'alpha-host-valid',
        '--generation', GENERATION,
        '--host', badHost,
        '--port', '12345',
        '--timeout-ms', '200',
        '--player-name', 'Guest',
      ],
      { configDir: profile },
    );

    assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /REASON: --host must match/);
  });
});

describe('friendly-battle-turn — wildcard listen + advertise host', () => {
  it('records the advertised host in the session transport, not the wildcard', () => {
    const profile = makeClaudeConfigDir('advertise');
    after(() => rmSync(profile, { recursive: true, force: true }));

    // Short timeout so the daemon aborts on guest-join wait — we only need
    // the session record to be written once init-host finishes its setup.
    const advertise = '10.77.77.1';
    const result = runCli(
      [
        '--init-host',
        '--session-code', 'alpha-advertise-123',
        '--generation', GENERATION,
        '--listen-host', '0.0.0.0',
        '--join-host', advertise,
        '--port', '0',
        '--timeout-ms', '150',
        '--player-name', 'Host',
      ],
      { configDir: profile },
    );

    // init-host emits the PORT: line once the daemon binds, then writes the
    // session record. Even if the guest-join wait later times out, the
    // record is on disk and the transport host must be the advertise host.
    assert.match(result.stderr, /PORT: \d+/, `stderr=${result.stderr}`);
    const record = readLatestSessionRecord(profile);
    const transport = record.transport as { host: string; port: number };
    assert.equal(transport.host, advertise, `record=${JSON.stringify(record)}`);
    assert.notEqual(transport.host, '0.0.0.0');
    assert.ok(typeof transport.port === 'number' && transport.port > 0, 'port should be bound');
  });
});

describe('friendly-battle-turn — cwd outside the plugin root', () => {
  it('spawns the daemon successfully (tsx resolves via PLUGIN_ROOT cwd)', () => {
    const profile = makeClaudeConfigDir('cwd-outside');
    const foreignCwd = mkdtempSync(join(tmpdir(), 'tkm-fb-foreign-cwd-'));
    after(() => {
      rmSync(profile, { recursive: true, force: true });
      rmSync(foreignCwd, { recursive: true, force: true });
    });

    const result = runCli(
      [
        '--init-host',
        '--session-code', 'alpha-cwd-outside-123',
        '--generation', GENERATION,
        '--listen-host', '127.0.0.1',
        '--port', '0',
        '--timeout-ms', '150',
        '--player-name', 'Host',
      ],
      { configDir: profile, cwd: foreignCwd },
    );

    // The key assertion: the daemon child must NOT have died with
    // `Cannot find package 'tsx'` because its cwd is now pinned to
    // PLUGIN_ROOT. The daemon reaching DAEMON_READY means the CLI
    // emits a PORT: line on stderr before the guest-join timeout.
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(combined, /Cannot find package 'tsx'/, combined);
    assert.doesNotMatch(combined, /ERR_MODULE_NOT_FOUND/, combined);
    assert.match(result.stderr, /PORT: \d+/, combined);
  });
});
