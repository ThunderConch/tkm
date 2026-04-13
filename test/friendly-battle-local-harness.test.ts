import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  attachFriendlyBattleGuestSnapshot,
  cleanupFriendlyBattleLocalArtifacts,
  createFriendlyBattleLocalArtifacts,
  loadFriendlyBattleProfileFromConfigDir,
  markFriendlyBattleReady,
  resolveFriendlyBattleLocalBattleToCompletion,
  startFriendlyBattleLocalBattle,
} from '../src/friendly-battle/local-harness.js';
import { buildFriendlyBattlePartySnapshot } from '../src/friendly-battle/snapshot.js';
import { spawnPrintedCommand } from './helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-local.ts');

type SpawnedCli = {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
  completion: Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>;
};

type CreatedProfile = {
  profileDir: string;
  cleanup: () => void;
};

function spawnCli(args: string[], options?: { configDir?: string }): SpawnedCli {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TOKENMON_TEST: '1',
      TSX_DISABLE_CACHE: '1',
      ...(options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output.stderr += chunk;
  });

  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion);
    child.once('close', (exitCode, signal) => {
      resolveCompletion({ stdout: output.stdout, stderr: output.stderr, exitCode, signal });
    });
  });

  return { child, output, completion };
}

async function waitForStdout(spawned: SpawnedCli, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(spawned.output.stdout)) {
      return spawned.output.stdout;
    }

    const completed = await Promise.race([
      spawned.completion.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 25)),
    ]);

    if (completed && pattern.test(spawned.output.stdout)) {
      return spawned.output.stdout;
    }

    if (completed) {
      break;
    }
  }

  throw new Error(`Timed out waiting for stdout pattern ${pattern}; stdout=${spawned.output.stdout}; stderr=${spawned.output.stderr}`);
}

