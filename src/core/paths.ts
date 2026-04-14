import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { SessionGenMap } from './types.js';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

// Data is always stored in ~/.claude/tokenmon/ regardless of install scope.
// This prevents data splits between local-scope and user-scope installs.
export const DATA_DIR = join(CLAUDE_DIR, 'tokenmon');
export const GLOBAL_CONFIG_PATH = join(DATA_DIR, 'global-config.json');
export const LOCK_PATH = join(DATA_DIR, 'tokenmon.lock');
export const SESSION_GEN_MAP_PATH = join(DATA_DIR, 'session-gen-map.json');
export const COMMON_STATE_PATH = join(DATA_DIR, 'common_state.json');

// Plugin root (where the npm package is installed). `CLAUDE_PLUGIN_ROOT` wins
// when set (Claude Code injects it), otherwise walk up from this module until
// we find a package.json. The old hardcoded `../..` hop worked from
// `src/core/paths.ts` (two levels to project root) but pointed at `dist/`
// when compiled to `dist/core/paths.js`, breaking every downstream data path
// (pokemon data, moves, i18n, sprites, …) for dist-based callers such as the
// friendly-battle daemon spawned from the plugin cache.
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? (() => {
  let dir = import.meta.dirname;
  while (dir && dir !== '/' && !existsSync(join(dir, 'package.json'))) {
    dir = dirname(dir);
  }
  return existsSync(join(dir, 'package.json')) ? dir : join(import.meta.dirname, '..', '..');
})();
export const GENERATIONS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'generations.json');
export const SHARED_JSON_PATH = join(PLUGIN_ROOT, 'data', 'shared.json');
export const EVENTS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'events.json');

// Asset directories (shared across generations — IDs don't collide)
export const CRIES_DIR = join(PLUGIN_ROOT, 'cries');
export const SPRITES_RAW_DIR = join(PLUGIN_ROOT, 'sprites', 'raw');
export const SPRITES_TERMINAL_DIR = join(PLUGIN_ROOT, 'sprites', 'terminal');
export const SPRITES_BRAILLE_DIR = join(PLUGIN_ROOT, 'sprites', 'braille');
export const SPRITES_KITTY_DIR = join(PLUGIN_ROOT, 'sprites', 'kitty');
export const SPRITES_SIXEL_DIR = join(PLUGIN_ROOT, 'sprites', 'sixel');
export const SPRITES_ITERM2_DIR = join(PLUGIN_ROOT, 'sprites', 'iterm2');

// ── Active generation resolution ──

let _activeGenCache: string | null = null;

export function getActiveGeneration(): string {
  if (_activeGenCache) return _activeGenCache;
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const gc = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
      if (gc.active_generation) {
        // Validate against known generations
        const validGen = validateGeneration(gc.active_generation);
        _activeGenCache = validGen;
        if (validGen !== gc.active_generation) {
          // Fix invalid value on disk
          gc.active_generation = validGen;
          writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(gc, null, 2), 'utf-8');
        }
        return _activeGenCache!;
      }
    } catch { /* fall through */ }
  }
  // Read default_generation from generations.json before falling back to 'gen4'
  if (existsSync(GENERATIONS_JSON_PATH)) {
    try {
      const gdb = JSON.parse(readFileSync(GENERATIONS_JSON_PATH, 'utf-8'));
      if (gdb.default_generation) return gdb.default_generation;
    } catch { /* fall through */ }
  }
  return 'gen4'; // ultimate fallback for backward compat
}

function validateGeneration(gen: string): string {
  // Check if data directory exists for this generation
  const genDir = join(PLUGIN_ROOT, 'data', gen);
  if (existsSync(genDir)) return gen;
  // Check generations.json
  if (existsSync(GENERATIONS_JSON_PATH)) {
    try {
      const gdb = JSON.parse(readFileSync(GENERATIONS_JSON_PATH, 'utf-8'));
      if (gdb.generations?.[gen]) return gen;
      // Invalid — fall back to default
      return gdb.default_generation ?? 'gen4';
    } catch { /* fall through */ }
  }
  return 'gen4';
}

export function setActiveGenerationCache(gen: string): void {
  _activeGenCache = gen;
}

