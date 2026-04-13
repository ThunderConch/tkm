import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL_PATH = resolve(import.meta.dirname, '..', 'skills', 'friendly-battle', 'SKILL.md');
const CLI_PATH = resolve(import.meta.dirname, '..', 'src', 'cli', 'friendly-battle-turn.ts');

describe('friendly-battle SKILL.md contract', () => {
  it('exists and has a valid description frontmatter', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    assert.match(content, /^---\s*\ndescription:\s*".+?"\s*\n---/);
  });

  it('references only CLI subcommands that actually exist in friendly-battle-turn.ts', () => {
    const skillContent = readFileSync(SKILL_PATH, 'utf8');
    const cliContent = readFileSync(CLI_PATH, 'utf8');

    // Collect every --<flag> mentioned inside a bash block referencing friendly-battle-turn.ts
    const bashBlocks = [...skillContent.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    const flags = new Set<string>();
    for (const block of bashBlocks) {
      if (!block.includes('friendly-battle-turn.ts')) continue;
      for (const match of block.matchAll(/\s(--[a-z][a-z0-9-]*)/g)) {
        flags.add(match[1]);
      }
    }

    // Extract the SUBCOMMAND_FLAGS set + CLI_FLAG_SCHEMA keys from the CLI source to know which flags are supported
    const supported = new Set<string>();
    for (const match of cliContent.matchAll(/'(--[a-z][a-z0-9-]*)'/g)) {
      supported.add(match[1]);
    }
    for (const match of cliContent.matchAll(/'([a-z][a-z0-9-]*)':\s*\{\s*type:/g)) {
      supported.add(`--${match[1]}`);
    }

    const missing = [...flags].filter((flag) => !supported.has(flag));
    assert.deepEqual(missing, [], `SKILL.md references CLI flags not supported by friendly-battle-turn.ts: ${missing.join(', ')}`);
  });

  it('references only --action tokens that the CLI actually accepts', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');

    // Any --action <token> used in bash blocks
    const tokens = new Set<string>();
    for (const match of content.matchAll(/--action\s+"?([a-z]+(?::[^\s"']+)?)"?/gi)) {
      tokens.add(match[1]);
    }

    // PR45 adds switch:<N> and surrender; move:<N> was already supported.
    // Template placeholders like move:<N>, move:$N, switch:<N>, switch:$N count as their family.
    const accepted = (token: string): boolean => {
      if (/^move:[\d<$]/.test(token) || token === 'move:') return true;
      if (/^switch:[\d<$]/.test(token) || token === 'switch:') return true;
      if (token === 'surrender') return true;
      return false;
    };

    const bad = [...tokens].filter((token) => !accepted(token));
    assert.deepEqual(bad, [], `SKILL.md uses --action tokens that PR44 does not support: ${bad.join(', ')}`);
  });

  it('mentions the gym-style AskUserQuestion non-negotiable rule', () => {
    const content = readFileSync(SKILL_PATH, 'utf8');
    assert.match(content, /AskUserQuestion/);
    assert.match(content, /never\s+parse|chat\s+parsing|plain chat/i);
  });
});
