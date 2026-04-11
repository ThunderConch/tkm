import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeState, makeConfig } from './helpers.js';
import { getActiveEvents, selectWildPokemon } from '../src/core/encounter.js';
import { initLocale } from '../src/i18n/index.js';
import type { EventsDB } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

initLocale('ko');

describe('events', () => {
  describe('events.json', () => {
    it('loads valid events data', () => {
      const raw = readFileSync(join(PROJECT_ROOT, 'data', 'events.json'), 'utf-8');
      const db = JSON.parse(raw) as EventsDB;
      assert.ok(Array.isArray(db.time_of_day));
      assert.ok(Array.isArray(db.day_of_week));
      assert.ok(Array.isArray(db.streak));
      assert.ok(Array.isArray(db.milestone));
      assert.ok(db.time_of_day.length > 0);
      assert.ok(db.day_of_week.length > 0);
    });

    it('time_of_day events have required fields', () => {
      const raw = readFileSync(join(PROJECT_ROOT, 'data', 'events.json'), 'utf-8');
      const db = JSON.parse(raw) as EventsDB;
      for (const e of db.time_of_day) {
        assert.ok(e.id, 'Missing id');
        assert.ok(Array.isArray(e.hours), 'Missing hours');
        assert.ok(typeof e.type_boost === 'object', 'Missing type_boost');
        assert.ok(e.label.en, 'Missing en label');
        assert.ok(e.label.ko, 'Missing ko label');
      }
    });

    it('day_of_week events have required fields', () => {
      const raw = readFileSync(join(PROJECT_ROOT, 'data', 'events.json'), 'utf-8');
      const db = JSON.parse(raw) as EventsDB;
      for (const e of db.day_of_week) {
        assert.ok(e.id);
        assert.ok(typeof e.day === 'number');
        assert.ok(typeof e.rare_multiplier === 'number');
        assert.ok(e.label.en);
        assert.ok(e.label.ko);
      }
    });
  });

  describe('getActiveEvents', () => {
    it('returns an ActiveEvents object', () => {
      const state = makeState();
      const events = getActiveEvents(state);
      assert.ok(Array.isArray(events.timeEvents));
      assert.ok(Array.isArray(events.dayEvents));
      assert.ok(Array.isArray(events.streakEvents));
      assert.ok(Array.isArray(events.milestoneEvents));
    });

    it('detects streak event when threshold met', () => {
      const state = makeState({
        stats: {
          ...makeState().stats,
          streak_days: 7,
        },
      });
      const events = getActiveEvents(state);
      assert.ok(events.streakEvents.length >= 1, 'Should detect weekly_streak at 7 days');
    });

    it('no streak event below threshold', () => {
      const state = makeState({
        stats: {
          ...makeState().stats,
          streak_days: 3,
        },
      });
      const events = getActiveEvents(state);
      assert.equal(events.streakEvents.length, 0);
    });

    it('detects milestone event when threshold met', () => {
      const state = makeState({
        total_tokens_consumed: 1500000,
      });
      const events = getActiveEvents(state);
      assert.ok(events.milestoneEvents.length >= 1, 'Should detect million_tokens milestone');
    });

    it('skips already-triggered milestones', () => {
      const state = makeState({
        total_tokens_consumed: 1500000,
        events_triggered: ['million_tokens'],
      });
      const events = getActiveEvents(state);
      const million = events.milestoneEvents.filter(e => e.id === 'million_tokens');
      assert.equal(million.length, 0);
    });
  });

  describe('selectWildPokemon with events', () => {
    it('streak guarantee selects rare pokemon when available', () => {
      const state = makeState({
        stats: {
          ...makeState().stats,
          streak_days: 7,
        },
      });
      // Region 4 has rare pokemon (405, 462, 466, 474) — was region 5 before gen4 reorder
      const config = makeConfig({ party: ['387'], current_region: '4' });
      const pokemonDB = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data', 'pokemon.json'), 'utf-8'));

      // With 7-day streak, should get rare or legendary from region with rare pool
      let rareCount = 0;
      for (let i = 0; i < 50; i++) {
        const wild = selectWildPokemon(state, config);
        if (wild) {
          const rarity = pokemonDB.pokemon[wild.name]?.rarity;
          if (rarity === 'rare' || rarity === 'legendary') rareCount++;
        }
      }
      // All should be rare/legendary due to streak guarantee
      assert.equal(rareCount, 50, `Expected all 50 to be rare/legendary, got ${rareCount}`);
    });

    it('normal selection still works without events', () => {
      const state = makeState();
      const config = makeConfig({ party: ['387'], current_region: '1' });
      const wild = selectWildPokemon(state, config);
      assert.ok(wild !== null);
      assert.ok(typeof wild!.name === 'string');
      assert.ok(typeof wild!.level === 'number');
    });
  });
});