export function clearActiveGenerationCache(): void {
  _activeGenCache = null;
}

export function getSessionGeneration(sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    if (existsSync(SESSION_GEN_MAP_PATH)) {
      const map = JSON.parse(readFileSync(SESSION_GEN_MAP_PATH, 'utf-8')) as Record<string, { generation: string }>;
      if (map[sessionId]?.generation) return map[sessionId].generation;
    }
  } catch { /* fall through */ }
  return null;
}

// ── Per-generation data paths (plugin data) ──

export function genDataDir(gen?: string): string {
  const g = gen ?? getActiveGeneration();
  const perGen = join(PLUGIN_ROOT, 'data', g);
  // Legacy flat fallback only valid for gen4 (the original generation)
  if (!existsSync(perGen) && g === 'gen4' && existsSync(join(PLUGIN_ROOT, 'data', 'pokemon.json'))) {
    return join(PLUGIN_ROOT, 'data');
  }
  return perGen;
}

export function pokemonJsonPath(gen?: string): string {
  return join(genDataDir(gen), 'pokemon.json');
}

export function achievementsJsonPath(gen?: string): string {
  return join(genDataDir(gen), 'achievements.json');
}

export function regionsJsonPath(gen?: string): string {
  return join(genDataDir(gen), 'regions.json');
}

export function pokedexRewardsJsonPath(gen?: string): string {
  return join(genDataDir(gen), 'pokedex-rewards.json');
}

export function i18nDataDir(gen?: string): string {
  return join(genDataDir(gen), 'i18n');
}

export function commonAchievementsJsonPath(): string {
  return join(PLUGIN_ROOT, 'data', 'common', 'achievements.json');
}

export function commonI18nDir(): string {
  return join(PLUGIN_ROOT, 'data', 'common', 'i18n');
}

// ── Per-generation user data paths ──

export function genUserDir(gen?: string): string {
  const g = gen ?? getActiveGeneration();
  return join(DATA_DIR, g);
}

export function statePath(gen?: string): string {
  const g = gen ?? getActiveGeneration();
  const perGen = join(genUserDir(g), 'state.json');
  // Legacy fallback ONLY for implicit (no explicit gen) and only if per-gen doesn't exist
  if (!gen && !existsSync(perGen) && existsSync(join(DATA_DIR, 'state.json'))) {
    return join(DATA_DIR, 'state.json');
  }
  return perGen;
}

export function configPath(gen?: string): string {
  const g = gen ?? getActiveGeneration();
  const perGen = join(genUserDir(g), 'config.json');
  if (!gen && !existsSync(perGen) && existsSync(join(DATA_DIR, 'config.json'))) {
    return join(DATA_DIR, 'config.json');
  }
  return perGen;
}

export function sessionPath(gen?: string, sessionId?: string): string {
  const g = gen ?? getActiveGeneration();
  const dir = genUserDir(g);
  if (sessionId) {
    const sessionsDir = join(dir, 'sessions');
    return join(sessionsDir, `${sessionId}.json`);
  }
  // Legacy: no session_id → singleton session.json
  const perGen = join(dir, 'session.json');
  if (!gen && !existsSync(perGen) && existsSync(join(DATA_DIR, 'session.json'))) {
    return join(DATA_DIR, 'session.json');
  }
  return perGen;
}

// ── Backward-compatible constants (resolve to active generation) ──
// These are getters so they resolve lazily at access time.

/** @deprecated Use statePath() instead. Legacy gen4 flat-file path. */
export const LEGACY_STATE_PATH = join(DATA_DIR, 'state.json');

export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const SESSION_PATH = join(DATA_DIR, 'session.json');

// Legacy constants — importers should migrate to function forms
export const POKEMON_JSON_PATH = join(PLUGIN_ROOT, 'data', 'pokemon.json');
export const ACHIEVEMENTS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'achievements.json');
export const REGIONS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'regions.json');
export const POKEDEX_REWARDS_JSON_PATH = join(PLUGIN_ROOT, 'data', 'pokedex-rewards.json');
export const I18N_DATA_DIR = join(PLUGIN_ROOT, 'data', 'i18n');
