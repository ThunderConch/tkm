import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { STATE_PATH, SESSION_PATH, I18N_DATA_DIR } from './paths.js';
import type { State, Session, PokemonState, PokedexEntry, Notification } from './types.js';

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
  notifications: [],
  dismissed_notifications: [],
  last_known_regions: 1,
};

const DEFAULT_SESSION: Session = {
  session_id: null,
  agent_assignments: [],
  evolution_events: [],
  achievement_events: [],
};

export function readState(): State {
  if (!existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE, pokemon: {}, unlocked: [], achievements: {}, last_session_tokens: {} };
  }
  const raw = readFileSync(STATE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<State>;
  // Merge with defaults to fill missing fields
  const result: State = {
    ...DEFAULT_STATE,
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
  };

  // Migrate per-pokemon fields (friendship, ev)
  for (const entry of Object.values(result.pokemon)) {
    if (entry.friendship === undefined) (entry as any).friendship = 0;
    if (entry.ev === undefined) (entry as any).ev = 0;
  }

  // Migrate retry_token -> pokeball
  if (result.items.retry_token !== undefined) {
    result.items.pokeball = (result.items.pokeball ?? 0) + (result.items.retry_token ?? 0);
    delete result.items.retry_token;
  }

  // Migrate Korean name keys -> ID keys
  migrateNameToId(result);

  return result;
}

function migrateNameToId(state: State): State {
  // Skip if already migrated
  if (state.state_version && state.state_version >= 2) return state;

  // Build Korean name -> ID map from data/i18n/ko.json
  const koI18nPath = join(I18N_DATA_DIR, 'ko.json');
  if (!existsSync(koI18nPath)) {
    state.state_version = 2;
    return state;
  }

  let koData: { pokemon: Record<string, string>; regions: Record<string, { name: string }> };
  try {
    koData = JSON.parse(readFileSync(koI18nPath, 'utf-8'));
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

  // Create backup (best-effort)
  try {
    if (existsSync(STATE_PATH)) {
      const backupPath = STATE_PATH + '.bak';
      writeFileSync(backupPath, readFileSync(STATE_PATH, 'utf-8'), 'utf-8');
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

export function writeState(state: State): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = STATE_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, STATE_PATH);
}

/**
 * Prune last_session_tokens to top 10 by value (descending).
 */
export function pruneSessionTokens(tokens: Record<string, number>): Record<string, number> {
  const entries = Object.entries(tokens);
  if (entries.length <= 10) return tokens;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, 10));
}

export function readSession(): Session {
  if (!existsSync(SESSION_PATH)) {
    return { ...DEFAULT_SESSION, agent_assignments: [], evolution_events: [], achievement_events: [] };
  }
  const raw = readFileSync(SESSION_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<Session>;
  return {
    ...DEFAULT_SESSION,
    ...parsed,
    agent_assignments: parsed.agent_assignments ?? [],
    evolution_events: parsed.evolution_events ?? [],
    achievement_events: parsed.achievement_events ?? [],
  };
}

export function writeSession(session: Session): void {
  const dir = dirname(SESSION_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = SESSION_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
  renameSync(tmpPath, SESSION_PATH);
}
