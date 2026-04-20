/**
 * verify.ts — 3-layer assertion module for test-evolve scenarios.
 *
 *   Layer 1 (UI):    regex on `tmux capture-pane` plaintext matches
 *                    `scenario.expected_block.reason_contains`
 *   Layer 2 (Tool):  captured pane text contains `tokenmon evolve <from> <to>`
 *   Layer 3 (State): post-run state.json/config.json match
 *                    `scenario.expected_after` assertions
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Scenario {
  name: string;
  description: string;
  seed: {
    party: string[];
    pokemon: Record<string, any>;
    unlocked: string[];
  };
  expected_block: {
    decision: string;
    reason_contains: string[];
  };
  expected_choice: string;
  expected_after: Record<string, any>;
}

export interface LayerResult {
  pass: boolean;
  detail: string;
}

export interface StateDiffEntry {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface VerifyResult {
  scenario: string;
  pass: boolean;
  layer_ui: LayerResult;
  layer_tool: LayerResult;
  layer_state: LayerResult & { diffs: StateDiffEntry[] };
}

/**
 * Layer 1 — UI render assertion. Every `reason_contains` fragment must appear
 * (case-insensitive substring) somewhere in the captured text.
 */
export function verifyUI(capturedText: string, scenario: Scenario): LayerResult {
  const lowered = capturedText.toLowerCase();
  const missed: string[] = [];
  const matched: string[] = [];
  for (const frag of scenario.expected_block.reason_contains) {
    if (lowered.includes(frag.toLowerCase())) {
      matched.push(frag);
    } else {
      missed.push(frag);
    }
  }
  return {
    pass: missed.length === 0,
    detail: missed.length === 0
      ? `all ${matched.length} fragments matched`
      : `missed: ${missed.join(', ')}`,
  };
}

/**
 * Layer 2 — tool call assertion. Looks for `tokenmon evolve <from> <to>`
 * or `tokenmon evolve <from>` in the captured text. <from> is any party
 * member that was evolution-ready in the seed; <to> is `expected_choice`
 * when it is a numeric pokemon id.
 */
export function verifyToolCall(capturedText: string, scenario: Scenario): LayerResult {
  const readyFrom = Object.keys(scenario.seed.pokemon).filter(
    (k) => scenario.seed.pokemon[k]?.evolution_ready,
  );
  const choice = scenario.expected_choice;
  const isNumericChoice = /^\d+$/.test(choice);

  // If user refused (non-numeric choice like "no"), we don't expect a
  // `tokenmon evolve` call — success is absence of the call.
  if (!isNumericChoice) {
    const absent = !/\btokenmon\s+evolve\s+/.test(capturedText);
    return {
      pass: absent,
      detail: absent ? 'no tokenmon evolve call (as expected for refuse)' : 'unexpected tokenmon evolve call found',
    };
  }

  // Look for `tokenmon evolve <from> <choice>` with any of the ready from ids
  for (const from of readyFrom) {
    const re = new RegExp(`tokenmon\\s+evolve\\s+${from}\\s+${choice}`);
    if (re.test(capturedText)) {
      return { pass: true, detail: `found: tokenmon evolve ${from} ${choice}` };
    }
  }
  // Fallback: accept `tokenmon evolve <choice>` (evolve without from id)
  const fallback = new RegExp(`tokenmon\\s+evolve\\s+\\d+\\s+${choice}`);
  if (fallback.test(capturedText)) {
    return { pass: true, detail: `found fallback: tokenmon evolve … ${choice}` };
  }
  return { pass: false, detail: `no tokenmon evolve call matching ${readyFrom.join('|')} → ${choice}` };
}

interface ReadableState {
  pokemon?: Record<string, any>;
  unlocked?: string[];
  [k: string]: any;
}

interface ReadableConfig {
  party?: string[];
  [k: string]: any;
}

function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * Layer 3 — state diff. Reads state.json and config.json from the scenario's
 * tempdir (configDirOverride) or from the live CLAUDE_DIR, then compares each
 * `expected_after` field.
 *
 * Supported field forms:
 *   `pokemon.<id>.<key>`         — equality (null = field absent)
 *   `unlocked.includes`          — array of ids that MUST be present in state.unlocked
 *   `unlocked.excludes`          — array of ids that MUST NOT be present
 *   `party.includes`             — array of ids that MUST be present in config.party
 */
export function verifyState(
  scenario: Scenario,
  gen: string,
  configDirOverride?: string,
): LayerResult & { diffs: StateDiffEntry[] } {
  const base = configDirOverride ?? process.env.CLAUDE_CONFIG_DIR ?? '';
  const tokenmonDir = base ? join(base, 'tokenmon', gen) : '';
  const statePath = tokenmonDir ? join(tokenmonDir, 'state.json') : '';
  const configPath = tokenmonDir ? join(tokenmonDir, 'config.json') : '';

  const state = readJsonSafe<ReadableState>(statePath) ?? {};
  const config = readJsonSafe<ReadableConfig>(configPath) ?? {};

  const diffs: StateDiffEntry[] = [];

  for (const [field, expected] of Object.entries(scenario.expected_after)) {
    if (field.startsWith('pokemon.')) {
      const parts = field.split('.');
      const id = parts[1];
      const key = parts.slice(2).join('.');
      const p = state.pokemon?.[id];
      const actual = p ? getByPath(p, key) : undefined;
      if (!deepEqualOrNull(actual, expected)) {
        diffs.push({ field, expected, actual });
      }
    } else if (field === 'unlocked.includes') {
      const arr = Array.isArray(expected) ? expected : [];
      const unlocked = state.unlocked ?? [];
      for (const id of arr) {
        if (!unlocked.includes(id)) {
          diffs.push({ field: `unlocked.includes[${id}]`, expected: true, actual: false });
        }
      }
    } else if (field === 'unlocked.excludes') {
      const arr = Array.isArray(expected) ? expected : [];
      const unlocked = state.unlocked ?? [];
      for (const id of arr) {
        if (unlocked.includes(id)) {
          diffs.push({ field: `unlocked.excludes[${id}]`, expected: false, actual: true });
        }
      }
    } else if (field === 'party.includes') {
      const arr = Array.isArray(expected) ? expected : [];
      const party = config.party ?? [];
      for (const id of arr) {
        if (!party.includes(id)) {
          diffs.push({ field: `party.includes[${id}]`, expected: true, actual: false });
        }
      }
    } else {
      // Generic top-level field compare
      const actual = (state as any)[field];
      if (!deepEqualOrNull(actual, expected)) {
        diffs.push({ field, expected, actual });
      }
    }
  }

  return {
    pass: diffs.length === 0,
    detail: diffs.length === 0 ? 'all state assertions passed' : `${diffs.length} diff(s)`,
    diffs,
  };
}

/** Run all 3 layers and aggregate into a VerifyResult. */
export function verifyScenario(
  capturedText: string,
  scenario: Scenario,
  gen: string,
  configDirOverride?: string,
): VerifyResult {
  const layer_ui = verifyUI(capturedText, scenario);
  const layer_tool = verifyToolCall(capturedText, scenario);
  const layer_state = verifyState(scenario, gen, configDirOverride);
  return {
    scenario: scenario.name,
    pass: layer_ui.pass && layer_tool.pass && layer_state.pass,
    layer_ui,
    layer_tool,
    layer_state,
  };
}

// ── helpers ──

function getByPath(obj: any, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Equality with null-coalesced undefined. `null` in `expected` means the field
 * should be absent/undefined in actual.
 */
function deepEqualOrNull(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === undefined || actual === null;
  return JSON.stringify(actual) === JSON.stringify(expected);
}
