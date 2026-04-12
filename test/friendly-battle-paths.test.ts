import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), `tokenmon-friendly-battle-paths-${Date.now()}`);
const TEST_DATA_DIR = join(TEST_DIR, 'tokenmon');
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_CLAUDE_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

process.env.HOME = TEST_DIR;
process.env.CLAUDE_CONFIG_DIR = TEST_DIR;
process.env.CLAUDE_PLUGIN_ROOT = join(TEST_DIR, '.claude', 'plugins', 'cache', 'tokenmon');

mkdirSync(TEST_DATA_DIR, { recursive: true });

const { BATTLE_STATE_PATH } = await import('../src/core/battle-state-io.js');
const { clearActiveGenerationCache, genUserDir, sessionPath, setActiveGenerationCache } = await import(
  '../src/core/paths.js'
);
const {
  friendlyBattleBattlePath,
  friendlyBattleBattlesDir,
  friendlyBattleRootDir,
  friendlyBattleSessionPath,
  friendlyBattleSessionsDir,
  friendlyBattleSnapshotPath,
  friendlyBattleSnapshotsDir,
} = await import('../src/friendly-battle/paths.js');

setActiveGenerationCache('gen4');

after(() => {
  clearActiveGenerationCache();

  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }

  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  }

  if (ORIGINAL_CLAUDE_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_CLAUDE_PLUGIN_ROOT;
  }

  rmSync(TEST_DIR, { recursive: true, force: true });
});

test('friendly battle storage stays under a separate namespace within the generation directory', () => {
  assert.equal(friendlyBattleRootDir('gen4'), join(genUserDir('gen4'), 'friendly-battle'));
  assert.equal(friendlyBattleSessionsDir('gen4'), join(genUserDir('gen4'), 'friendly-battle', 'sessions'));
  assert.equal(friendlyBattleSnapshotsDir('gen4'), join(genUserDir('gen4'), 'friendly-battle', 'snapshots'));
  assert.equal(friendlyBattleBattlesDir('gen4'), join(genUserDir('gen4'), 'friendly-battle', 'battles'));
});

test('friendly battle paths do not collide with legacy session or singleton battle-state storage', () => {
  const sessionFile = friendlyBattleSessionPath('sess-123', 'gen4');
  const snapshotFile = friendlyBattleSnapshotPath('snap-123', 'gen4');
  const battleFile = friendlyBattleBattlePath('battle-123', 'gen4');

  assert.equal(sessionFile, join(genUserDir('gen4'), 'friendly-battle', 'sessions', 'sess-123.json'));
  assert.equal(snapshotFile, join(genUserDir('gen4'), 'friendly-battle', 'snapshots', 'snap-123.json'));
  assert.equal(battleFile, join(genUserDir('gen4'), 'friendly-battle', 'battles', 'battle-123.json'));

  assert.notEqual(sessionFile, sessionPath('gen4', 'sess-123'));
  assert.notEqual(sessionFile, sessionPath('gen4'));
  assert.notEqual(snapshotFile, BATTLE_STATE_PATH);
  assert.notEqual(battleFile, BATTLE_STATE_PATH);
});
