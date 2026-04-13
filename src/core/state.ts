import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { statePath, sessionPath, i18nDataDir, DATA_DIR, SESSION_GEN_MAP_PATH, COMMON_STATE_PATH } from './paths.js';
// Legacy imports for backward compat during migration
import { I18N_DATA_DIR } from './paths.js';
import type { State, Session, PokemonState, PokedexEntry, Notification, Stats, LegendaryPending, SessionGenMap, CommonState } from './types.js';
import { runMigrations } from './migration.js';

const DEFAULT_STATS: Stats = {
  streak_days: 0,
  longest_streak: 0,
  last_active_date: '',
  weekly_xp: 0,
  weekly_battles_won: 0,
  weekly_battles_lost: 0,
  weekly_catches: 0,
  weekly_encounters: 0,
  total_xp_earned: 0,
  total_battles_won: 0,
  total_battles_lost: 0,
  total_catches: 0,
  total_encounters: 0,
  codex_tokens_consumed: 0,
  codex_xp_earned: 0,
  last_reset_week: '',
};

const DEFAULT_STATE: State = {
  pokemon: {},
  unlocked: [],
  achievements: {},
  total_tokens_consumed: 0,
  session_count: 0,
  error_count: 0,
  permission_count: 0,
  evolution_count: 0,
  last_session_id: null,
  xp_bonus_multiplier: 1.0,
  last_session_tokens: {},
  pokedex: {},
  encounter_count: 0,
  catch_count: 0,
  battle_count: 0,
  battle_wins: 0,
  battle_losses: 0,
  items: {},
  cheat_log: [],
  last_battle: null,
  last_tip: null,
  last_drop: null,
  last_achievement: null,
  notifications: [],
  dismissed_notifications: [],
  last_known_regions: 1,
  stats: { ...DEFAULT_STATS },
  events_triggered: [],
  pokedex_milestones_claimed: [],
  type_masters: [],
  legendary_pool: [],
  legendary_pending: [],
  titles: [],
  completed_chains: [],
  star_dismissed: false,
  shiny_encounter_count: 0,
  shiny_catch_count: 0,
  shiny_escaped_count: 0,
};

const DEFAULT_SESSION: Session = {
  session_id: null,
  agent_assignments: [],
  evolution_events: [],
  achievement_events: [],
};

// ── Common State (shared across all generations) ──

const DEFAULT_COMMON_STATE: CommonState = {
  achievements: {},
  encounter_rate_bonus: 0,
  xp_bonus_multiplier: 0,
  items: {},
  max_party_size_bonus: 0,
  session_count: 0,
  total_tokens_consumed: 0,
  battle_count: 0,
  battle_wins: 0,
  catch_count: 0,
  evolution_count: 0,
  error_count: 0,
  permission_count: 0,
  total_gym_badges: 0,
  completed_gym_gens: 0,
  titles: [],
  rare_weight_multiplier: 1.0,
  last_codex_tokens_total: 0,
};

export function readCommonState(): CommonState {
  if (!existsSync(COMMON_STATE_PATH)) {
    return { ...DEFAULT_COMMON_STATE, achievements: {}, items: {} };
  }
  try {
    const raw = readFileSync(COMMON_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CommonState>;
    return {
      ...DEFAULT_COMMON_STATE,
      ...parsed,
      achievements: parsed.achievements ?? {},
      items: parsed.items ?? {},
      titles: parsed.titles ?? [],
      rare_weight_multiplier: parsed.rare_weight_multiplier ?? 1.0,
    };
  } catch {
    return { ...DEFAULT_COMMON_STATE, achievements: {}, items: {}, titles: [], rare_weight_multiplier: 1.0 };
  }
}

export function writeCommonState(state: CommonState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = COMMON_STATE_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, COMMON_STATE_PATH);
}

export function commonStateExists(): boolean {
  return existsSync(COMMON_STATE_PATH);
}

// ── Per-generation State ──

