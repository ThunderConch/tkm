import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION,
  type FriendlyBattlePartySnapshot,
} from '../src/friendly-battle/contracts.js';
import {
  assertValidFriendlyBattlePartySnapshot,
  buildFriendlyBattlePartySnapshot,
  buildFriendlyBattleProgressionRef,
  buildFriendlyBattleProgressionRefFromSnapshot,
  createBattleTeamFromFriendlyBattleSnapshot,
  toFriendlyBattleSnapshotRef,
  validateFriendlyBattlePartySnapshot,
} from '../src/friendly-battle/snapshot.js';
import { makeConfig, makeState } from './helpers.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('friendly battle snapshot', () => {
  it('builds a read-only battle snapshot from current party order', () => {
    const config = makeConfig({
      party: ['387', '390_shiny'],
    });
    const state = makeState({
      pokemon: {
        '387': {
          id: 387,
          xp: 100,
          level: 16,
          friendship: 0,
          ev: 0,
          moves: [33, 45],
        },
        '390_shiny': {
          id: 390,
          xp: 200,
          level: 18,
          friendship: 0,
          ev: 0,
          shiny: true,
          nickname: '몽키',
          moves: [33, 45, 65, 55],
        },
      },
    });

    const progression = buildFriendlyBattleProgressionRef({
      config,
      state,
      generation: 'gen4',
    });
    assert.deepEqual(progression, {
      layer: 'progression',
      generation: 'gen4',
      partySource: 'current_party',
      partyPokemonIds: ['387', '390_shiny'],
    });

    const snapshot = buildFriendlyBattlePartySnapshot({
      config,
      state,
      generation: 'gen4',
      pluginRoot,
      snapshotId: 'snapshot-001',
      createdAt: '2026-04-12T12:34:56.000Z',
    });

    assert.equal(snapshot.layer, 'snapshot');
    assert.equal(snapshot.schemaVersion, FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(snapshot.snapshotId, 'snapshot-001');
    assert.equal(snapshot.partySize, 2);
    assert.equal(snapshot.pokemon[0].progressionKey, '387');
    assert.equal(snapshot.pokemon[1].progressionKey, '390_shiny');
    assert.equal(snapshot.pokemon[0].displayName, snapshot.pokemon[0].speciesDisplayName);
    assert.equal(snapshot.pokemon[1].nickname, '몽키');
    assert.equal(snapshot.pokemon[1].displayName, '몽키');
    assert.equal(snapshot.pokemon[1].shiny, true);
    assert.ok(snapshot.pokemon[0].moves.length > 0);

    const ref = toFriendlyBattleSnapshotRef(snapshot);
    assert.deepEqual(ref, {
      layer: 'snapshot',
      snapshotId: 'snapshot-001',
      generation: 'gen4',
      partySource: 'current_party',
      partySize: 2,
      createdAt: '2026-04-12T12:34:56.000Z',
    });

    const battleTeam = createBattleTeamFromFriendlyBattleSnapshot(snapshot);
    battleTeam[0].displayName = '변조';
    battleTeam[0].moves[0].data.nameKo = '변조 기술';
    battleTeam[0].moves[0].currentPp = 0;

    assert.equal(snapshot.pokemon[0].displayName, snapshot.pokemon[0].speciesDisplayName);
    assert.notEqual(snapshot.pokemon[0].moves[0].nameKo, '변조 기술');
    assert.ok(snapshot.pokemon[0].moves[0].pp > 0);
  });

  it('rejects invalid current party references before snapshot creation', () => {
    const state = makeState({
      pokemon: {
        '387': {
          id: 387,
          xp: 100,
          level: 16,
          friendship: 0,
          ev: 0,
        },
      },
    });

    assert.throws(
      () =>
        buildFriendlyBattleProgressionRef({
          config: makeConfig({ party: [] }),
          state,
          generation: 'gen4',
        }),
      /at least one pokemon/i,
    );

    assert.throws(
      () =>
        buildFriendlyBattleProgressionRef({
          config: makeConfig({ party: ['387', '387'] }),
          state,
          generation: 'gen4',
        }),
      /duplicate party slot/i,
    );

    assert.throws(
      () =>
        buildFriendlyBattleProgressionRef({
          config: makeConfig({ party: ['missing'] }),
          state,
          generation: 'gen4',
        }),
      /missing progression pokemon/i,
    );
  });

  it('derives a progression ref from snapshot party order', () => {
    const snapshot = buildFriendlyBattlePartySnapshot({
      config: makeConfig({ party: ['390_shiny', '387'] }),
      state: makeState({
        pokemon: {
          '387': {
            id: 387,
            xp: 100,
            level: 16,
            friendship: 0,
            ev: 0,
            moves: [33, 45],
          },
          '390_shiny': {
            id: 390,
            xp: 200,
            level: 18,
            friendship: 0,
            ev: 0,
            shiny: true,
            moves: [33, 45, 65, 55],
          },
        },
      }),
      generation: 'gen4',
      pluginRoot,
      snapshotId: 'snapshot-derive-001',
      createdAt: '2026-04-12T12:34:56.000Z',
    });

    const progression = buildFriendlyBattleProgressionRefFromSnapshot(snapshot);
    assert.deepEqual(progression, {
      layer: 'progression',
      generation: 'gen4',
      partySource: 'current_party',
      partyPokemonIds: ['390_shiny', '387'],
    });
  });

  it('validates tampered snapshots', () => {
    const snapshot = buildFriendlyBattlePartySnapshot({
      config: makeConfig({ party: ['387'] }),
      state: makeState({
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
      }),
      generation: 'gen4',
      pluginRoot,
      snapshotId: 'snapshot-002',
      createdAt: '2026-04-12T12:35:00.000Z',
    });

    const tampered: FriendlyBattlePartySnapshot = structuredClone(snapshot);
    tampered.partySize = 99;
    tampered.pokemon[0].slot = 2;
    tampered.pokemon[0].moves = [];
    (tampered as unknown as { generation: number }).generation = 4;

    const issues = validateFriendlyBattlePartySnapshot(tampered);
    assert.match(issues.join('\n'), /partySize/i);
    assert.match(issues.join('\n'), /contiguous/i);
    assert.match(issues.join('\n'), /generation must be a non-empty string/i);
    assert.match(issues.join('\n'), /at least one move/i);
  });

  it('applies generation hooks during build and validation', () => {
    const snapshot = buildFriendlyBattlePartySnapshot({
      config: makeConfig({ party: ['387'] }),
      state: makeState({
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
      }),
      generation: 'gen4',
      pluginRoot,
      snapshotId: 'snapshot-003',
      createdAt: '2026-04-12T12:36:00.000Z',
      generationHooks: {
        gen4: {
          mapPokemon: (pokemon) => ({
            ...pokemon,
            displayName: `친선-${pokemon.displayName}`,
          }),
        },
      },
    });

    assert.match(snapshot.pokemon[0].displayName, /^친선-/);

    const issues = validateFriendlyBattlePartySnapshot(snapshot, {
      generationHooks: {
        gen4: {
          validateSnapshot: () => ['gen4 hook issue'],
        },
      },
    });
    assert.deepEqual(issues, ['gen4 hook issue']);
    assert.throws(
      () =>
        assertValidFriendlyBattlePartySnapshot(snapshot, {
          generationHooks: {
            gen4: {
              validateSnapshot: () => ['gen4 hook issue'],
            },
          },
        }),
      /gen4 hook issue/,
    );
  });
});
