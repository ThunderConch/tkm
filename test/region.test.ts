import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeState, makeConfig } from './helpers.js';
import { getCurrentRegion, isRegionUnlocked, moveToRegion, getRegionList } from '../src/core/regions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Load regions.json and pokemon.json directly
const regionsDB = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'regions.json'), 'utf-8'));
const pokemonDB = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'pokemon.json'), 'utf-8'));

describe('regions', () => {
  describe('regions.json data', () => {
    it('has 9 regions', () => {
      assert.equal(Object.keys(regionsDB.regions).length, 9);
    });

    it('has a default_region', () => {
      assert.ok(regionsDB.default_region);
      assert.ok(regionsDB.regions[regionsDB.default_region]);
    });

    it('each region has required fields', () => {
      for (const [name, r] of Object.entries(regionsDB.regions) as [string, any][]) {
        assert.equal(typeof r.id, 'number', `${name}.id`);
        assert.equal(typeof r.name, 'string', `${name}.name`);
        assert.ok(Array.isArray(r.level_range) && r.level_range.length === 2, `${name}.level_range`);
        assert.ok(Array.isArray(r.pokemon_pool) && r.pokemon_pool.length >= 10, `${name}.pokemon_pool (${r.pokemon_pool.length})`);
      }
    });

    it('all pokemon in pools exist in pokemon.json', () => {
      const missing: string[] = [];
      for (const [region, r] of Object.entries(regionsDB.regions) as [string, any][]) {
        for (const name of r.pokemon_pool) {
          if (!pokemonDB.pokemon[name]) missing.push(`${region}: ${name}`);
        }
      }
      assert.equal(missing.length, 0, `Missing:\n${missing.join('\n')}`);
    });

    it('all wild-encounterable pokemon appear in at least one region pool', () => {
      const inPool = new Set<string>();
      for (const r of Object.values(regionsDB.regions) as any[]) {
        for (const name of r.pokemon_pool) inPool.add(name);
      }
      // Exclude pokemon unlocked via evolution/starter/achievement (not wild-encounterable)
      const wildPokemon = Object.entries(pokemonDB.pokemon)
        .filter(([_, p]: [string, any]) => p.unlock === 'encounter')
        .map(([name]) => name);
      const missing = wildPokemon.filter(n => !inPool.has(n));
      assert.equal(missing.length, 0, `Not in any pool: ${missing.join(', ')}`);
    });
  });

  describe('getCurrentRegion', () => {
    it('returns configured region', () => {
      const config = makeConfig({ current_region: '2' });
      const region = getCurrentRegion(config);
      assert.equal(region.name, '2');
    });

    it('falls back to default for invalid region', () => {
      const config = makeConfig({ current_region: '없는지역' });
      const region = getCurrentRegion(config);
      assert.equal(region.name, '1');
    });
  });

  describe('isRegionUnlocked', () => {
    it('starter region is always unlocked', () => {
      const state = makeState();
      assert.ok(isRegionUnlocked('1', state));
    });

    it('locked region requires pokedex progress', () => {
      const state = makeState();
      assert.ok(!isRegionUnlocked('9', state));
    });

    it('unlocks when pokedex meets condition', () => {
      const pokedex: Record<string, any> = {};
      // Add 50 caught pokemon
      const names = Object.keys(pokemonDB.pokemon).slice(0, 50);
      for (const name of names) {
        pokedex[name] = { seen: true, caught: true, first_seen: '2026-01-01' };
      }
      const state = makeState({ pokedex });
      assert.ok(isRegionUnlocked('9', state));
    });
  });

  describe('moveToRegion', () => {
    it('moves to unlocked region', () => {
      const state = makeState();
      const config = makeConfig();
      const err = moveToRegion('1', state, config);
      assert.equal(err, null);
      assert.equal(config.current_region, '1');
    });

    it('rejects locked region', () => {
      const state = makeState();
      const config = makeConfig();
      const err = moveToRegion('9', state, config);
      assert.ok(err !== null);
    });

    it('rejects nonexistent region', () => {
      const state = makeState();
      const config = makeConfig();
      const err = moveToRegion('없는지역', state, config);
      assert.ok(err !== null);
    });
  });

  describe('getRegionList', () => {
    it('returns all regions sorted by id', () => {
      const state = makeState();
      const list = getRegionList(state);
      assert.equal(list.length, 9);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].region.id > list[i - 1].region.id);
      }
    });
  });
});