export function getDefaultState(): State {
  return structuredClone(DEFAULT_STATE);
}

export function hydrateState(
  parsed: Partial<State> | null | undefined,
  options: { gen?: string; stateFilePath?: string } = {},
): State {
  if (!parsed) {
    return getDefaultState();
  }

  const result: State = {
    ...getDefaultState(),
    ...parsed,
    pokemon: parsed.pokemon ?? {},
    unlocked: parsed.unlocked ?? [],
    achievements: parsed.achievements ?? {},
    last_session_tokens: parsed.last_session_tokens ?? {},
    pokedex: parsed.pokedex ?? {},
    items: parsed.items ?? {},
    notifications: parsed.notifications ?? [],
    dismissed_notifications: parsed.dismissed_notifications ?? [],
    last_known_regions: parsed.last_known_regions ?? 1,
    stats: { ...DEFAULT_STATS, ...(parsed.stats ?? {}) },
    events_triggered: parsed.events_triggered ?? [],
    pokedex_milestones_claimed: parsed.pokedex_milestones_claimed ?? [],
    type_masters: parsed.type_masters ?? [],
    legendary_pool: parsed.legendary_pool ?? [],
    legendary_pending: parsed.legendary_pending ?? [],
    titles: parsed.titles ?? [],
    completed_chains: parsed.completed_chains ?? [],
    star_dismissed: parsed.star_dismissed ?? false,
  };

  // Migrate per-pokemon fields (friendship, ev, shiny)
  for (const entry of Object.values(result.pokemon)) {
    if (entry.friendship === undefined) (entry as any).friendship = 0;
    if (entry.ev === undefined) (entry as any).ev = 0;
    if (entry.shiny === undefined) (entry as any).shiny = false;
  }

  // Migrate retry_token -> pokeball
  if (result.items.retry_token !== undefined) {
    result.items.pokeball = (result.items.pokeball ?? 0) + (result.items.retry_token ?? 0);
    delete result.items.retry_token;
  }

  // Migrate Korean name keys -> ID keys
  migrateNameToId(result, options.stateFilePath ?? statePath(options.gen), i18nDataDir(options.gen));

  // Version-gated migrations
  runMigrations(result);

  return result;
}

export function readState(gen?: string): State {
  const path = statePath(gen);
  if (!existsSync(path)) {
    return getDefaultState();
  }
  const raw = readFileSync(path, 'utf-8');
  return hydrateState(JSON.parse(raw) as Partial<State>, { gen, stateFilePath: path });
}

function migrateNameToId(state: State, stateFilePath: string, i18nDir: string): State {
  // Skip if already migrated
  if (state.state_version && state.state_version >= 2) return state;

  // Build Korean name -> ID map from i18n/ko.json
  const koI18nPath = join(i18nDir, 'ko.json');
  // Also check legacy path as fallback
  const koPath = existsSync(koI18nPath) ? koI18nPath : join(I18N_DATA_DIR, 'ko.json');
  if (!existsSync(koPath)) {
    state.state_version = 2;
    return state;
  }

  let koData: { pokemon: Record<string, string>; regions: Record<string, { name: string }> };
  try {
    koData = JSON.parse(readFileSync(koPath, 'utf-8'));
  } catch {
    state.state_version = 2;
    return state;
  }

  const nameToId: Record<string, string> = {};
  for (const [id, name] of Object.entries(koData.pokemon)) {
    nameToId[name] = id;
  }

  const regionNameToId: Record<string, string> = {};
  for (const [id, region] of Object.entries(koData.regions)) {
    regionNameToId[region.name] = id;
  }

  // Check if migration is needed (any key in state.pokemon is a Korean name)
  const pokemonKeys = Object.keys(state.pokemon);

  if (pokemonKeys.length === 0) {
    state.state_version = 2;
    return state;
  }

  const needsMigration = pokemonKeys.some(k => nameToId[k] !== undefined);

  if (!needsMigration) {
    // Already ID-based
    state.state_version = 2;
    return state;
  }

  // Create backup (best-effort) using the actual state file path
  try {
    if (existsSync(stateFilePath)) {
      const backupPath = stateFilePath + '.bak';
      writeFileSync(backupPath, readFileSync(stateFilePath, 'utf-8'), 'utf-8');
    }
  } catch { /* backup is best-effort */ }

  // Migrate state.pokemon keys
  const newPokemon: Record<string, PokemonState> = {};
  for (const [key, value] of Object.entries(state.pokemon)) {
    const id = nameToId[key] ?? key;
    newPokemon[id] = value;
  }
  state.pokemon = newPokemon;

  // Migrate state.unlocked (deduplicate)
  state.unlocked = [...new Set(
    state.unlocked.map(name => nameToId[name] ?? name)
  )];

  // Migrate state.pokedex keys
  const newPokedex: Record<string, PokedexEntry> = {};
  for (const [key, value] of Object.entries(state.pokedex)) {
    const id = nameToId[key] ?? key;
    newPokedex[id] = value;
  }
  state.pokedex = newPokedex;

  state.state_version = 2;
  return state;
}

