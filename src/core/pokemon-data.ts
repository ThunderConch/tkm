import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isShinyKey, toBaseId, toShinyKey } from './shiny-utils.js';
import {
  pokemonJsonPath, achievementsJsonPath, regionsJsonPath,
  pokedexRewardsJsonPath, i18nDataDir, getActiveGeneration,
  commonAchievementsJsonPath, commonI18nDir,
  EVENTS_JSON_PATH, SHARED_JSON_PATH,
  GENERATIONS_JSON_PATH,
  // Legacy compat
  POKEMON_JSON_PATH, ACHIEVEMENTS_JSON_PATH, REGIONS_JSON_PATH,
  POKEDEX_REWARDS_JSON_PATH, I18N_DATA_DIR,
} from './paths.js';
import type { PokemonDB, PokemonData, AchievementsDB, RegionsDB, EventsDB, PokedexRewardsDB, GenerationsDB, SharedDB, MetType, MetDetail } from './types.js';
import { getLocale, t } from '../i18n/index.js';

// ── Gen-keyed caches ──
const _pokemonDBCache: Record<string, PokemonDB> = {};
const _achievementsDBCache: Record<string, AchievementsDB> = {};
const _regionsDBCache: Record<string, RegionsDB> = {};
const _pokedexRewardsDBCache: Record<string, PokedexRewardsDB> = {};

// Shared/global caches (not per-gen)
let _eventsDB: EventsDB | null = null;
let _generationsDB: GenerationsDB | null = null;
let _sharedDB: SharedDB | null = null;

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function resolveDataPath(perGenPath: string, legacyPath: string, gen?: string): string {
  if (existsSync(perGenPath)) return perGenPath;
  // Legacy fallback only valid for gen4 (original generation)
  if (gen && gen !== 'gen4') {
    throw new Error(`Missing data file for ${gen}: ${perGenPath}`);
  }
  return legacyPath;
}

export function getSharedDB(): SharedDB {
  if (!_sharedDB) {
    if (existsSync(SHARED_JSON_PATH)) {
      _sharedDB = loadJson<SharedDB>(SHARED_JSON_PATH);
    } else {
      // Fall back: load from legacy pokemon.json which contains these fields
      const legacyDB = loadJson<PokemonDB>(POKEMON_JSON_PATH);
      _sharedDB = {
        type_colors: legacyDB.type_colors,
        type_chart: legacyDB.type_chart,
        rarity_weights: legacyDB.rarity_weights,
      };
    }
  }
  return _sharedDB;
}

export function getGenerationsDB(): GenerationsDB {
  if (!_generationsDB) {
    if (existsSync(GENERATIONS_JSON_PATH)) {
      _generationsDB = loadJson<GenerationsDB>(GENERATIONS_JSON_PATH);
    } else {
      // Default: gen4 only
      _generationsDB = {
        generations: {
          gen4: {
            id: 'gen4',
            name: 'Generation IV',
            region_name: 'Sinnoh',
            pokemon_range: [280, 493],
            starters: ['387', '390', '393'],
            order: 4,
          },
        },
        default_generation: 'gen4',
      };
    }
  }
  return _generationsDB;
}

export function getPokemonDB(gen?: string): PokemonDB {
  const g = gen ?? getActiveGeneration();
  if (!_pokemonDBCache[g]) {
    try {
      const perGen = pokemonJsonPath(g);
      const path = resolveDataPath(perGen, POKEMON_JSON_PATH, g);
      const raw = loadJson<any>(path);
      const shared = getSharedDB();
      // Merge: per-gen pokemon data + shared type data
      _pokemonDBCache[g] = {
        pokemon: { ...raw.pokemon },
        starters: raw.starters ?? getGenerationsDB().generations[g]?.starters ?? [],
        type_colors: raw.type_colors ?? shared.type_colors,
        type_chart: raw.type_chart ?? shared.type_chart,
        rarity_weights: raw.rarity_weights ?? shared.rarity_weights,
      };
      augmentCrossGenPokemonDB(g);
    } catch (err: any) {
      throw new Error(`Failed to load pokemon data for ${g}: ${err.message}`);
    }
  }
  return _pokemonDBCache[g];
}

