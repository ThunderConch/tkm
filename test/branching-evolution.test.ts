import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvolution, getEligibleBranches, applyBranchEvolution } from '../src/core/evolution.js';
import { makeState, makeConfig } from './helpers.js';
import type { EvolutionContext } from '../src/core/types.js';

function makeCtx(overrides: Partial<EvolutionContext> = {}): EvolutionContext {
  return {
    oldLevel: 10, newLevel: 11, friendship: 0,
    currentRegion: '1',
    unlockedAchievements: [], items: {},
    ...overrides,
  };
}

describe('branching evolution', () => {
  describe('checkEvolution blocks auto-evolve for branching pokemon', () => {
    it('Kirlia (#281) does not auto-evolve, sets evolution_ready', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 5000, level: 30, friendship: 0, ev: 0 } },
      });
      const ctx = makeCtx({ oldLevel: 29, newLevel: 30 });
      const result = checkEvolution('281', ctx, state);
      assert.equal(result, null, 'Should not auto-evolve branching pokemon');
      assert.equal(state.pokemon['281'].evolution_ready, true);
      assert.ok(state.pokemon['281'].evolution_options!.includes('282'));
    });

    it('Snorunt (#361) does not auto-evolve, sets evolution_ready', () => {
      const state = makeState({
        pokemon: { '361': { id: 361, xp: 8000, level: 42, friendship: 0, ev: 0 } },
      });
      const ctx = makeCtx({ oldLevel: 41, newLevel: 42 });
      const result = checkEvolution('361', ctx, state);
      assert.equal(result, null);
      assert.equal(state.pokemon['361'].evolution_ready, true);
      assert.ok(state.pokemon['361'].evolution_options!.includes('362'));
    });

    it('Burmy (#412) does not auto-evolve, sets evolution_ready', () => {
      const state = makeState({
        pokemon: { '412': { id: 412, xp: 3000, level: 20, friendship: 0, ev: 0 } },
      });
      const ctx = makeCtx({ oldLevel: 19, newLevel: 20 });
      const result = checkEvolution('412', ctx, state);
      assert.equal(result, null);
      assert.equal(state.pokemon['412'].evolution_ready, true);
      assert.ok(state.pokemon['412'].evolution_options!.length === 2);
    });

    it('does not set evolution_ready if no branch condition met', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 1000, level: 10, friendship: 0, ev: 0 } },
      });
      const ctx = makeCtx({ oldLevel: 9, newLevel: 10 }); // below level:30
      checkEvolution('281', ctx, state);
      assert.equal(state.pokemon['281'].evolution_ready, undefined);
    });

    it('does not overwrite existing evolution_ready', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 5000, level: 30, friendship: 0, ev: 0, evolution_ready: true, evolution_options: ['282'] } },
      });
      const ctx = makeCtx({ oldLevel: 29, newLevel: 30 });
      checkEvolution('281', ctx, state);
      assert.deepEqual(state.pokemon['281'].evolution_options, ['282']);
    });
  });

  describe('checkEvolution without state still returns null for branching', () => {
    it('returns null without setting flags when state not passed', () => {
      const ctx = makeCtx({ oldLevel: 29, newLevel: 30 });
      const result = checkEvolution('281', ctx);
      assert.equal(result, null);
    });
  });

  describe('single-path evolution still works (regression)', () => {
    it('387 (Turtwig) auto-evolves at Lv.18', () => {
      const ctx = makeCtx({ oldLevel: 17, newLevel: 18 });
      const result = checkEvolution('387', ctx);
      assert.notEqual(result, null);
      assert.equal(result!.newPokemon, '388');
    });

    it('447 (Riolu) evolves via friendship', () => {
      const ctx = makeCtx({ friendship: 220 });
      const result = checkEvolution('447', ctx);
      assert.notEqual(result, null);
      assert.equal(result!.newPokemon, '448');
    });
  });

  describe('getEligibleBranches', () => {
    it('Kirlia: level:30 met, item:dawn_stone not met', () => {
      const ctx = makeCtx({ oldLevel: 29, newLevel: 30 });
      const branches = getEligibleBranches('281', ctx);
      assert.equal(branches.length, 2);

      const gardevoir = branches.find(b => b.name === '282')!;
      assert.equal(gardevoir.conditionMet, true);
      assert.equal(gardevoir.conditionLabel, 'level:30');

      const gallade = branches.find(b => b.name === '475')!;
      assert.equal(gallade.conditionMet, false);
      assert.equal(gallade.conditionLabel, 'item:dawn_stone');
    });

    it('Kirlia: both branches met when has dawn_stone + level 30', () => {
      const ctx = makeCtx({ oldLevel: 29, newLevel: 30, items: { dawn_stone: 1 } });
      const branches = getEligibleBranches('281', ctx);
      assert.ok(branches.every(b => b.conditionMet));
    });

    it('Snorunt: level:42 met, dawn_stone not met', () => {
      const ctx = makeCtx({ oldLevel: 41, newLevel: 42 });
      const branches = getEligibleBranches('361', ctx);
      const glalie = branches.find(b => b.name === '362')!;
      const froslass = branches.find(b => b.name === '478')!;
      assert.equal(glalie.conditionMet, true);
      assert.equal(froslass.conditionMet, false);
    });

    it('Burmy: both branches met at level 20', () => {
      const ctx = makeCtx({ oldLevel: 19, newLevel: 20 });
      const branches = getEligibleBranches('412', ctx);
      assert.equal(branches.length, 2);
      assert.ok(branches.every(b => b.conditionMet));
    });

    it('returns empty for non-branching pokemon', () => {
      const ctx = makeCtx();
      assert.deepEqual(getEligibleBranches('387', ctx), []);
    });

    it('returns empty for unknown pokemon', () => {
      const ctx = makeCtx();
      assert.deepEqual(getEligibleBranches('unknown', ctx), []);
    });
  });

  describe('applyBranchEvolution', () => {
    it('evolves Kirlia to Gardevoir', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 5000, level: 30, friendship: 100, ev: 50, evolution_ready: true, evolution_options: ['282'] } },
        unlocked: ['281'],
      });
      const config = makeConfig({ party: ['281'] });

      const result = applyBranchEvolution(state, config, '281', '282');
      assert.notEqual(result, null);
      assert.equal(result!.oldPokemon, '281');
      assert.equal(result!.newPokemon, '282');
      assert.equal(state.pokemon['282'].id, 282);
      assert.equal(state.pokemon['282'].friendship, 100);
      assert.equal(state.pokemon['282'].ev, 50);
      assert.ok(state.unlocked.includes('282'));
      assert.deepEqual(config.party, ['282']);
      assert.equal(state.evolution_count, 1);
      // evolution_ready cleared
      assert.equal(state.pokemon['281'].evolution_ready, undefined);
      assert.equal(state.pokemon['281'].evolution_options, undefined);
    });

    it('evolves Kirlia to Gallade', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 5000, level: 30, friendship: 0, ev: 0, evolution_ready: true, evolution_options: ['282', '475'] } },
        unlocked: ['281'],
      });
      const config = makeConfig({ party: ['281'] });

      const result = applyBranchEvolution(state, config, '281', '475');
      assert.notEqual(result, null);
      assert.equal(result!.newPokemon, '475');
      assert.equal(state.pokemon['475'].id, 475);
      assert.deepEqual(config.party, ['475']);
    });

    it('returns null for invalid target', () => {
      const state = makeState({
        pokemon: { '281': { id: 281, xp: 5000, level: 30, friendship: 0, ev: 0 } },
      });
      const config = makeConfig();
      assert.equal(applyBranchEvolution(state, config, '281', '999'), null);
    });

    it('returns null for non-branching pokemon', () => {
      const state = makeState({
        pokemon: { '387': { id: 387, xp: 5000, level: 18, friendship: 0, ev: 0 } },
      });
      const config = makeConfig();
      assert.equal(applyBranchEvolution(state, config, '387', '388'), null);
    });
  });
});
