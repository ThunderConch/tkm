import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeState } from './helpers.js';
import { markSeen, markCaught, getCompletion, syncPokedexFromUnlocked } from '../src/core/pokedex.js';

describe('pokedex', () => {
  describe('markSeen', () => {
    it('sets seen=true on new pokemon', () => {
      const state = makeState();
      markSeen(state, '387');
      assert.equal(state.pokedex['387'].seen, true);
      assert.equal(state.pokedex['387'].caught, false);
    });

    it('preserves caught status when already caught', () => {
      const state = makeState({
        pokedex: { '387': { seen: true, caught: true, first_seen: '2026-01-01' } },
      });
      markSeen(state, '387');
      assert.equal(state.pokedex['387'].caught, true);
    });

    it('is idempotent', () => {
      const state = makeState();
      markSeen(state, '387');
      const firstSeen = state.pokedex['387'].first_seen;
      markSeen(state, '387');
      assert.equal(state.pokedex['387'].first_seen, firstSeen);
    });

    it('sets first_seen only on first sight', () => {
      const state = makeState({
        pokedex: { '387': { seen: true, caught: false, first_seen: '2026-01-01' } },
      });
      markSeen(state, '387');
      assert.equal(state.pokedex['387'].first_seen, '2026-01-01');
    });

    it('sets first_seen as ISO date string', () => {
      const state = makeState();
      markSeen(state, '393');
      assert.ok(state.pokedex['393'].first_seen);
      assert.match(state.pokedex['393'].first_seen!, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('markCaught', () => {
    it('sets both seen=true and caught=true', () => {
      const state = makeState();
      markCaught(state, '387');
      assert.equal(state.pokedex['387'].seen, true);
      assert.equal(state.pokedex['387'].caught, true);
    });

    it('upgrades seen-only to caught', () => {
      const state = makeState({
        pokedex: { '387': { seen: true, caught: false, first_seen: '2026-01-01' } },
      });
      markCaught(state, '387');
      assert.equal(state.pokedex['387'].caught, true);
      assert.equal(state.pokedex['387'].first_seen, '2026-01-01');
    });

    it('is idempotent', () => {
      const state = makeState();
      markCaught(state, '387');
      markCaught(state, '387');
      assert.equal(state.pokedex['387'].caught, true);
    });
  });

  describe('getCompletion', () => {
    it('returns 0% for empty pokedex', () => {
      const state = makeState();
      const c = getCompletion(state);
      assert.equal(c.seen, 0);
      assert.equal(c.caught, 0);
      assert.equal(c.seenPct, 0);
      assert.equal(c.caughtPct, 0);
      assert.equal(c.total, 112);
    });

    it('returns correct percentage', () => {
      const state = makeState({
        pokedex: {
          '387': { seen: true, caught: true, first_seen: '2026-01-01' },
          '393': { seen: true, caught: false, first_seen: '2026-01-02' },
        },
      });
      const c = getCompletion(state);
      assert.equal(c.seen, 2);
      assert.equal(c.caught, 1);
      assert.equal(c.total, 112);
    });
  });

  describe('syncPokedexFromUnlocked', () => {
    it('marks all unlocked pokemon as caught', () => {
      const state = makeState({
        unlocked: ['387', '393'],
      });
      syncPokedexFromUnlocked(state);
      assert.equal(state.pokedex['387'].caught, true);
      assert.equal(state.pokedex['393'].caught, true);
    });

    it('preserves existing pokedex entries', () => {
      const state = makeState({
        unlocked: ['387'],
        pokedex: {
          '393': { seen: true, caught: false, first_seen: '2026-01-01' },
        },
      });
      syncPokedexFromUnlocked(state);
      assert.equal(state.pokedex['387'].caught, true);
      assert.equal(state.pokedex['393'].caught, false);
    });
  });
});