export function getAchievementsDB(gen?: string): AchievementsDB {
  const g = gen ?? getActiveGeneration();
  if (!_achievementsDBCache[g]) {
    try {
      // Gen-specific achievements only — common achievements are handled separately
      // by checkCommonAchievements() to prevent double-processing of effects
      const perGen = achievementsJsonPath(g);
      const genPath = resolveDataPath(perGen, ACHIEVEMENTS_JSON_PATH, g);
      _achievementsDBCache[g] = loadJson<AchievementsDB>(genPath);
    } catch (err: any) {
      throw new Error(`Failed to load achievements data for ${g}: ${err.message}`);
    }
  }
  return _achievementsDBCache[g];
}

let _commonAchievementsCache: AchievementsDB | null = null;

export function getCommonAchievementsDB(): AchievementsDB {
  if (!_commonAchievementsCache) {
    const path = commonAchievementsJsonPath();
    _commonAchievementsCache = existsSync(path) ? loadJson<AchievementsDB>(path) : { achievements: [] };
  }
  return _commonAchievementsCache;
}

export function getRegionsDB(gen?: string): RegionsDB {
  const g = gen ?? getActiveGeneration();
  if (!_regionsDBCache[g]) {
    try {
      const perGen = regionsJsonPath(g);
      const path = resolveDataPath(perGen, REGIONS_JSON_PATH, g);
      _regionsDBCache[g] = loadJson<RegionsDB>(path);
    } catch (err: any) {
      throw new Error(`Failed to load regions data for ${g}: ${err.message}`);
    }
  }
  return _regionsDBCache[g];
}

export function getEventsDB(): EventsDB {
  if (!_eventsDB) {
    _eventsDB = loadJson<EventsDB>(EVENTS_JSON_PATH);
  }
  return _eventsDB;
}

export function getPokedexRewardsDB(gen?: string): PokedexRewardsDB {
  const g = gen ?? getActiveGeneration();
  if (!_pokedexRewardsDBCache[g]) {
    try {
      const perGen = pokedexRewardsJsonPath(g);
      const path = resolveDataPath(perGen, POKEDEX_REWARDS_JSON_PATH, g);
      _pokedexRewardsDBCache[g] = loadJson<PokedexRewardsDB>(path);
    } catch (err: any) {
      throw new Error(`Failed to load pokedex rewards data for ${g}: ${err.message}`);
    }
  }
  return _pokedexRewardsDBCache[g];
}

// ── Species-to-generation lookup (data-driven) ──

export function speciesIdToGeneration(speciesId: number): string {
  const genDB = getGenerationsDB();
  for (const [genId, genData] of Object.entries(genDB.generations)) {
    const [start, end] = genData.pokemon_range;
    if (speciesId >= start && speciesId <= end) return genId;
  }
  // Fallback to last known gen
  return genDB.default_generation || 'gen9';
}

// ── i18n helpers ──

interface GameI18nData {
  pokemon: Record<string, string>;
  types: Record<string, string>;
  regions: Record<string, { name: string; description: string }>;
  achievements: Record<string, { name: string; description: string; rarity_label: string }>;
}

const _gameI18n: Record<string, GameI18nData> = {};

function i18nCacheKey(locale: string, gen: string): string {
  return `${gen}:${locale}`;
}

export function getGameI18n(locale?: string, gen?: string): GameI18nData {
  const loc = locale || getLocale();
  const g = gen ?? getActiveGeneration();
  const key = i18nCacheKey(loc, g);
  if (!_gameI18n[key]) {
    const perGen = join(i18nDataDir(g), `${loc}.json`);
    const legacy = join(I18N_DATA_DIR, `${loc}.json`);
    const path = resolveDataPath(perGen, legacy, g);
    const data = loadJson<GameI18nData>(path);

    // Merge common i18n achievements (fallback for common achievement names)
    const commonPath = join(commonI18nDir(), `${loc}.json`);
    if (existsSync(commonPath)) {
      try {
        const commonI18n = loadJson<{ achievements: Record<string, string> }>(commonPath);
        if (commonI18n.achievements) {
          for (const [id, name] of Object.entries(commonI18n.achievements)) {
            // Common i18n provides fallback — gen-specific wins if present
            if (!data.achievements[id]) {
              data.achievements[id] = { name } as any;
            }
          }
        }
      } catch { /* ignore common i18n errors */ }
    }

    _gameI18n[key] = data;
  }
  return _gameI18n[key];
}