export function writeState(state: State, gen?: string): void {
  const path = statePath(gen);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Prune last_session_tokens to top 20 by value (descending).
 * Sessions present in activeSessionIds (from session-gen-map) are always kept first.
 */
export function pruneSessionTokens(tokens: Record<string, number>, activeSessionIds?: Set<string>): Record<string, number> {
  const entries = Object.entries(tokens);
  if (entries.length <= 20) return tokens;

  // Keep all active sessions (in session-gen-map), fill remaining slots by token count
  const active: Array<[string, number]> = [];
  const inactive: Array<[string, number]> = [];
  for (const entry of entries) {
    if (activeSessionIds?.has(entry[0])) {
      active.push(entry);
    } else {
      inactive.push(entry);
    }
  }

  // Hard cap: keep at most 50 active sessions (by most recent token count)
  active.sort((a, b) => b[1] - a[1]);
  const cappedActive = active.slice(0, 50);

  // Fill remaining slots up to 20 with inactive
  inactive.sort((a, b) => b[1] - a[1]);
  const maxInactive = Math.max(0, 20 - cappedActive.length);
  return Object.fromEntries([...cappedActive, ...inactive.slice(0, maxInactive)]);
}

export function readSession(gen?: string, sessionId?: string): Session {
  const path = sessionPath(gen, sessionId);
  if (!existsSync(path)) {
    return { ...DEFAULT_SESSION, agent_assignments: [], evolution_events: [], achievement_events: [] };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Session>;
  return {
    ...DEFAULT_SESSION,
    ...parsed,
    agent_assignments: parsed.agent_assignments ?? [],
    evolution_events: parsed.evolution_events ?? [],
    achievement_events: parsed.achievement_events ?? [],
  };
}

export function writeSession(session: Session, gen?: string, sessionId?: string): void {
  const path = sessionPath(gen, sessionId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

export function readSessionGenMap(): SessionGenMap {
  if (!existsSync(SESSION_GEN_MAP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SESSION_GEN_MAP_PATH, 'utf-8'));
  } catch { return {}; }
}

export function writeSessionGenMap(map: SessionGenMap): void {
  const dir = dirname(SESSION_GEN_MAP_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = SESSION_GEN_MAP_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf-8');
  renameSync(tmpPath, SESSION_GEN_MAP_PATH);
}

export function pruneSessionGenMap(map: SessionGenMap, maxAgeMs: number = 30 * 24 * 3600 * 1000): SessionGenMap {
  const now = Date.now();
  const result: SessionGenMap = {};
  for (const [id, entry] of Object.entries(map)) {
    const lastSeen = new Date(entry.last_seen || entry.created).getTime();
    if (now - lastSeen < maxAgeMs) result[id] = entry;
  }
  return result;
}
