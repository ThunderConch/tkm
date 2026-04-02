import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CRIES_DIR = join(PROJECT_ROOT, 'cries');
const SPRITES_TERMINAL_DIR = join(PROJECT_ROOT, 'sprites', 'terminal');

// Load pokemon.json directly (no env dependency)
const { readFileSync } = await import('fs');
const db = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'pokemon.json'), 'utf-8'));
const pokemon = db.pokemon as Record<string, any>;
const entries = Object.values(pokemon);
const names = Object.keys(pokemon);

describe('pokemon-data (M3a)', () => {
  describe('112 species completeness', () => {
    it('has exactly 112 entries', () => {
      assert.equal(entries.length, 112, `Expected 112, got ${entries.length}`);
    });

    it('covers expected ID range (pre-evos + Gen 4)', () => {
      const ids = entries.map((p: any) => p.id).sort((a: number, b: number) => a - b);
      assert.equal(ids[0], 280, 'lowest ID should be Ralts #280');
      assert.equal(ids[ids.length - 1], 493);
    });

    it('has no duplicate IDs', () => {
      const ids = entries.map((p: any) => p.id);
      const unique = new Set(ids);
      assert.equal(unique.size, ids.length, `Found ${ids.length - unique.size} duplicate IDs`);
    });

    it('has no duplicate names', () => {
      const unique = new Set(names);
      assert.equal(unique.size, names.length, `Found ${names.length - unique.size} duplicate names`);
    });
  });

  describe('required fields', () => {
    for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
      it(`${name} (#${p.id}) has all required fields`, () => {
        assert.equal(typeof p.id, 'number', 'id');
        assert.equal(typeof p.name, 'string', 'name');
        assert.ok(Array.isArray(p.types) && p.types.length > 0, 'types');
        assert.equal(typeof p.stage, 'number', 'stage');
        assert.ok(Array.isArray(p.line) && p.line.length > 0, 'line');
        assert.ok(p.evolves_at === null || typeof p.evolves_at === 'number', 'evolves_at');
        assert.equal(typeof p.unlock, 'string', 'unlock');
        assert.equal(typeof p.exp_group, 'string', 'exp_group');
        assert.ok(['common', 'uncommon', 'rare', 'legendary', 'mythical'].includes(p.rarity), `rarity: ${p.rarity}`);
        assert.equal(typeof p.region, 'string', 'region');
        assert.equal(typeof p.base_stats, 'object', 'base_stats');
        assert.equal(typeof p.base_stats.hp, 'number', 'base_stats.hp');
        assert.equal(typeof p.base_stats.attack, 'number', 'base_stats.attack');
        assert.equal(typeof p.base_stats.defense, 'number', 'base_stats.defense');
        assert.equal(typeof p.base_stats.speed, 'number', 'base_stats.speed');
        assert.equal(typeof p.catch_rate, 'number', 'catch_rate');
      });
    }
  });

  describe('evolution line consistency', () => {
    it('every pokemon in a line array exists as a key', () => {
      const missing: string[] = [];
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        for (const member of p.line) {
          if (!pokemon[member]) {
            missing.push(`${name}'s line references missing "${member}"`);
          }
        }
      }
      assert.equal(missing.length, 0, `Missing line members:\n${missing.join('\n')}`);
    });

    it('each pokemon appears in its own line', () => {
      const violations: string[] = [];
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        if (!p.line.includes(name)) {
          violations.push(`${name} not in its own line: [${p.line.join(', ')}]`);
        }
      }
      assert.equal(violations.length, 0, violations.join('\n'));
    });

    it('stage 0 pokemon with evolves_at have a next evolution in their line', () => {
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        if (p.stage === 0 && p.evolves_at !== null) {
          assert.ok(p.line.length > 1, `${name} has evolves_at=${p.evolves_at} but line has only 1 member`);
        }
      }
    });

    it('final stage pokemon have evolves_at = null', () => {
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        const lineIdx = p.line.indexOf(name);
        if (lineIdx === p.line.length - 1) {
          assert.equal(p.evolves_at, null, `${name} is last in line but evolves_at=${p.evolves_at}`);
        }
      }
    });
  });

  describe('type_chart', () => {
    const typeChart = db.type_chart;

    it('exists and is an object', () => {
      assert.equal(typeof typeChart, 'object');
    });

    it('every type used by a pokemon has a type_chart entry', () => {
      const usedTypes = new Set<string>();
      for (const p of entries as any[]) {
        for (const t of p.types) usedTypes.add(t);
      }
      const missing = [...usedTypes].filter(t => !typeChart[t]);
      assert.equal(missing.length, 0, `Missing type_chart entries: ${missing.join(', ')}`);
    });

    it('each type_chart entry has strong, weak, immune arrays', () => {
      for (const [type, matchup] of Object.entries(typeChart) as [string, any][]) {
        assert.ok(Array.isArray(matchup.strong), `${type}.strong`);
        assert.ok(Array.isArray(matchup.weak), `${type}.weak`);
        assert.ok(Array.isArray(matchup.immune), `${type}.immune`);
      }
    });
  });

  describe('rarity_weights', () => {
    const weights = db.rarity_weights;

    it('exists with all 5 tiers', () => {
      assert.equal(typeof weights.common, 'number');
      assert.equal(typeof weights.uncommon, 'number');
      assert.equal(typeof weights.rare, 'number');
      assert.equal(typeof weights.legendary, 'number');
      assert.equal(typeof weights.mythical, 'number');
    });

    it('sums to 1.0', () => {
      const sum = weights.common + weights.uncommon + weights.rare + weights.legendary + weights.mythical;
      assert.ok(Math.abs(sum - 1.0) < 0.001, `Sum is ${sum}, expected 1.0`);
    });

    it('matches spec values (55/30/13/1.5/0.5)', () => {
      assert.equal(weights.common, 0.55);
      assert.equal(weights.uncommon, 0.30);
      assert.equal(weights.rare, 0.13);
      assert.equal(weights.legendary, 0.015);
      assert.equal(weights.mythical, 0.005);
    });
  });

  describe('asset files', () => {
    it('every pokemon has a cry .ogg file', () => {
      const missing: string[] = [];
      for (const p of entries as any[]) {
        if (!existsSync(join(CRIES_DIR, `${p.id}.ogg`))) {
          missing.push(`${p.name} (#${p.id})`);
        }
      }
      assert.equal(missing.length, 0, `Missing cry files:\n${missing.join('\n')}`);
    });

    it('every pokemon has a terminal sprite .txt file', () => {
      const missing: string[] = [];
      for (const p of entries as any[]) {
        if (!existsSync(join(SPRITES_TERMINAL_DIR, `${p.id}.txt`))) {
          missing.push(`${p.name} (#${p.id})`);
        }
      }
      assert.equal(missing.length, 0, `Missing sprite files:\n${missing.join('\n')}`);
    });
  });

  describe('region assignments', () => {
    it('every pokemon is assigned to a region', () => {
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        assert.ok(p.region && p.region.length > 0, `${name} has no region`);
      }
    });

    it('regions have reasonable distribution (no empty, no > 30)', () => {
      const regionCounts: Record<string, number> = {};
      for (const p of entries as any[]) {
        regionCounts[p.region] = (regionCounts[p.region] || 0) + 1;
      }
      for (const [region, count] of Object.entries(regionCounts)) {
        assert.ok(count > 0, `Region "${region}" is empty`);
        assert.ok(count <= 30, `Region "${region}" has ${count} pokemon (max 30)`);
      }
    });
  });

  describe('starters preserved', () => {
    it('has correct starters array', () => {
      assert.deepEqual(db.starters, ['387', '390', '393']);
    });

    it('starter pokemon exist in pokemon entries', () => {
      for (const s of db.starters) {
        assert.ok(pokemon[s], `Starter "${s}" not found`);
      }
    });

    it('original 17 pokemon preserve unlock fields', () => {
      // Spot check a few known unlock values
      assert.equal(pokemon['387']?.unlock, 'starter');
      assert.equal(pokemon['388']?.unlock, 'evolution');
      assert.equal(pokemon['390']?.unlock, 'achievement:first_evolution');
      assert.equal(pokemon['393']?.unlock, 'achievement:first_session');
      assert.equal(pokemon['396']?.unlock, 'achievement:first_error');
      assert.equal(pokemon['403']?.unlock, 'achievement:hundred_k_tokens');
      assert.equal(pokemon['447']?.unlock, 'achievement:five_hundred_k_tokens');
    });
  });

  describe('exp_group validity', () => {
    const validGroups = ['medium_fast', 'medium_slow', 'slow', 'fast', 'erratic', 'fluctuating'];

    it('every pokemon has a valid exp_group', () => {
      for (const [name, p] of Object.entries(pokemon) as [string, any][]) {
        assert.ok(validGroups.includes(p.exp_group), `${name} has invalid exp_group: "${p.exp_group}"`);
      }
    });
  });
});