const NAME_LOOKUP_GENS = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8', 'gen9'];

export function getPokemonName(id: string | number, gen?: string, shiny?: boolean): string {
  const g = gen ?? getActiveGeneration();
  getPokemonDB(g);
  const strId = String(id);
  const baseId = toBaseId(strId);
  let name = getGameI18n(undefined, g).pokemon[baseId];
  if (!name) {
    // Cross-gen fallback: a pokemon may be displayed in an active gen that
    // does not natively index it (e.g. seed data, migration, cross-gen refs).
    // Search other gens' i18n so we surface a real name instead of the ID.
    for (const og of NAME_LOOKUP_GENS) {
      if (og === g) continue;
      try {
        const hit = getGameI18n(undefined, og).pokemon[baseId];
        if (hit) { name = hit; break; }
      } catch {
        // gen's data not installed — skip silently
      }
    }
  }
  if (!name) name = baseId;
  if (shiny || isShinyKey(strId)) return '★' + name;
  return name;
}

/**
 * Resolve a display name, nickname, or ID string to a pokemon ID.
 * Accepts numeric ID strings ("390"), localized names ("불꽃숭이", "Chimchar"),
 * or nicknames set by the user.
 * Delegates to existing pokemonIdByName for locale search.
 * Returns null if no match found.
 */
export function resolveNameToId(nameOrId: string, state?: { pokemon: Record<string, { nickname?: string }> }): string | null {
  const db = getPokemonDB();

  // Shiny prefix detection: "색다른 X", "★X", "shiny X"
  const shinyPrefixes = ['색다른 ', '★', 'shiny '];
  for (const prefix of shinyPrefixes) {
    if (nameOrId.startsWith(prefix)) {
      const baseName = nameOrId.slice(prefix.length);
      const baseId = resolveNameToId(baseName, state);
      return baseId ? toShinyKey(toBaseId(baseId)) : null;
    }
  }

  // Direct ID match (including shiny keys like "460_shiny")
  if (db.pokemon[nameOrId]) return nameOrId;
  if (isShinyKey(nameOrId) && db.pokemon[toBaseId(nameOrId)]) return nameOrId;

  // Search by nickname in owned pokemon state
  if (state) {
    for (const [id, pState] of Object.entries(state.pokemon)) {
      if (pState.nickname && pState.nickname === nameOrId) return id;
    }
  }

  // Delegate to existing locale-aware reverse lookup
  return pokemonIdByName(nameOrId) ?? null;
}

/**
 * Get the display name for a pokemon, preferring nickname over species name.
 */
export function getDisplayName(id: string | number, nickname?: string): string {
  if (nickname) return nickname;
  return getPokemonName(id);
}

export function getTypeName(typeId: string): string {
  const i18n = getGameI18n();
  return i18n.types[typeId] || typeId;
}

export function getRegionName(id: string | number, gen?: string): string {
  const i18n = getGameI18n(undefined, gen);
  return i18n.regions[String(id)]?.name || String(id);
}

export function getRegionDescription(id: string | number, gen?: string): string {
  const i18n = getGameI18n(undefined, gen);
  return i18n.regions[String(id)]?.description || '';
}

export function getAchievementName(id: string, gen?: string): string {
  const i18n = getGameI18n(undefined, gen);
  return i18n.achievements[id]?.name || id;
}

export function getAchievementDescription(id: string, gen?: string): string {
  const i18n = getGameI18n(undefined, gen);
  return i18n.achievements[id]?.description || '';
}

export function getAchievementRarityLabel(id: string, gen?: string): string {
  const i18n = getGameI18n(undefined, gen);
  return i18n.achievements[id]?.rarity_label || '';
}

