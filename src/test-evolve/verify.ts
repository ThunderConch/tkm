/**
 * verify.ts — State-only assertion for test-evolve scenarios.
 *
 * `verifyState(scenario, gen)` reads the live state.json / config.json and
 * compares each `expected_after` field. Returns a structured result with
 * per-field diffs so the CLI can print PASS/FAIL per field.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface Scenario {
  name: string;
  description: string;
  seed: {
    party: string[];
    pokemon: Record<string, any>;
    unlocked: string[];
    /** Optional bag items keyed by canonical item id (e.g. "water-stone"). */
    items?: Record<string, number>;
    /** Optional current_region override on config (e.g. "4") for location-based evolutions. */
    current_region?: string;
  };
  expected_block: {
    decision: string;
    reason_contains: string[];
  };
  expected_choice: string;
  expected_after: Record<string, any>;
}

export interface StateDiffEntry {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface StateVerifyResult {
  pass: boolean;
  detail: string;
  diffs: StateDiffEntry[];
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

function getByPath(obj: any, path: string): unknown {
  if (!path) return obj;
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function deepEqualOrNull(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === undefined || actual === null;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Read live state.json / config.json and compare against scenario.expected_after.
 *
 * Supported field forms:
 *   `pokemon.<id>.<key>`    — equality (null = field absent)
 *   `unlocked.includes`     — array of ids that MUST be present in state.unlocked
 *   `unlocked.excludes`     — array of ids that MUST NOT be present
 *   `party.includes`        — array of ids that MUST be present in config.party
 */
export function verifyState(scenario: Scenario, gen: string): StateVerifyResult {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const tokenmonDir = join(claudeDir, 'tokenmon', gen);
  const state = readJsonSafe<ReadableState>(join(tokenmonDir, 'state.json')) ?? {};
  const config = readJsonSafe<ReadableConfig>(join(tokenmonDir, 'config.json')) ?? {};

  const diffs: StateDiffEntry[] = [];

  for (const [field, expected] of Object.entries(scenario.expected_after)) {
    if (field.startsWith('pokemon.')) {
      const parts = field.split('.');
      const id = parts[1];
      const key = parts.slice(2).join('.');
      const p = state.pokemon?.[id];
      const actual = p ? getByPath(p, key) : undefined;
      if (!deepEqualOrNull(actual, expected)) diffs.push({ field, expected, actual });
    } else if (field === 'unlocked.includes') {
      const arr = Array.isArray(expected) ? expected : [];
      const unlocked = state.unlocked ?? [];
      for (const id of arr) {
        if (!unlocked.includes(id))
          diffs.push({ field: `unlocked.includes[${id}]`, expected: true, actual: false });
      }
    } else if (field === 'unlocked.excludes') {
      const arr = Array.isArray(expected) ? expected : [];
      const unlocked = state.unlocked ?? [];
      for (const id of arr) {
        if (unlocked.includes(id))
          diffs.push({ field: `unlocked.excludes[${id}]`, expected: false, actual: true });
      }
    } else if (field === 'party.includes') {
      const arr = Array.isArray(expected) ? expected : [];
      const party = config.party ?? [];
      for (const id of arr) {
        if (!party.includes(id))
          diffs.push({ field: `party.includes[${id}]`, expected: true, actual: false });
      }
    } else {
      const actual = (state as any)[field];
      if (!deepEqualOrNull(actual, expected)) diffs.push({ field, expected, actual });
    }
  }

  return {
    pass: diffs.length === 0,
    detail: diffs.length === 0 ? 'all state assertions passed' : `${diffs.length} diff(s)`,
    diffs,
  };
}