async function terminate(spawned: SpawnedCli): Promise<void> {
  if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
    return;
  }

  spawned.child.kill('SIGTERM');
  await Promise.race([
    spawned.completion,
    new Promise<void>((resolveTimeout) => setTimeout(() => resolveTimeout(), 500)),
  ]);

  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    spawned.child.kill('SIGKILL');
    await spawned.completion.catch(() => undefined);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function createProfile(name: string, pokemonKey: string, speciesId: number, level: number): CreatedProfile {
  const tempRoot = mkdtempSync(join(tmpdir(), `friendly-battle-local-${name}-`));
  const configDir = join(tempRoot, '.claude');
  const tokenmonDir = join(configDir, 'tokenmon');
  const genDir = join(tokenmonDir, 'gen4');

  writeJson(join(tokenmonDir, 'global-config.json'), {
    active_generation: 'gen4',
    language: 'en',
    voice_tone: 'claude',
    weather_enabled: false,
    weather_location: '',
  });

  writeJson(join(genDir, 'config.json'), {
    party: [pokemonKey],
  });

  writeJson(join(genDir, 'state.json'), {
    pokemon: {
      [pokemonKey]: {
        id: speciesId,
        xp: 100,
        level,
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

describe('friendly battle local harness CLI', { concurrency: false }, () => {
  it('uses persisted snapshots as the local battle source of truth', () => {
    const hostProfileFixture = createProfile('host-authority', '387', 387, 16);
    const guestProfileFixture = createProfile('guest-authority', '390', 390, 18);
    after(() => hostProfileFixture.cleanup());
    after(() => guestProfileFixture.cleanup());

    const hostProfile = loadFriendlyBattleProfileFromConfigDir(hostProfileFixture.profileDir, 'gen4');
    const guestProfile = loadFriendlyBattleProfileFromConfigDir(guestProfileFixture.profileDir, 'gen4');
    const artifacts = createFriendlyBattleLocalArtifacts({
      hostProfile,
      sessionCode: 'authority-check-123',
      hostPlayerName: 'Host',
      guestPlayerName: 'Guest',
    });

    try {
      const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);
      attachFriendlyBattleGuestSnapshot(artifacts, {
        guestPlayerName: 'Guest',
        guestSnapshot,
      });

      hostProfile.state.pokemon['387'].level = 60;
      guestProfile.state.pokemon['390'].level = 1;

      const { runtime } = startFriendlyBattleLocalBattle(artifacts);

      assert.equal(runtime.state.player.pokemon[0]?.level, 16);
      assert.equal(runtime.state.opponent.pokemon[0]?.level, 18);
    } finally {
      cleanupFriendlyBattleLocalArtifacts(artifacts);
    }
  });

  it('drives a local battle to a completed authoritative result', async () => {
    const hostProfileFixture = createProfile('host-completed-battle', '387', 387, 60);
    const guestProfileFixture = createProfile('guest-completed-battle', '390', 390, 1);
    after(() => hostProfileFixture.cleanup());
    after(() => guestProfileFixture.cleanup());

    const hostProfile = loadFriendlyBattleProfileFromConfigDir(hostProfileFixture.profileDir, 'gen4');
    const guestProfile = loadFriendlyBattleProfileFromConfigDir(guestProfileFixture.profileDir, 'gen4');
    const artifacts = createFriendlyBattleLocalArtifacts({
      hostProfile,
      sessionCode: 'completed-battle-123',
      hostPlayerName: 'Host',
      guestPlayerName: 'Guest',
    });

    try {
      attachFriendlyBattleGuestSnapshot(artifacts, {
        guestPlayerName: 'Guest',
        guestSnapshot: buildFriendlyBattlePartySnapshot(guestProfile),
      });
      markFriendlyBattleReady(artifacts, { hostReady: true, guestReady: true, canStart: true });

      const { runtime } = startFriendlyBattleLocalBattle(artifacts);
      const events = await resolveFriendlyBattleLocalBattleToCompletion({
        artifacts,
        runtime,
        chooseHostAction: () => 'move:0',
        chooseGuestAction: () => 'move:0',
      });

      assert.equal(runtime.phase, 'completed');
      assert.equal(artifacts.session.phase, 'completed');
      assert.deepEqual(events.at(-1), {
        type: 'battle_finished',
        winner: 'host',
        reason: 'completed',
      });

      const persistedBattle = JSON.parse(readFileSync(artifacts.battlePath, 'utf8')) as {
        battle: { phase: string; endedAt: string | null };
        events: Array<{ type: string; winner?: string | null; reason?: string }>;
      };
      assert.equal(persistedBattle.battle.phase, 'completed');
      assert.ok(persistedBattle.battle.endedAt);
      assert.ok(
        persistedBattle.events.some(
          (event) =>
            event.type === 'battle_finished'
            && event.winner === 'host'
            && event.reason === 'completed',
        ),
      );
    } finally {
      cleanupFriendlyBattleLocalArtifacts(artifacts);
    }
  });

  it('rejects invalid numeric host arguments at the CLI boundary', async () => {
    const hostProfile = createProfile('host-invalid-args', '387', 387, 16);
    after(() => hostProfile.cleanup());

    const invalidPort = spawnCli([
      'host',
      '--session-code',
      'invalid-port-123',
      '--port',
      '-1',
    ], {
      configDir: hostProfile.profileDir,
    });

    const portResult = await invalidPort.completion;
    assert.equal(portResult.exitCode, 1);
    assert.match(portResult.stderr, /--port must be >= 0/);

    const invalidTimeout = spawnCli([
      'host',
      '--session-code',
      'invalid-timeout-123',
      '--timeout-ms',
      '1.5',
    ], {
      configDir: hostProfile.profileDir,
    });

    const timeoutResult = await invalidTimeout.completion;
    assert.equal(timeoutResult.exitCode, 1);
    assert.match(timeoutResult.stderr, /Invalid integer for --timeout-ms/);
  });

  it('replays a same-machine two terminal battle smoke and cleans up persisted session artifacts', async () => {
    // Like the spike CLI smoke, this boots two `node --import tsx` terminals.
    // Full-suite contention can make startup dramatically slower than the happy
    // path, so keep the smoke generous enough to avoid false negatives.
    const battleExchangeTimeoutMs = 60_000;
    const hostStartupTimeoutMs = 60_000;
    const hostProfile = createProfile('host', '387', 387, 16);
    const guestProfile = createProfile('guest', '390', 390, 18);
    after(() => hostProfile.cleanup());
    after(() => guestProfile.cleanup());

    const host = spawnCli([
      'host',
      '--session-code',
      'alpha-local-123',
      '--timeout-ms',
      String(battleExchangeTimeoutMs),
    ], {
      configDir: hostProfile.profileDir,
    });
    after(async () => terminate(host));

    const hostStdout = await waitForStdout(host, /^JOIN_COMMAND: .+$/m, hostStartupTimeoutMs);
    const joinCommand = hostStdout.match(/^JOIN_COMMAND: (.+)$/m)?.[1];
    assert.ok(joinCommand, `expected JOIN_COMMAND line in host stdout:\n${hostStdout}`);

    const guest = spawnPrintedCommand(joinCommand, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TOKENMON_TEST: '1',
        TSX_DISABLE_CACHE: '1',
        CLAUDE_CONFIG_DIR: guestProfile.profileDir,
      },
    });

    let guestStdout = '';
    let guestStderr = '';
    guest.stdout.setEncoding('utf8');
    guest.stderr.setEncoding('utf8');
    guest.stdout.on('data', (chunk: string) => {
      guestStdout += chunk;
    });
    guest.stderr.on('data', (chunk: string) => {
      guestStderr += chunk;
    });

    const [hostResult, guestResult] = await Promise.all([
      host.completion,
      new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveGuest, rejectGuest) => {
        guest.once('error', rejectGuest);
        guest.once('close', (exitCode, signal) => resolveGuest({ exitCode, signal }));
      }),
    ]);

    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 0, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.equal(guestResult.signal, null, `guest stderr:\n${guestStderr}`);
    assert.equal(guestResult.exitCode, 0, `guest stdout:\n${guestStdout}\n--- stderr ---\n${guestStderr}`);

    assert.match(hostResult.stdout, /STAGE: guest_joined/);
    assert.match(hostResult.stdout, /STAGE: ready/);
    assert.match(hostResult.stdout, /STAGE: battle_started/);
    assert.match(hostResult.stdout, /SUCCESS: first_turn_smoke_completed/);
    assert.match(hostResult.stdout, /CLEANUP: session_artifacts_removed/);

    assert.match(guestStdout, /STAGE: connected/);
    assert.match(guestStdout, /STAGE: ready/);
    assert.match(guestStdout, /STAGE: battle_started/);
    assert.match(guestStdout, /SUCCESS: first_turn_smoke_completed/);

    const sessionPath = hostResult.stdout.match(/^SESSION_PATH: (.+)$/m)?.[1];
    const hostSnapshotPath = hostResult.stdout.match(/^HOST_SNAPSHOT_PATH: (.+)$/m)?.[1];
    const guestSnapshotPath = hostResult.stdout.match(/^GUEST_SNAPSHOT_PATH: (.+)$/m)?.[1];
    const battlePath = hostResult.stdout.match(/^BATTLE_PATH: (.+)$/m)?.[1];

    assert.ok(sessionPath, `expected SESSION_PATH in host stdout:\n${hostResult.stdout}`);
    assert.ok(hostSnapshotPath, `expected HOST_SNAPSHOT_PATH in host stdout:\n${hostResult.stdout}`);
    assert.ok(guestSnapshotPath, `expected GUEST_SNAPSHOT_PATH in host stdout:\n${hostResult.stdout}`);
    assert.ok(battlePath, `expected BATTLE_PATH in host stdout:\n${hostResult.stdout}`);

    assert.equal(existsSync(sessionPath!), false, `expected cleaned session path ${sessionPath}`);
    assert.equal(existsSync(hostSnapshotPath!), false, `expected cleaned host snapshot path ${hostSnapshotPath}`);
    assert.equal(existsSync(guestSnapshotPath!), false, `expected cleaned guest snapshot path ${guestSnapshotPath}`);
    assert.equal(existsSync(battlePath!), false, `expected cleaned battle path ${battlePath}`);
  });

  it('prints a guest-facing JOIN_COMMAND from --join-host even when the host listens on 0.0.0.0', async () => {
    const hostProfile = createProfile('host-join-host', '387', 387, 16);
    after(() => hostProfile.cleanup());

    const host = spawnCli([
      'host',
      '--session-code',
      'join-host-local-123',
      '--timeout-ms',
      '50',
      '--listen-host',
      '0.0.0.0',
      '--join-host',
      '192.168.0.24',
    ], {
      configDir: hostProfile.profileDir,
    });

    const hostResult = await host.completion;
    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 1, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.match(hostResult.stderr, /FAILED_STAGE: join/);
    assert.match(hostResult.stdout, /JOIN_COMMAND: .+--host 192\.168\.0\.24 /);

    const joinInfoJson = hostResult.stdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
    assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostResult.stdout}`);
    const joinInfo = JSON.parse(joinInfoJson) as { host: string; listenHost: string; port: number };
    assert.equal(joinInfo.host, '192.168.0.24');
    assert.equal(joinInfo.listenHost, '0.0.0.0');
    assert.ok(typeof joinInfo.port === 'number' && joinInfo.port > 0);
  });

  it('requires --join-host when the host listens on a wildcard address', async () => {
    const hostProfile = createProfile('host-wildcard-missing-join', '387', 387, 16);
    after(() => hostProfile.cleanup());

    const host = spawnCli([
      'host',
      '--session-code',
      'wildcard-host-123',
      '--timeout-ms',
      '50',
      '--listen-host',
      '0.0.0.0',
    ], {
      configDir: hostProfile.profileDir,
    });

    const hostResult = await host.completion;
    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 1, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.match(hostResult.stderr, /FAILED_STAGE: listen/);
    assert.match(hostResult.stderr, /--join-host/i);
    assert.match(hostResult.stderr, /0\.0\.0\.0/i);
    assert.match(hostResult.stdout, /CLEANUP: session_artifacts_removed/);
  });

  it('rejects wildcard --join-host values before printing an unusable guest command', async () => {
    const hostProfile = createProfile('host-wildcard-invalid-join', '387', 387, 16);
    after(() => hostProfile.cleanup());

    const host = spawnCli([
      'host',
      '--session-code',
      'wildcard-invalid-join-123',
      '--timeout-ms',
      '50',
      '--listen-host',
      '0.0.0.0',
      '--join-host',
      '0.0.0.0',
    ], {
      configDir: hostProfile.profileDir,
    });

    const hostResult = await host.completion;
    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 1, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);
    assert.match(hostResult.stderr, /FAILED_STAGE: listen/);
    assert.match(hostResult.stderr, /--join-host/i);
    assert.match(hostResult.stderr, /wildcard/i);
    assert.match(hostResult.stdout, /CLEANUP: session_artifacts_removed/);
    assert.doesNotMatch(hostResult.stdout, /JOIN_COMMAND:/);
  });

  it('cleans up persisted session artifacts after a failed host handshake', async () => {
    const hostProfile = createProfile('host-timeout', '387', 387, 16);
    after(() => hostProfile.cleanup());

    const host = spawnCli([
      'host',
      '--session-code',
      'timeout-local-123',
      '--timeout-ms',
      '50',
    ], {
      configDir: hostProfile.profileDir,
    });

    const hostResult = await host.completion;
    assert.equal(hostResult.signal, null, `host stderr:\n${hostResult.stderr}`);
    assert.equal(hostResult.exitCode, 1, `host stdout:\n${hostResult.stdout}\n--- stderr ---\n${hostResult.stderr}`);

    assert.match(hostResult.stderr, /FAILED_STAGE: join/);
    assert.match(hostResult.stdout, /CLEANUP: session_artifacts_removed/);

    const sessionPath = hostResult.stdout.match(/^SESSION_PATH: (.+)$/m)?.[1];
    const hostSnapshotPath = hostResult.stdout.match(/^HOST_SNAPSHOT_PATH: (.+)$/m)?.[1];
    const guestSnapshotPath = hostResult.stdout.match(/^GUEST_SNAPSHOT_PATH: (.+)$/m)?.[1];
    const battlePath = hostResult.stdout.match(/^BATTLE_PATH: (.+)$/m)?.[1];

    assert.ok(sessionPath, `expected SESSION_PATH in host stdout:\n${hostResult.stdout}`);
    assert.ok(hostSnapshotPath, `expected HOST_SNAPSHOT_PATH in host stdout:\n${hostResult.stdout}`);
    assert.ok(battlePath, `expected BATTLE_PATH in host stdout:\n${hostResult.stdout}`);

    assert.equal(existsSync(sessionPath!), false, `expected cleaned session path ${sessionPath}`);
    assert.equal(existsSync(hostSnapshotPath!), false, `expected cleaned host snapshot path ${hostSnapshotPath}`);
    assert.equal(guestSnapshotPath, undefined);
    assert.equal(existsSync(battlePath!), false, `expected cleaned battle path ${battlePath}`);
  });
});