/**
 * Format MetDetail into a display string like the original Pokémon games.
 * Uses i18n keys: cli.pokedex.met_date, cli.pokedex.met_<type>
 */
export function formatMetInfo(met: MetType, detail?: MetDetail, gen?: string): string {
  if (!detail) return '';

  const region = detail.region ? getRegionName(detail.region, gen) : '???';
  const level = detail.met_level ?? 0;
  const from = detail.from
    ? (met === 'evolution' ? getPokemonName(detail.from) : getAchievementName(detail.from, gen))
    : '???';

  const lines: string[] = [];

  if (detail.met_date) {
    const [y, m, d] = detail.met_date.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    lines.push(t('cli.pokedex.met_date', { year: y, month: getLocale() === 'ko' ? m : months[m - 1], day: d }));
  }

  const key = `cli.pokedex.met_${met}` as const;
  const body = t(key, { region, level, from });
  lines.push(body);

  return lines.join('\n');
}

// Reverse lookup: name (any locale) → pokemon ID string
export function pokemonIdByName(name: string, gen?: string): string | undefined {
  // Shiny prefix detection
  const shinyPrefixes = ['색다른 ', '★', 'shiny '];
  for (const prefix of shinyPrefixes) {
    if (name.startsWith(prefix)) {
      const baseName = name.slice(prefix.length);
      const baseId = pokemonIdByName(baseName, gen);
      return baseId ? toShinyKey(baseId) : undefined;
    }
  }

  // Active generation first, then cross-gen fallback so a localized name
  // from another generation's dex (e.g. "이브이" in a gen4-active save)
  // still resolves.
  const gensToSearch = [gen ?? getActiveGeneration(), ...NAME_LOOKUP_GENS.filter(g => g !== (gen ?? getActiveGeneration()))];
  for (const g of gensToSearch) {
    for (const locale of ['ko', 'en']) {
      try {
        const i18n = getGameI18n(locale, g);
        for (const [id, pokeName] of Object.entries(i18n.pokemon)) {
          if (pokeName === name) return id;
        }
      } catch {
        // Skip gens with no installed data
      }
    }
  }
  return undefined;
}

// Reverse lookup: region name (any locale) → region ID string
export function regionIdByName(name: string, gen?: string): string | undefined {
  for (const locale of ['ko', 'en']) {
    const i18n = getGameI18n(locale, gen);
    for (const [id, region] of Object.entries(i18n.regions)) {
      if (region.name === name) return id;
    }
  }
  return undefined;
}

// ── Cross-generation resolution ──

type CrossGenRef = { gen: string; id: string };

/**
 * Parse a cross-gen reference like "gen1:25" into { gen, id }.
 * Returns null for plain IDs without a colon.
 */
export function parseCrossGenRef(ref: string): CrossGenRef | null {
  const match = ref.match(/^(gen\d+):(.+)$/);
  return match ? { gen: match[1], id: match[2] } : null;
}

function copyPokemonI18n(id: string, sourceGen: string, targetGen: string): void {
  for (const locale of ['ko', 'en'] as const) {
    try {
      const srcI18n = getGameI18n(locale, sourceGen);
      const dstI18n = getGameI18n(locale, targetGen);
      if (srcI18n.pokemon[id]) {
        dstI18n.pokemon[id] = srcI18n.pokemon[id];
      }
    } catch {
      // Locale file may not exist for this generation.
    }
  }
}

function findPokemonSource(id: string, preferredGen?: string): { gen: string; data: PokemonData } | null {
  if (preferredGen) {
    try {
      const preferredDB = getPokemonDB(preferredGen);
      const preferred = preferredDB.pokemon[id];
      if (preferred) return { gen: preferredGen, data: preferred };
    } catch {
      // Fall through to all-generation search.
    }
  }

  const gensDB = getGenerationsDB();
  for (const gen of Object.keys(gensDB.generations)) {
    if (gen === preferredGen) continue;
    try {
      const genDB = getPokemonDB(gen);
      const candidate = genDB.pokemon[id];
      if (candidate) return { gen, data: candidate };
    } catch {
      // Ignore missing generation data and continue searching.
    }
  }

  return null;
}

