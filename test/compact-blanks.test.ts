/**
 * Tests for ghostty-targeted CSI transparent-cell compaction.
 *
 * Root cause: ghostty's font fallback renders \u2800 (Braille Pattern Blank)
 * at a subtly different advance width than non-zero braille cells. Sprite
 * rows with different opaque/transparent ratios drift relative to each other
 * even though every row has the same character count. See fix commit
 * message for full details.
 *
 * Fix: for ghostty terminals only, replace runs of \u2800 with explicit
 * CSI CUF (\x1b[NC) escapes so the terminal advances by exact cell count
 * instead of consulting the font's glyph advance width. Non-ghostty
 * terminals keep the existing \u2800 pipeline that b5b8796 established.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactBlanksToCsi,
  shouldCompactBlanks,
  scatterWeatherParticles,
} from '../src/status-line.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^m]*m/g, '');
}

describe('compactBlanksToCsi', () => {
  it('converts a single \\u2800 to \\x1b[C', () => {
    assert.equal(compactBlanksToCsi('\u2800'), '\x1b[C');
  });

  it('converts a run of N \\u2800 to \\x1b[NC', () => {
    assert.equal(compactBlanksToCsi('\u2800\u2800\u2800'), '\x1b[3C');
    assert.equal(compactBlanksToCsi('\u2800'.repeat(20)), '\x1b[20C');
  });

  it('leaves non-blank chars untouched', () => {
    assert.equal(compactBlanksToCsi('⣿⣿⣿'), '⣿⣿⣿');
    assert.equal(compactBlanksToCsi('hello'), 'hello');
  });

  it('leaves an empty string unchanged', () => {
    assert.equal(compactBlanksToCsi(''), '');
  });

  it('handles mixed opaque + transparent runs', () => {
    assert.equal(
      compactBlanksToCsi('⣿\u2800⣿\u2800\u2800⣿'),
      '⣿\x1b[C⣿\x1b[2C⣿',
    );
  });

  it('compacts leading and trailing blank runs', () => {
    assert.equal(
      compactBlanksToCsi('\u2800\u2800⣿\u2800\u2800\u2800'),
      '\x1b[2C⣿\x1b[3C',
    );
  });

  it('preserves SGR color escape sequences around opaque cells', () => {
    const input = '\x1b[38;5;66m⣿\x1b[0m\u2800\u2800\x1b[38;5;66m⣿\x1b[0m';
    const expected = '\x1b[38;5;66m⣿\x1b[0m\x1b[2C\x1b[38;5;66m⣿\x1b[0m';
    assert.equal(compactBlanksToCsi(input), expected);
  });

  it('does not touch non-braille ASCII whitespace', () => {
    // ASCII space and tab must stay as-is — they belong to text-layout
    // code paths that are not part of the braille render pipeline.
    assert.equal(compactBlanksToCsi('a b\tc'), 'a b\tc');
  });

  it('advances exactly SPRITE_WIDTH cells for an entirely blank row', () => {
    // A fully-transparent sprite row in isolation becomes a single CUF
    // of SPRITE_WIDTH (20) — the cursor lands on the same column it
    // would have landed on if the row were rendered with \u2800 glyphs
    // of width 1.
    const blankRow = '\u2800'.repeat(20);
    assert.equal(compactBlanksToCsi(blankRow), '\x1b[20C');
  });
});

describe('compactBlanksToCsi after scatterWeatherParticles', () => {
  it('leaves zero \\u2800 in the final output', () => {
    // Compose a sprite row with both opaque and transparent cells,
    // overlay weather particles (replaces some \u2800 with colored braille),
    // then compact. The final string must contain no \u2800 codepoint.
    const row = '\x1b[38;5;66m⣿\x1b[0m'.repeat(8) + '\u2800'.repeat(12);
    for (let i = 0; i < 50; i++) {
      const scattered = scatterWeatherParticles(row, 'rain');
      const compacted = compactBlanksToCsi(scattered);
      assert.ok(
        !compacted.includes('\u2800'),
        `iter=${i}: output still contains \\u2800: ${JSON.stringify(compacted)}`,
      );
    }
  });

  it('preserves non-\\u2800 codepoints bit-for-bit through compaction', () => {
    // Everything that is not \u2800 must survive the replace untouched —
    // SGR escapes, opaque braille, and any weather-injected particles.
    const row = '\x1b[38;5;66m⣿\x1b[0m\u2800⠡\u2800\u2800\x1b[34m⠑\x1b[0m';
    const compacted = compactBlanksToCsi(row);
    // Strip CSI CUF (\x1b[NC) and CSI SGR (\x1b[...m) — what remains must
    // match the non-blank codepoints of the original in order.
    const cufStripped = compacted.replace(/\x1b\[\d*C/g, '');
    const allStripped = cufStripped.replace(/\x1b\[[^m]*m/g, '');
    const originalNonBlank = stripAnsi(row).replace(/\u2800/g, '');
    assert.equal(allStripped, originalNonBlank);
  });
});

describe('shouldCompactBlanks', () => {
  it('detects ghostty via TERM=xterm-ghostty', () => {
    assert.equal(shouldCompactBlanks({ TERM: 'xterm-ghostty' }), true);
  });

  it('detects ghostty via TERM_PROGRAM=ghostty', () => {
    assert.equal(
      shouldCompactBlanks({ TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' }),
      true,
    );
  });

  it('returns false for kitty', () => {
    assert.equal(shouldCompactBlanks({ TERM: 'xterm-kitty' }), false);
  });

  it('returns false for unknown terminal', () => {
    assert.equal(shouldCompactBlanks({ TERM: 'xterm-256color' }), false);
  });

  it('returns false for wezterm (keeps the b5b8796 CJK fix path)', () => {
    assert.equal(
      shouldCompactBlanks({ TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' }),
      false,
    );
  });

  it('returns false for iTerm.app', () => {
    assert.equal(
      shouldCompactBlanks({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }),
      false,
    );
  });

  it('returns false on an empty env', () => {
    assert.equal(shouldCompactBlanks({}), false);
  });
});
