import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  SPRITES_RAW_DIR,
  SPRITES_RAW_SHINY_DIR,
  SPRITES_BRAILLE_DIR,
  SPRITES_BRAILLE_SHINY_DIR,
} from '../src/core/paths.js';

// The shiny sprite pipeline replaced the old runtime hue-rotation transform.
// Shiny PNGs are mirrored from PokeAPI's `sprites.front_shiny` (official game
// palettes) and converted into the same downstream formats as the regular
// sprites. These tests check the data + directory invariants the runtime
// relies on; the actual palette correctness comes from PokeAPI.

describe('shiny sprite data', () => {
  it('shiny raw directory exists', () => {
    assert.ok(existsSync(SPRITES_RAW_SHINY_DIR), `${SPRITES_RAW_SHINY_DIR} missing — run scripts/fetch-shiny-sprites.ts`);
    assert.ok(statSync(SPRITES_RAW_SHINY_DIR).isDirectory());
  });

  it('shiny braille directory exists', () => {
    assert.ok(existsSync(SPRITES_BRAILLE_SHINY_DIR), `${SPRITES_BRAILLE_SHINY_DIR} missing — run scripts/generate-braille-sprites.ts`);
    assert.ok(statSync(SPRITES_BRAILLE_SHINY_DIR).isDirectory());
  });

  it('shiny coverage is non-trivial (at least 100 species)', () => {
    const shinyPngs = readdirSync(SPRITES_RAW_SHINY_DIR).filter(f => f.endsWith('.png'));
    assert.ok(shinyPngs.length >= 100, `expected ≥100 shiny PNGs, found ${shinyPngs.length}`);
  });

  it('every shiny PNG has a matching regular PNG (no orphans)', () => {
    const shinyIds = new Set(readdirSync(SPRITES_RAW_SHINY_DIR).filter(f => f.endsWith('.png')));
    const rawIds = new Set(readdirSync(SPRITES_RAW_DIR).filter(f => f.endsWith('.png')));
    const orphans = [...shinyIds].filter(f => !rawIds.has(f));
    assert.deepEqual(orphans, [], `orphan shiny sprites without regular counterparts: ${orphans.slice(0, 5).join(', ')}`);
  });

  it('shiny braille files exist for downloaded shiny PNGs', () => {
    const shinyPngs = readdirSync(SPRITES_RAW_SHINY_DIR).filter(f => f.endsWith('.png'));
    const sample = shinyPngs.slice(0, 20);
    for (const file of sample) {
      const id = file.replace('.png', '');
      const braillePath = join(SPRITES_BRAILLE_SHINY_DIR, `${id}.txt`);
      assert.ok(existsSync(braillePath), `missing braille_shiny/${id}.txt — run scripts/generate-braille-sprites.ts`);
    }
  });

  it('shiny braille differs from regular braille for the same id', () => {
    // Pick the first id that has both regular and shiny braille files.
    const shinyFiles = readdirSync(SPRITES_BRAILLE_SHINY_DIR).filter(f => f.endsWith('.txt'));
    const regularSet = new Set(readdirSync(SPRITES_BRAILLE_DIR).filter(f => f.endsWith('.txt')));
    const both = shinyFiles.find(f => regularSet.has(f));
    assert.ok(both, 'expected at least one id with both regular and shiny braille sprites');

    const regular = readFileSync(join(SPRITES_BRAILLE_DIR, both!), 'utf-8');
    const shiny = readFileSync(join(SPRITES_BRAILLE_SHINY_DIR, both!), 'utf-8');
    assert.notEqual(shiny, regular, `expected shiny sprite to differ from regular for id ${both}`);
  });
});