function injectPokemonIntoGen(
  targetGen: string,
  id: string,
  sourceGen: string,
  sourceData: PokemonData,
  overrides: Partial<PokemonData> = {},
): PokemonData {
  const db = getPokemonDB(targetGen);
  const merged: PokemonData = { ...sourceData, ...overrides };
  db.pokemon[id] = merged;
  copyPokemonI18n(id, sourceGen, targetGen);
  return merged;
}

function mergeEvolutionLine(sourceLine: string[], sourceStage: number, targetData: PokemonData): { line: string[]; stage: number } {
  const prefix = sourceLine.slice(0, sourceStage + 1);
  const suffix = targetData.line[0] === prefix[prefix.length - 1]
    ? targetData.line.slice(1)
    : targetData.line;
  return {
    line: [...prefix, ...suffix],
    stage: prefix.length,
  };
}

function ensureEvolutionTargetInGen(
  activeGen: string,
  sourcePokemonId: string,
  targetRef: CrossGenRef,
): PokemonData | null {
  const db = getPokemonDB(activeGen);
  const sourcePokemon = db.pokemon[sourcePokemonId];
  if (!sourcePokemon) return null;

  const targetSource = findPokemonSource(targetRef.id, targetRef.gen);
  if (!targetSource) return null;

  const mergedLine = mergeEvolutionLine(sourcePokemon.line, sourcePokemon.stage, targetSource.data);
  const targetPokemon = injectPokemonIntoGen(activeGen, targetRef.id, targetSource.gen, targetSource.data, mergedLine);

  if (typeof targetSource.data.evolves_to === 'string') {
    const nextRef = parseCrossGenRef(targetSource.data.evolves_to);
    const nextTarget = nextRef ?? { gen: targetSource.gen, id: targetSource.data.evolves_to };
    ensureEvolutionTargetInGen(activeGen, targetRef.id, nextTarget);
  }

  return targetPokemon;
}

function augmentCrossGenPokemonDB(gen: string): void {
  const db = _pokemonDBCache[gen];
  if (!db) return;

  for (const [id, pokemon] of Object.entries({ ...db.pokemon })) {
    if (typeof pokemon.evolves_to !== 'string') continue;
    const crossRef = parseCrossGenRef(pokemon.evolves_to);
    if (!crossRef) continue;
    ensureEvolutionTargetInGen(gen, id, crossRef);
  }
}

/**
 * Ensure a Pokemon ID is available in the current gen's DB cache.
 * If not found locally, searches all generations and injects the
 * data + i18n into the current gen's caches.
 */
export function ensurePokemonInDB(id: string, preferredGen?: string, gen?: string): PokemonData | null {
  const targetGen = gen ?? getActiveGeneration();
  const db = getPokemonDB(targetGen);
  if (db.pokemon[id]) return db.pokemon[id];

  const source = findPokemonSource(id, preferredGen);
  if (!source) return null;

  return injectPokemonIntoGen(targetGen, id, source.gen, source.data);
}

// ── Cache management ──

export function invalidateGenCache(gen?: string): void {
  if (gen) {
    delete _pokemonDBCache[gen];
    delete _achievementsDBCache[gen];
    delete _regionsDBCache[gen];
    delete _pokedexRewardsDBCache[gen];
    // Clear i18n entries for this gen
    for (const key of Object.keys(_gameI18n)) {
      if (key.startsWith(`${gen}:`)) delete _gameI18n[key];
    }
  } else {
    _resetForTesting();
  }
}

export function _resetForTesting(): void {
  for (const key of Object.keys(_pokemonDBCache)) delete _pokemonDBCache[key];
  for (const key of Object.keys(_achievementsDBCache)) delete _achievementsDBCache[key];
  for (const key of Object.keys(_regionsDBCache)) delete _regionsDBCache[key];
  for (const key of Object.keys(_pokedexRewardsDBCache)) delete _pokedexRewardsDBCache[key];
  _eventsDB = null;
  _generationsDB = null;
  _sharedDB = null;
  _commonAchievementsCache = null;
  for (const key of Object.keys(_gameI18n)) delete _gameI18n[key];
}
