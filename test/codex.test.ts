import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the pure logic (delta calculation, XP conversion) without importing codex.ts directly,
// since codex.ts hardcodes ~/.codex path. Instead we test the math and verify the module loads.

describe('Codex token integration', () => {

  describe('readCodexTotalTokens', () => {
    it('module loads without error', async () => {
      // Verify the module can be imported (node:sqlite available)
      const mod = await import('../src/core/codex.js');
      assert.equal(typeof mod.readCodexTotalTokens, 'function');
    });

    it('returns a number (reads real DB or returns 0)', async () => {
      const { readCodexTotalTokens } = await import('../src/core/codex.js');
      const result = readCodexTotalTokens();
      assert.equal(typeof result, 'number');
      assert.ok(result >= 0, 'tokens must be non-negative');
    });
  });

  describe('delta calculation logic', () => {
    it('computes correct delta from checkpoint', () => {
      const codexTotal = 500_000;
      const lastCheckpoint = 300_000;
      const delta = Math.max(0, codexTotal - lastCheckpoint);
      assert.equal(delta, 200_000);
    });

    it('delta is 0 when no new tokens', () => {
      const codexTotal = 300_000;
      const lastCheckpoint = 300_000;
      const delta = Math.max(0, codexTotal - lastCheckpoint);
      assert.equal(delta, 0);
    });

    it('delta never goes negative', () => {
      // Edge case: Codex DB was reset/recreated with lower total
      const codexTotal = 100_000;
      const lastCheckpoint = 300_000;
      const delta = Math.max(0, codexTotal - lastCheckpoint);
      assert.equal(delta, 0);
    });
  });

  describe('XP conversion', () => {
    it('converts tokens to flat XP using tokens_per_xp', () => {
      const delta = 150_000;
      const tokensPerXp = 10_000;
      const xp = Math.floor(delta / tokensPerXp);
      assert.equal(xp, 15);
    });

    it('floors partial XP', () => {
      const delta = 15_999;
      const tokensPerXp = 10_000;
      const xp = Math.floor(delta / tokensPerXp);
      assert.equal(xp, 1);
    });

    it('returns 0 for delta below tokens_per_xp', () => {
      const delta = 9_999;
      const tokensPerXp = 10_000;
      const xp = Math.floor(delta / tokensPerXp);
      assert.equal(xp, 0);
    });

    it('respects custom tokens_per_xp', () => {
      const delta = 50_000;
      const tokensPerXp = 5_000;
      const xp = Math.floor(delta / tokensPerXp);
      assert.equal(xp, 10);
    });
  });

  describe('stats accumulation', () => {
    it('accumulates codex_tokens_consumed correctly', () => {
      const stats = { codex_tokens_consumed: 100_000, codex_xp_earned: 10 };
      const newDelta = 50_000;
      const newXp = 5;
      stats.codex_tokens_consumed += newDelta;
      stats.codex_xp_earned += newXp;
      assert.equal(stats.codex_tokens_consumed, 150_000);
      assert.equal(stats.codex_xp_earned, 15);
    });

    it('handles undefined stats fields with nullish coalescing', () => {
      const stats: Record<string, number | undefined> = {};
      const delta = 25_000;
      const xp = 2;
      stats.codex_tokens_consumed = (stats.codex_tokens_consumed ?? 0) + delta;
      stats.codex_xp_earned = (stats.codex_xp_earned ?? 0) + xp;
      assert.equal(stats.codex_tokens_consumed, 25_000);
      assert.equal(stats.codex_xp_earned, 2);
    });
  });

  describe('type integration', () => {
    it('Stats interface includes codex fields', async () => {
      // Verify the type changes compiled correctly by checking default state
      const { readState } = await import('../src/core/state.js');
      // readState on a non-existent gen returns defaults
      const state = readState('__test_nonexistent_gen__');
      assert.equal(state.stats.codex_tokens_consumed, 0);
      assert.equal(state.stats.codex_xp_earned, 0);
      assert.equal(state.last_codex_xp, undefined); // optional field, not in defaults
    });

    it('CommonState includes last_codex_tokens_total', async () => {
      const { readCommonState } = await import('../src/core/state.js');
      const common = readCommonState();
      assert.equal(typeof common.last_codex_tokens_total, 'number');
    });
  });

  describe('SQLite reader with real DB', () => {
    it('reads positive token count if Codex is installed', async () => {
      const { readCodexTotalTokens } = await import('../src/core/codex.js');
      const total = readCodexTotalTokens();
      // Returns positive count if Codex is installed, 0 otherwise — both are valid
      assert.equal(typeof total, 'number');
      assert.ok(total >= 0);
      if (existsSync(join(process.env.HOME ?? '', '.codex', 'state_5.sqlite'))) {
        assert.ok(total > 0, 'Codex is installed, expected positive token count');
      }
    });
  });
});
