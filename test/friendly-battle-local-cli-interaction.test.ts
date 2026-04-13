import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const LOCAL_CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-local.ts');

type SpawnedCli = {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
  completion: Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>;
};

type CreatedProfile = {
  profileDir: string;
  cleanup: () => void;
};

type ProfilePokemon = {
  pokemonKey: string;
  speciesId: number;
  level: number;
};

function spawnLocalCli(args: string[], options?: { configDir?: string; env?: NodeJS.ProcessEnv }): SpawnedCli {
  const child = spawn(process.execPath, ['--import', 'tsx', LOCAL_CLI, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TOKENMON_TEST: '1',
      TSX_DISABLE_CACHE: '1',
      ...(options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
      ...(options?.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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

    if (completed) break;
  }

  throw new Error(`Timed out waiting for stdout pattern ${pattern}; stdout=${spawned.output.stdout}; stderr=${spawned.output.stderr}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function createProfileWithParty(name: string, pokemon: ProfilePokemon[]): CreatedProfile {
  const tempRoot = mkdtempSync(join(tmpdir(), `friendly-battle-local-cli-${name}-`));
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
    party: pokemon.map((member) => member.pokemonKey),
  });

  writeJson(join(genDir, 'state.json'), {
    pokemon: Object.fromEntries(
      pokemon.map((member) => [
        member.pokemonKey,
        {
          id: member.speciesId,
          xp: 100,
          level: member.level,
          friendship: 0,
          ev: 0,
          moves: [33, 45],
        },
      ]),
    ),
  });

  return {
    profileDir: configDir,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function createProfile(name: string, pokemonKey: string, speciesId: number, level: number): CreatedProfile {
  return createProfileWithParty(name, [{ pokemonKey, speciesId, level }]);
}

async function spawnHostAndGuest(options: {
  sessionCode: string;
  hostProfile: CreatedProfile;
  guestProfile: CreatedProfile;
  timeoutMs?: number;
  hostEnv?: NodeJS.ProcessEnv;
  guestEnv?: NodeJS.ProcessEnv;
}): Promise<{ host: SpawnedCli; guest: SpawnedCli }> {
  const host = spawnLocalCli([
    'host',
    '--session-code',
    options.sessionCode,
    '--timeout-ms',
    String(options.timeoutMs ?? 15_000),
  ], {
    configDir: options.hostProfile.profileDir,
    env: options.hostEnv,
  });
  after(async () => terminate(host));

  const hostStdout = await waitForStdout(host, /^JOIN_COMMAND: .+$/m, 60_000);
  const joinInfoJson = hostStdout.match(/^JOIN_INFO: (.+)$/m)?.[1];
  assert.ok(joinInfoJson, `expected JOIN_INFO line in host stdout:\n${hostStdout}`);
  const joinInfo = JSON.parse(joinInfoJson) as { host: string; port: number };

  const guest = spawnLocalCli([
    'join',
    '--host',
    joinInfo.host,
    '--port',
    String(joinInfo.port),
    '--session-code',
    options.sessionCode,
    '--timeout-ms',
    String(options.timeoutMs ?? 15_000),
    '--generation',
    'gen4',
    '--player-name',
    'Guest',
  ], {
    configDir: options.guestProfile.profileDir,
    env: options.guestEnv,
  });
  after(async () => terminate(guest));

  return { host, guest };
}

describe('friendly battle local CLI interaction', { concurrency: false }, () => {
  it('waits for repeated move input instead of auto-submitting choices in the same-machine CLI flow', async () => {
    const hostProfile = createProfile('host-repeated-input', '387', 387, 16);
    const guestProfile = createProfile('guest-repeated-input', '390', 390, 16);
    after(() => hostProfile.cleanup());
    after(() => guestProfile.cleanup());

    const { host, guest } = await spawnHostAndGuest({
      sessionCode: 'repeated-input-123',
      hostProfile,
      guestProfile,
    });

    await waitForStdout(host, /STAGE: battle_started/, 60_000);
    await waitForStdout(guest, /STAGE: battle_started/, 60_000);
    await sleep(400);

    assert.equal(host.child.exitCode, null, `host should still be waiting for input:\n${host.output.stdout}\n--- stderr ---\n${host.output.stderr}`);
    assert.equal(guest.child.exitCode, null, `guest should still be waiting for input:\n${guest.output.stdout}\n--- stderr ---\n${guest.output.stderr}`);
    assert.doesNotMatch(host.output.stdout, /HOST_CHOICE:/, `host auto-submitted a choice instead of prompting:\n${host.output.stdout}`);
    assert.doesNotMatch(guest.output.stdout, /GUEST_CHOICE:/, `guest auto-submitted a choice instead of prompting:\n${guest.output.stdout}`);
    assert.doesNotMatch(host.output.stdout, /SUCCESS: battle_completed/, `battle completed before any stdin input:\n${host.output.stdout}`);
  });

  it('waits for a forced replacement choice instead of auto-surrendering after a faint', async () => {
    const hostProfile = createProfile('host-forced-switch', '387', 387, 60);
    const guestProfile = createProfileWithParty('guest-forced-switch', [
      { pokemonKey: '390', speciesId: 390, level: 1 },
      { pokemonKey: '387', speciesId: 387, level: 18 },
    ]);
    after(() => hostProfile.cleanup());
    after(() => guestProfile.cleanup());

    const { guest } = await spawnHostAndGuest({
      sessionCode: 'forced-switch-123',
      hostProfile,
      guestProfile,
    });

    await waitForStdout(guest, /EVENT_RECEIVED: choices_requested/, 60_000);
    await sleep(1200);

    assert.equal(guest.child.exitCode, null, `guest should still be waiting to choose a replacement:\n${guest.output.stdout}\n--- stderr ---\n${guest.output.stderr}`);
    assert.doesNotMatch(guest.output.stdout, /GUEST_CHOICE: surrender/, `guest auto-surrendered instead of waiting for a replacement choice:\n${guest.output.stdout}`);
  });

  it('accepts an explicit surrender command from stdin instead of ignoring it', async () => {
    const hostProfile = createProfileWithParty('host-surrender-input', [
      { pokemonKey: '387', speciesId: 387, level: 16 },
      { pokemonKey: '390', speciesId: 390, level: 16 },
    ]);
    const guestProfile = createProfileWithParty('guest-surrender-input', [
      { pokemonKey: '390', speciesId: 390, level: 16 },
      { pokemonKey: '387', speciesId: 387, level: 16 },
    ]);
    after(() => hostProfile.cleanup());
    after(() => guestProfile.cleanup());

    const { host, guest } = await spawnHostAndGuest({
      sessionCode: 'stdin-surrender-123',
      hostProfile,
      guestProfile,
    });

    await waitForStdout(guest, /EVENT_RECEIVED: choices_requested/, 60_000);
    guest.child.stdin.write('surrender\n');
    await waitForStdout(guest, /GUEST_CHOICE: surrender/, 60_000);

    assert.doesNotMatch(guest.output.stdout, /GUEST_CHOICE: move:0/, `guest auto-submitted a move before honoring stdin surrender:\n${guest.output.stdout}\n--- stderr ---\n${guest.output.stderr}`);
    assert.match(guest.output.stdout, /GUEST_CHOICE: surrender/, `guest never submitted surrender after stdin input:\n${guest.output.stdout}\n--- stderr ---\n${guest.output.stderr}`);
    assert.doesNotMatch(host.output.stdout, /HOST_CHOICE:/, `host should still have been waiting while surrender was chosen explicitly:\n${host.output.stdout}\n--- stderr ---\n${host.output.stderr}`);
  });

  it('keeps prompting when force and auto env flags are both set, so force wins over auto', async () => {
    const hostProfile = createProfile('host-force-over-auto', '387', 387, 16);
    const guestProfile = createProfile('guest-force-over-auto', '390', 390, 16);
    after(() => hostProfile.cleanup());
    after(() => guestProfile.cleanup());

    const { host, guest } = await spawnHostAndGuest({
      sessionCode: 'force-over-auto-123',
      hostProfile,
      guestProfile,
      hostEnv: {
        TOKENMON_FORCE_PROMPTS: '1',
        TOKENMON_AUTO_CHOICES: '1',
      },
      guestEnv: {
        TOKENMON_FORCE_PROMPTS: '1',
        TOKENMON_AUTO_CHOICES: '1',
      },
    });

    await waitForStdout(host, /HOST_PROMPT: turn 1 .*move:0.*surrender/m, 60_000);
    await waitForStdout(guest, /GUEST_PROMPT: turn 1 .*move:0.*surrender/m, 60_000);
    await sleep(400);

    assert.equal(host.child.exitCode, null, `host should still be waiting for prompt input when force wins over auto:\n${host.output.stdout}\n--- stderr ---\n${host.output.stderr}`);
    assert.equal(guest.child.exitCode, null, `guest should still be waiting for prompt input when force wins over auto:\n${guest.output.stdout}\n--- stderr ---\n${guest.output.stderr}`);
    assert.doesNotMatch(host.output.stdout, /HOST_CHOICE:/, `host auto-submitted despite TOKENMON_FORCE_PROMPTS taking precedence:\n${host.output.stdout}`);
    assert.doesNotMatch(guest.output.stdout, /GUEST_CHOICE:/, `guest auto-submitted despite TOKENMON_FORCE_PROMPTS taking precedence:\n${guest.output.stdout}`);
  });
});
