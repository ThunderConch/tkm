#!/usr/bin/env -S npx tsx
import * as readline from 'readline';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readState, readCommonState, writeState } from '../core/state.js';
import { readConfig, writeConfig, getDefaultConfig, readGlobalConfig, writeGlobalConfig } from '../core/config.js';
import { getPokemonDB, getAchievementsDB, getCommonAchievementsDB, getAchievementName, getAchievementDescription, getAchievementRarityLabel, getRegionName, getRegionDescription, getPokemonName, getGenerationsDB, invalidateGenCache, pokemonIdByName, resolveNameToId, getDisplayName, formatMetInfo, ensurePokemonInDB } from '../core/pokemon-data.js';
import { levelToXp } from '../core/xp.js';
import { playCry } from '../audio/play-cry.js';
import { getCompletion, getPokedexList, syncPokedexFromUnlocked, getRegionSummary } from '../core/pokedex.js';
import { getBoxList } from '../core/box.js';
import { getCurrentRegion, getRegionList, moveToRegion } from '../core/regions.js';
import { renderGuide, renderGuideIndex } from '../core/guide.js';
import { getEligibleBranches, applyBranchEvolution, applySingleChainEvolution, checkEvolution } from '../core/evolution.js';
import { getActiveNotifications, dismissAll } from '../core/notifications.js';
import { getActiveEvents } from '../core/encounter.js';
import { getEventsDB, getRegionsDB, getPokedexRewardsDB } from '../core/pokemon-data.js';
import { getTypeMasterProgress } from '../core/pokedex-rewards.js';
import { t, initLocale, getLocale } from '../i18n/index.js';
import { withLock, withLockRetry } from '../core/lock.js';
import { getActiveGeneration, setActiveGenerationCache, clearActiveGenerationCache, PLUGIN_ROOT, GLOBAL_CONFIG_PATH, DATA_DIR } from '../core/paths.js';
import { execSync } from 'node:child_process';
import { detectRenderer } from '../core/detect-renderer.js';
import { isShinyKey, toBaseId, toShinyKey } from '../core/shiny-utils.js';
import { readWeatherCache, WEATHER_LABELS, refreshWeatherIfStale, type WeatherCondition } from '../core/weather.js';
import type { ExpGroup, EvolutionContext } from '../core/types.js';

// ANSI color helpers
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const info = (s: string) => console.log(`${CYAN}${s}${RESET}`);
const success = (s: string) => console.log(`${GREEN}${s}${RESET}`);
const warn = (s: string) => console.log(`${YELLOW}${s}${RESET}`);
const error = (s: string) => console.error(`${RED}${s}${RESET}`);
const bold = (s: string) => console.log(`${BOLD}${s}${RESET}`);

/**
 * Parse --flag and --key value pairs from argv.
 * Boolean flags: --caught, --uncaught, --shiny, --summary
 * Value flags: --type fire, --region 1, --rarity rare, --stage 0, --sort level, --search keyword
 */
function parseFilterArgs(
  argv: string[],
  supported: Record<string, 'boolean' | 'value'>,
): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!(key in supported)) continue;
    if (supported[key] === 'boolean') {
      result[key] = true;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      result[key] = argv[++i];
    }
  }
  return result;
}

function resolvePokemonArg(name: string): string {
  const pokemonDB = getPokemonDB();
  if (pokemonDB.pokemon[name]) return name;
  // Support shiny keys (e.g., "460_shiny")
  if (isShinyKey(name) && pokemonDB.pokemon[toBaseId(name)]) return name;
  const id = pokemonIdByName(name);
  return id ?? name;
}

function xpBar(currentXp: number, level: number, group: ExpGroup, blocks: number = 10): string {
  const currLvlXp = levelToXp(level, group);
  const nextLvlXp = levelToXp(level + 1, group);
  const xpInLevel = Math.max(0, currentXp - currLvlXp);
  const xpNeeded = Math.max(1, nextLvlXp - currLvlXp);
  const filled = Math.min(blocks, Math.floor(xpInLevel / xpNeeded * blocks));
  const empty = blocks - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function cmdStatus(): void {
  const config = readConfig();
  const state = readState();
  const pokemonDB = getPokemonDB();

  bold(t('cli.status.title'));
  console.log('');

  if (!config.starter_chosen) {
    warn(t('cli.status.no_starter'));
    info(t('cli.status.starter_hint'));
    console.log('');
  }

  bold(t('cli.status.party_header'));
  if (config.party.length === 0) {
    warn(t('cli.status.party_empty'));
  } else {
    for (const pokemon of config.party) {
      const level = state.pokemon[pokemon]?.level ?? 1;
      const xp = state.pokemon[pokemon]?.xp ?? 0;
      const pData = pokemonDB.pokemon[toBaseId(pokemon)];
      const pokemonId = pData?.id ?? 0;
      const types = pData?.types?.join('/') ?? '';
      const evolvesAt = pData?.evolves_at;
      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      const bar = xpBar(xp, level, expGroup);
      const evolInfo = evolvesAt != null ? t('cli.status.evolves_at', { level: evolvesAt }) : '';

      const isShiny = isShinyKey(pokemon);
      const nickname = state.pokemon[pokemon]?.nickname;
      const displayName = getDisplayName(toBaseId(pokemon), nickname);
      const shinyName = isShiny ? '★' + (nickname ? `${displayName} (${getPokemonName(toBaseId(pokemon))})` : displayName) : (nickname ? `${displayName} (${getPokemonName(toBaseId(pokemon))})` : displayName);
      console.log(`  ${BOLD}${shinyName}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET}`);
      console.log(`  Lv.${level} [${GREEN}${bar}${RESET}] XP: ${xp}${evolInfo}`);
    }
  }

  console.log('');
  bold(t('cli.status.stats_header'));
  console.log(t('cli.status.stat_sessions', { count: state.session_count }));
  console.log(t('cli.status.stat_tokens', { count: formatNumber(state.total_tokens_consumed) }));
  console.log(t('cli.status.stat_errors', { count: state.error_count }));
  console.log(t('cli.status.stat_permissions', { count: state.permission_count }));
  console.log(t('cli.status.stat_evolutions', { count: state.evolution_count }));
  console.log(t('cli.status.stat_encounters', { count: state.encounter_count ?? 0 }));
  console.log(t('cli.status.stat_battles', { count: state.battle_count ?? 0, wins: state.battle_wins ?? 0, losses: state.battle_losses ?? 0 }));
  console.log(t('cli.status.stat_catches', { count: state.catch_count ?? 0 }));

  // Pokedex completion
  const totalPokemon = Object.keys(pokemonDB.pokemon).length;
  const caught = Object.values(state.pokedex ?? {}).filter((e: any) => e.caught).length;
  console.log(t('cli.status.stat_pokedex', { caught, total: totalPokemon, pct: Math.round(caught / totalPokemon * 100) }));

  // Items
  const pokeballs = state.items?.pokeball ?? 0;
  if (pokeballs > 0) console.log(t('cli.status.stat_pokeballs', { count: pokeballs }));

  // Region
  console.log(t('cli.status.stat_region', { region: getRegionName(config.current_region ?? '1') }));

  // Weather
  const gc = readGlobalConfig();
  if (gc.weather_enabled) {
    try {
      const cache = readWeatherCache();
      if (cache && Date.now() - cache.fetched_at < 60 * 60 * 1000) {
        const labels = WEATHER_LABELS[cache.condition as WeatherCondition];
        if (labels) {
          const locale = config.language ?? 'en';
          console.log(`  ${labels.emoji} ${labels[locale] ?? labels.en}`);
        }
      }
    } catch { /* ignore */ }
  }

  // Shiny stats
  if (state.shiny_catch_count > 0) {
    console.log(t('cli.status.stat_shiny_catches', { count: state.shiny_catch_count }));
  }
}

function cmdStarter(choiceArg?: string): void {
  const config = readConfig();
  const state = readState();
  const pokemonDB = getPokemonDB();

  if (config.starter_chosen) {
    warn(t('cli.starter.already_chosen'));
    info(t('cli.starter.current_party', { party: config.party.map(p => getPokemonName(p)).join(', ') }));
    return;
  }

  const starters = pokemonDB.starters;

  // No argument: list options and exit (Claude Code uses AskUserQuestion)
  if (!choiceArg) {
    bold(t('cli.starter.prompt_title'));
    console.log('');
    for (let i = 0; i < starters.length; i++) {
      const s = starters[i];
      const pData = pokemonDB.pokemon[s];
      const types = pData?.types?.join('/') ?? '';
      const pokemonId = pData?.id ?? '?';
      console.log(`  ${i + 1}) ${BOLD}${getPokemonName(s)}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET}`);
    }
    return;
  }

  // Resolve choice: number (1-based index) or pokemon ID
  let chosen: string | undefined;
  const num = parseInt(choiceArg, 10);
  if (!isNaN(num) && num >= 1 && num <= starters.length) {
    chosen = starters[num - 1];
  } else if (starters.includes(choiceArg)) {
    chosen = choiceArg;
  }

  if (!chosen) {
    error(t('cli.starter.invalid_choice'));
    return;
  }

  // Mutation under lock (re-read fresh state)
  const lockResult = withLock(() => {
    const freshConfig = readConfig();
    const freshState = readState();
    const pData = pokemonDB.pokemon[chosen];

    freshConfig.party = [chosen];
    freshConfig.starter_chosen = true;
    writeConfig(freshConfig);

    if (!freshState.pokemon[chosen]) {
      const starterLevel = 5;
      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      freshState.pokemon[chosen] = {
        id: pData?.id ?? 0,
        xp: levelToXp(starterLevel, expGroup),
        level: starterLevel,
        friendship: 0,
        ev: 0,
        met: 'starter',
        met_detail: { region: freshConfig.current_region, met_level: starterLevel, met_date: new Date().toISOString().split('T')[0] },
      };
    }
    if (!freshState.unlocked.includes(chosen)) {
      freshState.unlocked.push(chosen);
    }
    writeState(freshState);
  });

  if (!lockResult.acquired) {
    error(t('cli.lock_busy'));
    process.exit(1);
  }

  success(t('cli.starter.chosen', { pokemon: getPokemonName(chosen) }));
  playCry(chosen);
}

function cmdParty(subcmd: string, pokemon?: string): void {
  if (pokemon) pokemon = resolvePokemonArg(pokemon);
  const config = readConfig();
  const state = readState();
  const pokemonDB = getPokemonDB();

  switch (subcmd) {
    case 'dispatch': {
      if (!pokemon) {
        const current = config.default_dispatch;
        info(t('cli.party.dispatch_current', { current: current ?? t('cli.party.dispatch_auto') }));
        info(t('cli.party.dispatch_usage'));
        return;
      }
      // Fast-path check before lock
      if (!config.party.includes(pokemon)) {
        error(t('cli.party.dispatch_not_in_party', { pokemon }));
        process.exit(1);
      }
      const dispatchResult = withLock(() => {
        const freshConfig = readConfig();
        if (!freshConfig.party.includes(pokemon!)) return 'not_in_party';
        freshConfig.default_dispatch = pokemon!;
        writeConfig(freshConfig);
        return 'ok';
      });
      if (!dispatchResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
      if (dispatchResult.value === 'not_in_party') { error(t('cli.party.dispatch_not_in_party', { pokemon })); process.exit(1); }
      success(t('cli.party.dispatch_set', { pokemon }));
      break;
    }
    case 'add': {
      if (!pokemon) {
        error(t('cli.party.add_usage'));
        process.exit(1);
      }
      // Validation before lock
      if (!state.unlocked.includes(pokemon)) {
        error(t('cli.party.add_not_unlocked', { pokemon }));
        info(t('cli.party.add_unlock_hint'));
        process.exit(1);
      }
      if (config.party.length >= config.max_party_size) {
        error(t('cli.party.add_full', { max: config.max_party_size }));
        process.exit(1);
      }
      if (config.party.includes(pokemon)) {
        warn(t('cli.party.add_already_in', { pokemon }));
        return;
      }
      const addResult = withLock(() => {
        const freshConfig = readConfig();
        if (!freshConfig.party.includes(pokemon!)) {
          freshConfig.party.push(pokemon!);
          writeConfig(freshConfig);
        }
      });
      if (!addResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
      success(t('cli.party.add_success', { pokemon }));
      break;
    }
    case 'remove': {
      if (!pokemon) {
        error(t('cli.party.remove_usage'));
        process.exit(1);
      }
      // Validation before lock
      if (config.party.length <= 1) {
        error(t('cli.party.remove_min'));
        process.exit(1);
      }
      const removeResult = withLock(() => {
        const freshConfig = readConfig();
        freshConfig.party = freshConfig.party.filter(p => p !== pokemon);
        writeConfig(freshConfig);
      });
      if (!removeResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
      success(t('cli.party.remove_success', { pokemon }));
      break;
    }
    case 'swap':
      cmdPartySwap(process.argv[4] ?? '', process.argv[5] ?? '');
      break;
    case 'reorder':
      cmdPartyReorder(process.argv[4] ?? '', process.argv[5] ?? '');
      break;
    case 'suggest':
      cmdPartySuggest();
      break;
    default: {
      // list
      bold(t('cli.party.header'));
      for (const p of config.party) {
        const level = state.pokemon[p]?.level ?? 1;
        const xp = state.pokemon[p]?.xp ?? 0;
        const expGroup: ExpGroup = pokemonDB.pokemon[toBaseId(p)]?.exp_group ?? 'medium_fast';
        const bar = xpBar(xp, level, expGroup);
        const nick = state.pokemon[p]?.nickname;
        const label = nick ? `${nick} (${getPokemonName(p)})` : getPokemonName(p);
        console.log(`  ${BOLD}${label}${RESET} Lv.${level} [${GREEN}${bar}${RESET}]`);
      }
      break;
    }
  }
}

function cmdUnlockList(): void {
  const state = readState();
  const pokemonDB = getPokemonDB();

  bold(t('cli.unlock.header'));
  if (state.unlocked.length === 0) {
    warn(t('cli.unlock.empty'));
    return;
  }
  for (const p of state.unlocked) {
    const level = state.pokemon[p]?.level ?? 1;
    const pokemonId = pokemonDB.pokemon[toBaseId(p)]?.id ?? 0;
    const types = pokemonDB.pokemon[toBaseId(p)]?.types?.join('/') ?? '';
    console.log(`  ${BOLD}${getPokemonName(p)}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET} Lv.${level}`);
  }
}

function cmdAchievements(): void {
  const state = readState();
  const commonState = readCommonState();
  const achDB = getAchievementsDB();
  const commonAchDB = getCommonAchievementsDB();

  // Merge per-gen and common achievements, deduplicate by id
  const seen = new Set<string>();
  const allAchievements: Array<{ id: string }> = [];
  for (const ach of achDB.achievements) {
    if (!seen.has(ach.id)) { seen.add(ach.id); allAchievements.push(ach); }
  }
  for (const ach of commonAchDB.achievements) {
    if (!seen.has(ach.id)) { seen.add(ach.id); allAchievements.push(ach); }
  }

  bold(t('cli.achievements.header'));
  console.log('');

  for (const ach of allAchievements) {
    const achieved = !!state.achievements[ach.id] || !!commonState.achievements[ach.id];
    if (achieved) {
      console.log(`  ${GREEN}✓${RESET} ${BOLD}${getAchievementName(ach.id)}${RESET} ${getAchievementRarityLabel(ach.id)}`);
    } else {
      console.log(`  ${GRAY}○ ${getAchievementName(ach.id)} ${getAchievementRarityLabel(ach.id)}${RESET}`);
    }
    console.log(`    ${GRAY}${getAchievementDescription(ach.id)}${RESET}`);
    console.log('');
  }
}

function cmdConfigSet(key: string, value: string): void {
  if (!key || !value) {
    error(t('cli.config.usage'));
    console.log('');
    info(t('cli.config.keys_header'));
    console.log(t('cli.config.key_tokens_per_xp'));
    console.log(t('cli.config.key_volume'));
    console.log(t('cli.config.key_sprite_enabled'));
    console.log(t('cli.config.key_cry_enabled'));
    console.log(t('cli.config.key_max_party'));
    console.log(t('cli.config.key_peon_ping'));
    console.log('  relay_audio          boolean  Route audio to peon-ping relay (remote environments)');
    console.log('  relay_host           string   Relay server host (default: localhost)');
    console.log('  relay_sound_root     string   Symlink name in PEON_DIR for tokenmon sounds');
    console.log(t('cli.config.key_tips_enabled'));
    console.log(t('cli.config.key_notifications'));
    console.log(t('cli.config.key_pp_enabled'));
    console.log(t('cli.config.help_renderer'));
    console.log(t('cli.config.key_voice_tone'));
    console.log('  weather_location     string   City for weather data (e.g. Seoul)');
    console.log('  weather_enabled      boolean  Enable weather-based type boosts');

    process.exit(1);
  }

  // weather_location is stored in GlobalConfig
  if (key === 'weather_location') {
    const gc = readGlobalConfig();
    gc.weather_location = value;
    writeGlobalConfig(gc);
    success(t('weather.location_set', { location: value }));
    refreshWeatherIfStale(value).catch(() => {});
    return;
  }

  // weather_enabled is stored in GlobalConfig
  if (key === 'weather_enabled') {
    if (value !== 'true' && value !== 'false') {
      error(t('cli.config.bool_error'));
      process.exit(1);
    }
    const gc = readGlobalConfig();
    gc.weather_enabled = value === 'true';
    writeGlobalConfig(gc);
    success(t('cli.config.set_success', { key, value }));
    return;
  }

  // voice_tone is stored in GlobalConfig, not per-gen Config
  if (key === 'voice_tone') {
    const allowed = ['claude', 'pokemon'];
    if (!allowed.includes(value)) {
      error(t('cli.config.allowed_values', { key, values: allowed.join(', ') }));
      process.exit(1);
    }
    const gc = readGlobalConfig();
    gc.voice_tone = value as 'claude' | 'pokemon';
    writeGlobalConfig(gc);
    initLocale(gc.language, gc.voice_tone);
    success(t('cli.config.set_success', { key, value }));
    return;
  }

  const config = readConfig();
  const numericKeys = ['tokens_per_xp', 'max_party_size', 'peon_ping_port'];
  const floatKeys = ['volume', 'xp_bonus_multiplier'];
  const boolKeys = ['sprite_enabled', 'cry_enabled', 'peon_ping_integration', 'relay_audio', 'tips_enabled', 'notifications_enabled', 'pp_enabled'];
  const stringEnumKeys: Record<string, string[]> = {
    sprite_mode: ['all', 'ace_only', 'emoji_all', 'emoji_ace'],
    info_mode:   ['ace_full', 'name_level', 'all_full', 'ace_level'],
    renderer:    ['kitty', 'sixel', 'iterm2', 'braille'],
  };

  // Validation before lock
  if (boolKeys.includes(key) && value !== 'true' && value !== 'false') {
    error(t('cli.config.bool_error'));
    process.exit(1);
  }
  if (key in stringEnumKeys) {
    const allowed = stringEnumKeys[key];
    if (!allowed.includes(value)) {
      error(t('cli.config.allowed_values', { key, values: allowed.join(', ') }));
      process.exit(1);
    }
  }

  const configResult = withLock(() => {
    const freshConfig = readConfig();
    if (numericKeys.includes(key)) {
      (freshConfig as any)[key] = parseInt(value, 10);
    } else if (floatKeys.includes(key)) {
      (freshConfig as any)[key] = parseFloat(value);
    } else if (boolKeys.includes(key)) {
      (freshConfig as any)[key] = value === 'true';
    } else {
      (freshConfig as any)[key] = value;
    }
    writeConfig(freshConfig);
  });
  if (!configResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
  success(t('cli.config.set_success', { key, value }));
}

function cmdPokedex(): void {
  const state = readState();
  const pokemonDB = getPokemonDB();
  syncPokedexFromUnlocked(state);

  const allArgs = process.argv.slice(2);
  // Skip the 'pokedex' command itself
  const cmdArgs = allArgs.slice(1);

  // Parse all flags
  const parsed = parseFilterArgs(cmdArgs, {
    type: 'value', region: 'value', rarity: 'value', stage: 'value',
    caught: 'boolean', uncaught: 'boolean', shiny: 'boolean', summary: 'boolean',
    search: 'value',
  });

  // Summary view mode
  if (parsed.summary) {
    const summary = getRegionSummary(state);
    bold(t('cli.pokedex.summary_title'));
    console.log('');
    let totalCaught = 0, totalAll = 0;
    for (const s of summary) {
      const pct = s.total > 0 ? Math.round(s.caught / s.total * 100) : 0;
      console.log(t('cli.pokedex.summary_row', { region: getRegionName(String(s.regionId)), caught: s.caught, total: s.total, pct }));
      totalCaught += s.caught;
      totalAll += s.total;
    }
    const totalPct = totalAll > 0 ? Math.round(totalCaught / totalAll * 100) : 0;
    console.log('');
    bold(t('cli.pokedex.summary_total', { caught: totalCaught, total: totalAll, pct: totalPct }));
    return;
  }

  // Detail view: first arg (if not a flag) is treated as pokemon name
  const firstArg = cmdArgs[0];
  if (firstArg && !firstArg.startsWith('--') && !parsed.search) {
    // Try to resolve as pokemon name/ID
    const resolved = resolveNameToId(firstArg);
    if (resolved) {
      const pokemonName = resolved;
      const pData = pokemonDB.pokemon[toBaseId(pokemonName)];
      if (pData) {
        const pdex = state.pokedex?.[toBaseId(pokemonName)];
        const statusIcon = pdex?.caught ? `${GREEN}●${RESET}` : pdex?.seen ? `${YELLOW}◐${RESET}` : `${GRAY}○${RESET}`;
        const statusText = pdex?.caught ? t('cli.pokedex.status_caught') : pdex?.seen ? t('cli.pokedex.status_seen') : t('cli.pokedex.status_unknown');

        bold(`=== ${getPokemonName(pokemonName)} (#${pData.id}) ===`);
        console.log('');
        console.log(`  ${t('cli.pokedex.detail_status', { icon: statusIcon, status: statusText })}`);
        console.log(`  ${t('cli.pokedex.detail_type', { types: pData.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join(' / ') })}`);
        console.log(`  ${t('cli.pokedex.detail_rarity', { rarity: pData.rarity })}`);
        console.log(`  ${t('cli.pokedex.detail_region', { region: getRegionName(pData.region) })}`);
        console.log(`  ${t('cli.pokedex.detail_exp_group', { group: pData.exp_group })}`);
        console.log(`  ${t('cli.pokedex.detail_catch_rate', { rate: pData.catch_rate })}`);
        console.log(`  ${t('cli.pokedex.detail_base_stats', { hp: pData.base_stats.hp, atk: pData.base_stats.attack, def: pData.base_stats.defense, spd: pData.base_stats.speed })}`);
        console.log(`  ${t('cli.pokedex.detail_line', { line: pData.line.map((id: string) => getPokemonName(id)).join(' → ') })}`);
        if (pData.evolves_at) console.log(`  ${t('cli.pokedex.detail_evolves_at', { level: pData.evolves_at })}`);
        if (pData.evolves_condition) console.log(`  ${t('cli.pokedex.detail_evolves_cond', { cond: pData.evolves_condition })}`);
        if (pdex?.first_seen) console.log(`  ${t('cli.pokedex.detail_first_seen', { date: pdex.first_seen })}`);
        if (pdex?.shiny_caught) {
          console.log(`  ${t('cli.pokedex.shiny_caught')}`);
        }
        if (state.pokemon[pokemonName]) {
          const ps = state.pokemon[pokemonName];
          console.log(`  ${t('cli.pokedex.detail_current_level', { level: ps.level, xp: formatNumber(ps.xp) })}`);
          if (ps.met) {
            const metText = formatMetInfo(ps.met, ps.met_detail);
            if (metText) {
              console.log('');
              console.log(`    ${t('cli.pokedex.trainer_memo')}`);
              for (const line of metText.split('\n')) {
                console.log(`    ${line}`);
              }
            }
          }
        }
        return;
      }
    }
    // Not a known pokemon — show error
    error(t('cli.pokedex.not_found', { name: firstArg }));
    process.exit(1);
  }

  // Build filter object
  const filters: import('../core/pokedex.js').PokedexFilter = {};
  if (parsed.type) filters.type = parsed.type as string;
  if (parsed.region) filters.region = parsed.region as string;
  if (parsed.rarity) filters.rarity = parsed.rarity as string;
  if (parsed.stage !== undefined) {
    const stageNum = Number(parsed.stage);
    if (![0, 1, 2].includes(stageNum)) {
      error('--stage must be 0, 1, or 2.');
      process.exit(1);
    }
    filters.stage = stageNum;
  }
  if (parsed.caught && parsed.uncaught) {
    error('Cannot use --caught and --uncaught together.');
    process.exit(1);
  }
  if (parsed.caught) filters.status = 'caught';
  else if (parsed.uncaught) filters.status = 'uncaught';
  if (parsed.shiny) filters.shiny = true;
  if (parsed.search) filters.keyword = parsed.search as string;

  // List view
  const completion = getCompletion(state);
  const list = getPokedexList(state, Object.keys(filters).length > 0 ? filters : undefined);

  bold(t('cli.pokedex.list_title'));
  console.log(t('cli.pokedex.list_summary', { seen: completion.seen, caught: completion.caught, total: completion.total, seenPct: completion.seenPct, caughtPct: completion.caughtPct }));
  console.log('');

  // Show active filter description
  const filterParts: string[] = [];
  if (filters.type) filterParts.push(`type=${filters.type}`);
  if (filters.region) filterParts.push(`region=${filters.region}`);
  if (filters.rarity) filterParts.push(`rarity=${filters.rarity}`);
  if (filters.stage !== undefined) filterParts.push(t('cli.pokedex.filter_stage', { stage: filters.stage }));
  if (filters.status === 'caught') filterParts.push(t('cli.pokedex.filter_caught'));
  if (filters.status === 'uncaught') filterParts.push(t('cli.pokedex.filter_uncaught'));
  if (filters.shiny) filterParts.push(t('cli.pokedex.filter_shiny'));
  if (filters.keyword) filterParts.push(t('cli.pokedex.filter_search', { keyword: filters.keyword }));
  if (filterParts.length > 0) info(t('cli.pokedex.filter', { filter: filterParts.join(', ') }));

  if (list.length === 0) {
    console.log(t('cli.pokedex.no_results'));
    return;
  }

  for (const entry of list) {
    const icon = entry.status === 'caught' ? `${GREEN}●${RESET}`
      : entry.status === 'seen' ? `${YELLOW}◐${RESET}`
      : `${GRAY}○${RESET}`;
    const typeStr = entry.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join('/');
    const nameDisplay = entry.status === 'unknown' ? `${GRAY}???${RESET}` : getPokemonName(entry.name);
    const shinyTag = entry.shinyCaught ? ` ${YELLOW}★${RESET}` : '';
    console.log(`  ${icon} #${String(entry.id).padStart(4, '0')} ${nameDisplay.padEnd(8)} ${typeStr} ${GRAY}${entry.rarity}${RESET}${shinyTag}`);
  }

  // Show type master progress when --type filter is used or list is unfiltered
  if (filters.type || Object.keys(filters).length === 0) {
    console.log('');
    bold(t('cli.pokedex.type_master_header'));
    const progress = getTypeMasterProgress(state);
    const typeColors = pokemonDB.type_colors;
    for (const entry of progress) {
      const color = typeColors[entry.type] ?? '';
      if (entry.mastered) {
        console.log(t('cli.pokedex.type_mastered', { type: `${color}${entry.type}${RESET}` }));
      } else {
        const pct = entry.total > 0 ? Math.round(entry.caught / entry.total * 100) : 0;
        console.log(t('cli.pokedex.type_progress', { type: `${color}${entry.type}${RESET}`, caught: entry.caught, total: entry.total, pct }));
      }
    }
  }
}

function cmdItems(): void {
  const state = readState();
  bold(t('cli.items.header'));
  const items = state.items ?? {};
  if (Object.keys(items).length === 0) {
    warn(t('cli.items.empty'));
    return;
  }
  const itemNames: Record<string, string> = { pokeball: t('cli.items.pokeball') };
  for (const [key, count] of Object.entries(items)) {
    if (count > 0) {
      console.log(t('cli.items.count', { name: itemNames[key] ?? key, count }));
    }
  }
}

function cmdRegion(subcmd?: string, regionName?: string): void {
  const state = readState();
  const config = readConfig();
  syncPokedexFromUnlocked(state);

  if (subcmd === 'move' && regionName) {
    const moveResult = withLock(() => {
      const freshState = readState();
      const freshConfig = readConfig();
      syncPokedexFromUnlocked(freshState);
      const err = moveToRegion(regionName!, freshState, freshConfig);
      if (err) return { ok: false as const, error: err };
      writeConfig(freshConfig);
      return { ok: true as const };
    });
    if (!moveResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
    if (!moveResult.value.ok) { error(moveResult.value.error); process.exit(1); }
    success(t('cli.region.moved', { region: regionName }));
    return;
  }

  if (subcmd === 'list') {
    const regions = getRegionList(state);
    bold(t('cli.region.list_title'));
    console.log('');
    for (const { region, unlocked } of regions) {
      const icon = unlocked ? `${GREEN}●${RESET}` : `${GRAY}○${RESET}`;
      const current = config.current_region === String(region.id) ? ` ${YELLOW}${t('cli.region.current_marker')}${RESET}` : '';
      const lockInfo = !unlocked && region.unlock_condition
        ? ` ${GRAY}(${region.unlock_condition.type === 'pokedex_caught' ? t('cli.region.lock_caught') : t('cli.region.lock_seen')} ${t('cli.region.lock_species_needed', { count: region.unlock_condition.value })})${RESET}`
        : '';
      console.log(`  ${icon} ${BOLD}${getRegionName(region.id)}${RESET} Lv.${region.level_range[0]}-${region.level_range[1]}${current}${lockInfo}`);
      console.log(`    ${GRAY}${getRegionDescription(region.id)} ${t('cli.region.pool_species', { count: region.pokemon_pool.length })}${RESET}`);
    }
    return;
  }

  // Default: show current region
  const region = getCurrentRegion(config);
  bold(t('cli.region.current_title', { name: getRegionName(region.id) }));
  console.log(`  ${getRegionDescription(region.id)}`);
  console.log(t('cli.region.level_range', { min: region.level_range[0], max: region.level_range[1] }));
  console.log(t('cli.region.pokemon_pool', { count: region.pokemon_pool.length }));
  console.log('');
  const pokemonDB = getPokemonDB();
  for (const name of region.pokemon_pool) {
    const pData = pokemonDB.pokemon[name];
    if (!pData) continue;
    const pdex = state.pokedex?.[name];
    const icon = pdex?.caught ? `${GREEN}●${RESET}` : pdex?.seen ? `${YELLOW}◐${RESET}` : `${GRAY}○${RESET}`;
    const typeStr = pData.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join('/');
    const nameDisplay = pdex?.seen ? name : `${GRAY}???${RESET}`;
    console.log(`  ${icon} ${nameDisplay} ${typeStr} ${GRAY}${pData.rarity}${RESET}`);
  }
}

const CALLS_PER_EV = 5;

function cmdCall(nameOrId: string): void {
  // Resolve ID and mutate inside the same lock to prevent nickname race
  const result = withLockRetry(() => {
    const s = readState();
    const id = resolveNameToId(nameOrId, s);
    if (!id) return { error: 'not_found' as const };
    const p = s.pokemon[id];
    if (!p) return { error: 'not_found' as const };
    const prevEv = p.ev ?? 0;
    p.call_count = (p.call_count ?? 0) + 1;
    let evGained = false;
    if (p.call_count >= CALLS_PER_EV) {
      p.ev = Math.min(252, prevEv + 1);
      p.call_count = 0;
      evGained = p.ev > prevEv;
    }
    writeState(s);
    return { ev: p.ev, call_count: p.call_count, evGained };
  });
  if (!result.acquired) { error(t('cli.lock_failed')); process.exit(1); }
  if ('error' in result.value) { error(t('cli.call.not_found', { name: nameOrId })); process.exit(1); }
  console.log(JSON.stringify(result.value));
}

function cmdNickname(nameOrId: string, nickname?: string): void {
  // Resolve ID and mutate inside the same lock to prevent nickname race
  const result = withLockRetry(() => {
    const s = readState();
    const id = resolveNameToId(nameOrId, s);
    if (!id || !s.pokemon[id]) return { error: 'not_found' as const };
    if (!nickname) {
      return { current: s.pokemon[id].nickname, speciesName: getPokemonName(id) };
    }
    if ([...nickname].length > 7) return { error: 'too_long' as const };
    s.pokemon[id].nickname = nickname;
    writeState(s);
    return { set: true, speciesName: getPokemonName(id), nickname };
  });
  if (!result.acquired) {
    error(t('cli.lock_failed'));
    process.exit(1);
  }
  if ('error' in result.value) {
    if (result.value.error === 'too_long') {
      error(t('cli.nickname.too_long'));
    } else {
      error(t('cli.nickname.not_found', { name: nameOrId }));
    }
    process.exit(1);
  }
  if ('current' in result.value) {
    const current = result.value.current;
    if (current) {
      info(t('cli.nickname.current', { species: result.value.speciesName, nickname: `${BOLD}${current}${RESET}` }));
    } else {
      info(t('cli.nickname.none', { species: result.value.speciesName }));
    }
  } else if ('set' in result.value) {
    success(t('cli.nickname.set', { species: result.value.speciesName, nickname: `${BOLD}${result.value.nickname}${RESET}` }));
  }
}

function cmdReset(confirm: boolean): void {
  if (!confirm) {
    warn(t('cli.reset.warning'));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(t('cli.reset.confirm'), (answer: string) => {
      rl.close();
      if (answer.toLowerCase() === 'y') {
        doReset();
      } else {
        info(t('cli.reset.cancelled'));
      }
    });
    return;
  }
  doReset();
}

function doReset(): void {
  const resetResult = withLock(() => {
    const state = readState();
    const cheatLog = state.cheat_log ?? []; // preserve cheat log
    const defaultConfig = getDefaultConfig();
    writeConfig(defaultConfig);

    const defaultState: any = {
      pokemon: {}, unlocked: [], achievements: {},
      total_tokens_consumed: 0, session_count: 0, error_count: 0,
      permission_count: 0, evolution_count: 0, last_session_id: null,
      xp_bonus_multiplier: 1.0, last_session_tokens: {}, pokedex: {},
      encounter_count: 0, catch_count: 0, battle_count: 0,
      battle_wins: 0, battle_losses: 0, items: {}, cheat_log: cheatLog,
      last_battle: null, last_tip: null,
      notifications: [], dismissed_notifications: [], last_known_regions: 1,
      stats: {
        streak_days: 0, longest_streak: 0, last_active_date: '',
        weekly_xp: 0, weekly_battles_won: 0, weekly_battles_lost: 0,
        weekly_catches: 0, weekly_encounters: 0,
        total_xp_earned: 0, total_battles_won: 0, total_battles_lost: 0,
        total_catches: 0, total_encounters: 0, last_reset_week: '',
      },
      events_triggered: [],
      pokedex_milestones_claimed: [], type_masters: [],
      legendary_pool: [], legendary_pending: [], titles: [],
      completed_chains: [],
      star_dismissed: false,
    };
    writeState(defaultState);
  });
  if (!resetResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
  success(t('cli.reset.done'));
}

function cmdCheat(subcmd: string, arg1?: string, arg2?: string): void {
  const pokemonDB = getPokemonDB();

  // Validation before lock (no state reads needed for input validation)
  switch (subcmd) {
    case 'xp':
      if (!arg1 || !arg2) { error(t('cli.cheat.xp_usage')); return; }
      break;
    case 'level':
      if (!arg1 || !arg2) { error(t('cli.cheat.level_usage')); return; }
      break;
    case 'unlock':
      if (!arg1) { error(t('cli.cheat.unlock_usage')); return; }
      if (!pokemonDB.pokemon[arg1]) { error(t('cli.cheat.unlock_not_found', { pokemon: arg1 })); return; }
      break;
    case 'achievement':
      if (!arg1) { error(t('cli.cheat.achievement_usage')); return; }
      break;
    case 'item':
      if (!arg1 || !arg2) { error(t('cli.cheat.item_usage')); return; }
      break;
    case 'multiplier':
      if (!arg1) { error(t('cli.cheat.multiplier_usage')); return; }
      break;
    default:
      error(t('cli.cheat.unknown'));
      return;
  }

  const cheatResult = withLock(() => {
    const state = readState();

    function logCheat(cmd: string) {
      if (!state.cheat_log) state.cheat_log = [];
      state.cheat_log.push({ timestamp: new Date().toISOString(), command: cmd });
    }

    switch (subcmd) {
      case 'xp': {
        const amount = parseInt(arg2!, 10);
        if (!state.pokemon[arg1!]) { return t('cli.cheat.no_pokemon', { name: arg1 }); }
        state.pokemon[arg1!].xp += amount;
        logCheat(`xp ${arg1} ${amount}`);
        writeState(state);
        return t('cli.cheat.xp_added', { name: arg1, amount, total: state.pokemon[arg1!].xp });
      }
      case 'level': {
        const level = parseInt(arg2!, 10);
        if (!state.pokemon[arg1!]) { return t('cli.cheat.no_pokemon', { name: arg1 }); }
        state.pokemon[arg1!].level = level;
        logCheat(`level ${arg1} ${level}`);
        writeState(state);
        return t('cli.cheat.level_set', { name: arg1, level });
      }
      case 'unlock': {
        const pData = pokemonDB.pokemon[arg1!];
        if (!state.unlocked.includes(arg1!)) state.unlocked.push(arg1!);
        if (!state.pokemon[arg1!]) {
          state.pokemon[arg1!] = {
            id: pData.id, xp: 0, level: 1, friendship: 0, ev: 0,
            met: 'unknown',
            met_detail: { met_level: 1, met_date: new Date().toISOString().split('T')[0] },
          };
        }
        if (!state.pokedex[arg1!]) state.pokedex[arg1!] = { seen: true, caught: true, first_seen: new Date().toISOString().split('T')[0] };
        else { state.pokedex[arg1!].seen = true; state.pokedex[arg1!].caught = true; }
        logCheat(`unlock ${arg1}`);
        writeState(state);
        return t('cli.cheat.unlocked', { name: arg1 });
      }
      case 'achievement': {
        state.achievements[arg1!] = true;
        logCheat(`achievement ${arg1}`);
        writeState(state);
        return t('cli.cheat.achievement_unlocked', { name: arg1 });
      }
      case 'item': {
        const count = parseInt(arg2!, 10);
        if (!state.items) state.items = {};
        state.items[arg1!] = (state.items[arg1!] ?? 0) + count;
        logCheat(`item ${arg1} ${count}`);
        writeState(state);
        return t('cli.cheat.item_added', { name: arg1, count, total: state.items[arg1!] });
      }
      case 'multiplier': {
        state.xp_bonus_multiplier = parseFloat(arg1!);
        logCheat(`multiplier ${arg1}`);
        writeState(state);
        return t('cli.cheat.xp_multiplier_set', { value: arg1 });
      }
      default:
        return null;
    }
  });

  if (!cheatResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
  if (typeof cheatResult.value === 'string' && cheatResult.value === t('cli.cheat.no_pokemon', { name: arg1 })) {
    error(cheatResult.value);
  } else if (cheatResult.value) {
    success(cheatResult.value);
  }
}

function cmdEvolve(pokemonArg?: string, targetArg?: string): void {
  if (pokemonArg) pokemonArg = resolvePokemonArg(pokemonArg);
  // Also resolve the target so the user (or Claude) may pass a localized name
  // (e.g., "샤미드") instead of the numeric ID — branch.name values in the
  // database are IDs, so the downstream string-equal comparison needs the ID.
  if (targetArg) targetArg = resolvePokemonArg(targetArg);
  const config = readConfig();
  const state = readState();
  const pokemonDB = getPokemonDB();

  // No args: list all evolution-ready pokemon in party
  if (!pokemonArg) {
    const ready = config.party.filter(p => state.pokemon[p]?.evolution_ready);
    if (ready.length === 0) {
      info(t('cli.evolve.none_ready'));
      return;
    }
    bold(t('cli.evolve.ready_header'));
    for (const p of ready) {
      const opts = state.pokemon[p].evolution_options ?? [];
      console.log(`  ${BOLD}${getPokemonName(p)}${RESET} → ${opts.map(o => getPokemonName(o)).join(' / ')}`);
    }
    console.log('');
    info(t('cli.evolve.usage_hint'));
    return;
  }

  // Validate pokemon
  const pState = state.pokemon[pokemonArg];
  if (!pState) {
    error(t('cli.evolve.not_found', { pokemon: pokemonArg }));
    return;
  }
  if (!pState.evolution_ready) {
    warn(t('cli.evolve.not_ready', { pokemon: getPokemonName(pokemonArg) }));
    return;
  }

  const ctx: EvolutionContext = {
    oldLevel: pState.level - 1,
    newLevel: pState.level,
    friendship: pState.friendship ?? 0,
    currentRegion: config.current_region ?? '1',
    unlockedAchievements: Object.keys(state.achievements).filter(k => state.achievements[k]),
    items: state.items ?? {},
  };

  // Single-chain path: data.evolves_to is a string (or legacy line[stage+1]).
  // cmdEvolve originally only handled branch evolutions, so single-chain
  // pokemon reached the AskUserQuestion prompt from the Stop-hook block but
  // could not actually complete the evolve. Route single-chain through
  // checkEvolution (no state → returns an EvolutionResult with the resolved
  // target) and then executeEvolve's dispatcher, which calls
  // applySingleChainEvolution.
  const baseData = pokemonDB.pokemon[toBaseId(pokemonArg)] ?? ensurePokemonInDB(toBaseId(pokemonArg));
  if (baseData && !Array.isArray(baseData.evolves_to)) {
    const result = checkEvolution(pokemonArg, ctx);
    if (!result) {
      warn(t('cli.evolve.no_eligible', { pokemon: getPokemonName(pokemonArg) }));
      return;
    }
    if (targetArg && targetArg !== result.newPokemon) {
      error(t('cli.evolve.invalid_target', { target: targetArg }));
      return;
    }
    executeEvolve(pokemonArg, result.newPokemon, config);
    return;
  }

  const branches = getEligibleBranches(pokemonArg, ctx);
  // UX-only: hide branches whose evolved form is already in unlocked (safety guards are in checkEvolution/applyBranchEvolution)
  const eligible = branches.filter(b => {
    const evolvedKey = isShinyKey(pokemonArg) ? toShinyKey(b.name) : b.name;
    return b.conditionMet && !state.unlocked.includes(evolvedKey);
  });

  if (eligible.length === 0) {
    warn(t('cli.evolve.no_eligible', { pokemon: getPokemonName(pokemonArg) }));
    return;
  }

  // Direct evolution with target specified
  if (targetArg) {
    const branch = eligible.find(b => b.name === targetArg);
    if (!branch) {
      error(t('cli.evolve.invalid_target', { target: targetArg }));
      return;
    }
    executeEvolve(pokemonArg, targetArg, config);
    return;
  }

  // Show eligible branches only (ineligible branches not shown to avoid confusion)
  bold(t('cli.evolve.select_header', { pokemon: getPokemonName(pokemonArg) }));
  console.log('');
  for (let i = 0; i < eligible.length; i++) {
    const b = eligible[i];
    const targetData = pokemonDB.pokemon[b.name];
    const types = targetData?.types?.join('/') ?? '';
    console.log(`  ${i + 1}) ${BOLD}${getPokemonName(b.name)}${RESET} ${GRAY}${types}${RESET}`);
    console.log(`     ${GRAY}${t('cli.evolve.condition', { cond: b.conditionLabel })}${RESET}`);
  }
  // Show ineligible branches as info
  const ineligible = branches.filter(b => !b.conditionMet);
  if (ineligible.length > 0) {
    console.log('');
    for (const b of ineligible) {
      console.log(`  ${GRAY}✗ ${getPokemonName(b.name)} — ${t('cli.evolve.condition', { cond: b.conditionLabel })}${RESET}`);
    }
  }
  console.log('');

  if (eligible.length === 1) {
    // Single eligible — confirm
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(t('cli.evolve.confirm', { target: getPokemonName(eligible[0].name) }), (answer: string) => {
      rl.close();
      if (answer.toLowerCase() === 'y') {
        executeEvolve(pokemonArg!, eligible[0].name, config);
      } else {
        info(t('cli.evolve.cancelled'));
      }
    });
  } else {
    // Multiple eligible — select by number
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(t('cli.evolve.prompt_select', { count: eligible.length }), (answer: string) => {
      rl.close();
      const idx = parseInt(answer, 10);
      if (isNaN(idx) || idx < 1 || idx > eligible.length) {
        error(t('cli.evolve.invalid_choice'));
        process.exit(1);
      }
      executeEvolve(pokemonArg!, eligible[idx - 1].name, config);
    });
  }
}

function executeEvolve(pokemonName: string, targetName: string, _config: unknown): void {
  const evolveResult = withLock(() => {
    const freshState = readState();
    const freshConfig = readConfig();
    const db = getPokemonDB();
    const data = db.pokemon[toBaseId(pokemonName)];

    let result = null;
    if (data && Array.isArray(data.evolves_to)) {
      // Branch evolution (e.g., Kirlia -> Gardevoir/Gallade)
      result = applyBranchEvolution(freshState, freshConfig, pokemonName, targetName);
    } else {
      // Single-chain evolution (e.g., Turtwig -> Grotle)
      result = applySingleChainEvolution(freshState, freshConfig, pokemonName, targetName);
    }

    if (!result) return { ok: false as const };

    // Clear evolution_prompt_shown on the new pokemon key (if carried over)
    const newKey = isShinyKey(pokemonName) ? toShinyKey(result.newPokemon) : result.newPokemon;
    if (freshState.pokemon[newKey]) {
      freshState.pokemon[newKey].evolution_prompt_shown = undefined;
    }

    writeState(freshState);
    writeConfig(freshConfig);
    return { ok: true as const, result };
  });

  if (!evolveResult.acquired) {
    error(t('cli.lock_failed'));
    process.exit(1);
  }
  if (!evolveResult.value.ok) {
    error(t('cli.evolve.failed'));
    return;
  }

  const { result } = evolveResult.value;
  success(t('cli.evolve.success', { old: getPokemonName(result.oldPokemon), new: getPokemonName(result.newPokemon) }));
  playCry(result.newPokemon);
}

function cmdNotifications(subcmd?: string): void {
  const state = readState();

  if (subcmd === 'clear') {
    const clearResult = withLock(() => {
      const freshState = readState();
      dismissAll(freshState);
      writeState(freshState);
    });
    if (!clearResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
    success(t('cli.notifications.cleared'));
    return;
  }

  // List active notifications
  const active = getActiveNotifications(state);
  bold(t('cli.notifications.header'));
  if (active.length === 0) {
    info(t('cli.notifications.empty'));
    return;
  }

  const icons: Record<string, string> = {
    evolution_ready: '✨',
    region_unlocked: '🗺️',
    achievement_near: '🏆',
  };
  for (const n of active) {
    const icon = icons[n.type] ?? '📢';
    console.log(`  ${icon} ${n.message}`);
  }
  console.log('');
  info(t('cli.notifications.clear_hint'));
}

function cmdGuide(topic?: string): void {
  if (!topic) {
    renderGuideIndex();
  } else {
    renderGuide(topic);
  }
}

function cmdDashboard(): void {
  const state = readState();
  const config = readConfig();
  const pokemonDB = getPokemonDB();
  const events = getActiveEvents(state);
  const locale = getLocale();

  // Region info
  const region = getCurrentRegion(config);
  const regionName = region ? getRegionName(config.current_region) : '—';
  const [minLv, maxLv] = region?.level_range ?? [1, 10];

  // Pokedex
  const totalPokemon = Object.keys(pokemonDB.pokemon).length;
  const caughtCount = Object.values(state.pokedex).filter(e => e.caught).length;
  const caughtPct = totalPokemon > 0 ? ((caughtCount / totalPokemon) * 100).toFixed(1) : '0.0';

  // Width
  const W = 40;
  const hr = '═'.repeat(W);
  const pad = (s: string, len: number) => {
    // Strip ANSI for length calc
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
    const diff = len - stripped.length;
    return diff > 0 ? s + ' '.repeat(diff) : s;
  };
  const row = (s: string) => {
    console.log(`║  ${pad(s, W - 4)}  ║`);
  };

  console.log(`╔${hr}╗`);
  row(t('cli.dashboard.region', { region: regionName, min: minLv, max: maxLv }));
  row(t('cli.dashboard.streak', { days: state.stats.streak_days, best: state.stats.longest_streak }));
  row(t('cli.dashboard.pokedex', { caught: caughtCount, total: totalPokemon, pct: caughtPct }));
  console.log(`╠${hr}╣`);

  // Party
  row(t('cli.dashboard.party_title'));
  if (config.party.length === 0) {
    row(t('cli.dashboard.party_empty'));
  } else {
    for (const name of config.party) {
      const p = state.pokemon[name];
      if (!p) continue;
      const pName = getPokemonName(name);
      const level = p.level;
      const pData = pokemonDB.pokemon[toBaseId(name)];
      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      const bar = xpBar(p.xp, level, expGroup, 10);
      const currLvlXp = levelToXp(level, expGroup);
      const nextLvlXp = levelToXp(level + 1, expGroup);
      const xpNeeded = Math.max(1, nextLvlXp - currLvlXp);
      const xpInLevel = Math.max(0, p.xp - currLvlXp);
      const pct = Math.min(100, Math.floor((xpInLevel / xpNeeded) * 100));
      row(`${pName}  Lv.${level}  ${bar}  ${pct}%`);
    }
  }
  console.log(`╠${hr}╣`);

  // Recent activity (weekly stats)
  row(t('cli.dashboard.activity_title'));
  row(t('cli.dashboard.activity_xp', { xp: state.stats.weekly_xp.toLocaleString() }));
  const bTotal = state.stats.weekly_battles_won + state.stats.weekly_battles_lost;
  row(t('cli.dashboard.activity_battles', { total: bTotal, wins: state.stats.weekly_battles_won, losses: state.stats.weekly_battles_lost }));
  row(t('cli.dashboard.activity_catches', { count: state.stats.weekly_catches }));
  row(t('cli.dashboard.activity_encounters', { count: state.stats.weekly_encounters }));

  // Active notifications
  const notifs = getActiveNotifications(state);
  for (const n of notifs) {
    row(`• ${n.message}`);
  }
  console.log(`╠${hr}╣`);

  // Active events
  row(t('cli.dashboard.events_title'));
  const allEvents = [
    ...events.timeEvents.map(e => e.label[locale] ?? e.label.en),
    ...events.dayEvents.map(e => e.label[locale] ?? e.label.en),
    ...events.streakEvents.map(e => e.label[locale] ?? e.label.en),
    ...events.weatherEvents.map(e => `${e.emoji} ${e.label[locale] ?? e.label.en}`),
  ];
  if (allEvents.length === 0) {
    row(t('cli.dashboard.events_none'));
  } else {
    for (const label of allEvents) {
      row(label);
    }
  }
  console.log(`╚${hr}╝`);
}

function cmdStats(): void {
  const state = readState();
  const stats = state.stats;

  bold(t('cli.stats.header'));
  console.log('');

  // Streak
  info(t('cli.stats.streak_header'));
  console.log(t('cli.stats.streak_days', { days: stats.streak_days }));
  console.log(t('cli.stats.streak_best', { days: stats.longest_streak }));
  console.log('');

  // Weekly
  info(t('cli.stats.weekly_header'));
  console.log(t('cli.stats.weekly_xp', { xp: stats.weekly_xp.toLocaleString() }));
  console.log(t('cli.stats.weekly_battles', { wins: stats.weekly_battles_won, losses: stats.weekly_battles_lost }));
  console.log(t('cli.stats.weekly_catches', { count: stats.weekly_catches }));
  console.log(t('cli.stats.weekly_encounters', { count: stats.weekly_encounters }));
  console.log('');

  // All-time
  info(t('cli.stats.alltime_header'));
  console.log(t('cli.stats.alltime_xp', { xp: stats.total_xp_earned.toLocaleString() }));
  console.log(t('cli.stats.alltime_battles', { wins: stats.total_battles_won, losses: stats.total_battles_lost }));
  console.log(t('cli.stats.alltime_catches', { count: stats.total_catches }));
  console.log(t('cli.stats.alltime_encounters', { count: stats.total_encounters }));
}

function cmdLegendary(action?: string): void {
  const state = readState();
  const rewardsDB = getPokedexRewardsDB();
  const locale = readConfig().language ?? 'ko';

  if (state.legendary_pending.length === 0) {
    bold(t('cli.legendary.header'));
    console.log('');
    if (state.legendary_pool.length > 0) {
      info(t('cli.legendary.pool_header'));
      for (const id of state.legendary_pool) {
        const caught = state.pokedex[id]?.caught ? `${GREEN}●${RESET}` : `${YELLOW}◐${RESET}`;
        console.log(`  ${caught} ${getPokemonName(id)}`);
      }
    } else {
      warn(t('cli.legendary.no_pending'));
    }
    return;
  }

  // Show pending groups
  bold(t('cli.legendary.header'));
  console.log('');
  for (let gi = 0; gi < state.legendary_pending.length; gi++) {
    const pending = state.legendary_pending[gi];
    const groupDef = rewardsDB.legendary_groups[pending.group] ?? rewardsDB.type_master.special_legends;
    const label = groupDef?.label[locale] ?? groupDef?.label.en ?? pending.group;
    const desc = groupDef?.description[locale] ?? groupDef?.description.en ?? '';
    info(`${label} — ${desc}`);
    for (let i = 0; i < pending.options.length; i++) {
      console.log(`  ${i + 1}. ${getPokemonName(pending.options[i])}`);
    }
    console.log('');
  }

  if (!action) {
    console.log(t('cli.legendary.choose_hint'));
    return;
  }

  // Parse "select <groupIndex> <optionIndex>" or just a number (first group)
  const parts = action.split(/\s+/);
  const rawGroup = parts.length > 1 ? parseInt(parts[0], 10) : 1;
  const rawOption = parseInt(parts.length > 1 ? parts[1] : parts[0], 10);

  if (!Number.isInteger(rawGroup) || !Number.isInteger(rawOption)) {
    error(t('cli.legendary.invalid_choice'));
    return;
  }

  const groupIdx = rawGroup - 1;
  const optionIdx = rawOption - 1;

  if (groupIdx < 0 || groupIdx >= state.legendary_pending.length) {
    error(t('cli.legendary.invalid_choice'));
    return;
  }

  const pending = state.legendary_pending[groupIdx];
  if (!pending || optionIdx < 0 || optionIdx >= pending.options.length) {
    error(t('cli.legendary.invalid_choice'));
    return;
  }

  const chosen = pending.options[optionIdx];
  const unchosen = pending.options.filter((_, i) => i !== optionIdx);

  const lockResult = withLock(() => {
    const s = readState();
    const c = readConfig();

    // Add chosen to party or unlocked
    if (!s.unlocked.includes(chosen)) s.unlocked.push(chosen);
    const pokemonDB = getPokemonDB();
    const pData = pokemonDB.pokemon[chosen];
    if (pData && !s.pokemon[chosen]) {
      s.pokemon[chosen] = {
        id: pData.id, xp: 0, level: 50, friendship: 0, ev: 0,
        met: 'fateful_encounter',
        met_detail: { met_level: 50, met_date: new Date().toISOString().split('T')[0], from: pending.group },
      };
    }
    if (!s.pokedex[chosen]) {
      s.pokedex[chosen] = { seen: true, caught: true, first_seen: new Date().toISOString().split('T')[0] };
    } else {
      s.pokedex[chosen].seen = true;
      s.pokedex[chosen].caught = true;
    }

    // Add to party if space
    if (c.party.length < c.max_party_size && !c.party.includes(chosen)) {
      c.party.push(chosen);
    }

    // Unchosen go to legendary_pool
    for (const id of unchosen) {
      if (!s.legendary_pool.includes(id)) s.legendary_pool.push(id);
    }

    // Remove this pending group and mark as claimed
    s.legendary_pending = s.legendary_pending.filter(p => p.group !== pending.group);
    const claimKey = `type_master_legendary:${pending.group}`;
    if (!s.pokedex_milestones_claimed.includes(claimKey)) {
      s.pokedex_milestones_claimed.push(claimKey);
    }

    writeState(s);
    writeConfig(c);
  });

  if (!lockResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
  success(t('cli.legendary.selected', { pokemon: getPokemonName(chosen) }));
  if (unchosen.length > 0) {
    info(t('cli.legendary.pool_added', { names: unchosen.map(id => getPokemonName(id)).join(', ') }));
  }
}

function cmdBox(): void {
  const state = readState();
  const config = readConfig();
  const pokemonDB = getPokemonDB();

  const allArgs = process.argv.slice(2);
  const cmdArgs = allArgs.slice(1);

  const parsed = parseFilterArgs(cmdArgs, {
    sort: 'value', type: 'value', rarity: 'value', stage: 'value',
    shiny: 'boolean', search: 'value',
  });

  const filters: import('../core/box.js').BoxFilter = {};
  if (parsed.type) filters.type = parsed.type as string;
  if (parsed.rarity) filters.rarity = parsed.rarity as string;
  if (parsed.stage !== undefined) {
    const stageNum = Number(parsed.stage);
    if (![0, 1, 2].includes(stageNum)) {
      error('--stage must be 0, 1, or 2.');
      process.exit(1);
    }
    filters.stage = stageNum;
  }
  if (parsed.shiny) filters.shiny = true;
  if (parsed.search) filters.keyword = parsed.search as string;

  const sortBy = parsed.sort as string | undefined;
  const hasFilters = Object.keys(filters).length > 0;
  const boxPokemon = getBoxList(state, config, hasFilters ? filters : undefined, sortBy);

  bold(t('cli.box.header'));
  console.log('');

  // Show active filters
  const filterParts: string[] = [];
  if (filters.type) filterParts.push(`type=${filters.type}`);
  if (filters.rarity) filterParts.push(`rarity=${filters.rarity}`);
  if (filters.stage !== undefined) filterParts.push(`stage=${filters.stage}`);
  if (filters.shiny) filterParts.push(t('cli.pokedex.filter_shiny'));
  if (filters.keyword) filterParts.push(t('cli.pokedex.filter_search', { keyword: filters.keyword }));
  if (filterParts.length > 0) info(t('cli.box.filter', { filter: filterParts.join(', ') }));

  if (boxPokemon.length === 0) {
    if (hasFilters) {
      console.log(t('cli.box.no_results'));
    } else {
      warn(t('cli.box.empty'));
    }
    return;
  }

  for (const p of boxPokemon) {
    const typeStr = p.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join('/');
    const evoTag = p.evolutionReady ? ` ${YELLOW}${t('cli.box.can_evolve')}${RESET}` : '';
    const shinyTag = p.isShiny ? ` ${YELLOW}${t('cli.box.shiny_tag')}${RESET}` : '';
    console.log(`  ${getPokemonName(p.name)} Lv.${p.level} ${typeStr} ${GRAY}${p.rarity}${RESET}${shinyTag}${evoTag}`);
  }
  console.log('');
  info(t('cli.box.sort_hint'));
}

function cmdPartySwap(slot: string, pokemon: string): void {
  if (!slot || !pokemon) {
    error(t('cli.party.swap_usage'));
    return;
  }

  const slotNum = parseInt(slot, 10);
  if (!Number.isInteger(slotNum) || slotNum < 1) {
    error(t('cli.party.swap_usage'));
    return;
  }
  const lockResult = withLock(() => {
    const state = readState();
    const config = readConfig();

    if (slotNum > config.party.length) {
      error(t('cli.party.swap_invalid_slot', { max: config.party.length }));
      return;
    }

    // Resolve pokemon name to ID
    const pokemonDB = getPokemonDB();
    const targetId = pokemonDB.pokemon[toBaseId(pokemon)] ? pokemon : Object.keys(pokemonDB.pokemon).find(k => getPokemonName(k).toLowerCase() === pokemon.toLowerCase());
    if (!targetId || !state.unlocked.includes(targetId)) {
      error(t('cli.party.swap_not_in_box', { pokemon }));
      return;
    }
    if (config.party.includes(targetId)) {
      error(t('cli.party.swap_already_in_party', { pokemon: getPokemonName(targetId) }));
      return;
    }

    const outgoing = config.party[slotNum - 1];
    config.party[slotNum - 1] = targetId;
    writeConfig(config);
    writeState(state);
    success(t('cli.party.swap_success', { out: getPokemonName(outgoing), in: getPokemonName(targetId), slot: slotNum }));
  });
  if (!lockResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
}

function cmdPartyReorder(from: string, to: string): void {
  if (!from || !to) {
    error(t('cli.party.reorder_usage'));
    return;
  }

  const rawFrom = parseInt(from, 10);
  const rawTo = parseInt(to, 10);
  if (!Number.isInteger(rawFrom) || !Number.isInteger(rawTo) || rawFrom < 1 || rawTo < 1) {
    error(t('cli.party.reorder_usage'));
    return;
  }
  const fromIdx = rawFrom - 1;
  const toIdx = rawTo - 1;

  const lockResult = withLock(() => {
    const config = readConfig();
    if (fromIdx >= config.party.length || toIdx >= config.party.length) {
      error(t('cli.party.reorder_invalid', { max: config.party.length }));
      return;
    }
    if (fromIdx === toIdx) return;

    const [moved] = config.party.splice(fromIdx, 1);
    config.party.splice(toIdx, 0, moved);
    writeConfig(config);
    success(t('cli.party.reorder_success', { pokemon: getPokemonName(moved), from: fromIdx + 1, to: toIdx + 1 }));
  });
  if (!lockResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
}

function cmdPartySuggest(): void {
  const state = readState();
  const config = readConfig();
  const pokemonDB = getPokemonDB();
  const regionsDB = getRegionsDB();
  const region = regionsDB.regions[config.current_region];
  if (!region) { error(t('cli.party.suggest_no_region')); return; }

  // Build type distribution of wild pokemon in region
  const typeCounts: Record<string, number> = {};
  for (const wildName of region.pokemon_pool) {
    const wildData = pokemonDB.pokemon[wildName];
    if (!wildData) continue;
    for (const wType of wildData.types) {
      typeCounts[wType] = (typeCounts[wType] ?? 0) + 1;
    }
  }

  // Score each owned pokemon by type effectiveness against region pool
  const candidates = state.unlocked
    .filter(name => state.pokemon[name] && pokemonDB.pokemon[toBaseId(name)])
    .map(name => {
      const pData = pokemonDB.pokemon[toBaseId(name)];
      const ps = state.pokemon[name];
      let score = 0;
      const typeChart = pokemonDB.type_chart;

      for (const pType of pData.types) {
        const matchup = typeChart[pType];
        if (!matchup) continue;
        for (const strong of matchup.strong) {
          score += (typeCounts[strong] ?? 0) * 2;
        }
        for (const weak of matchup.weak) {
          score -= (typeCounts[weak] ?? 0);
        }
      }

      // Level bonus
      score += (ps?.level ?? 1) * 0.5;

      return { name, score, level: ps?.level ?? 1, types: pData.types, inParty: config.party.includes(name) };
    });

  candidates.sort((a, b) => b.score - a.score);

  bold(t('cli.party.suggest_header', { region: getRegionName(config.current_region) }));
  console.log('');

  const top = candidates.slice(0, 6);
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const typeStr = c.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join('/');
    const stars = c.score >= 10 ? '★★★' : c.score >= 5 ? '★★☆' : '★☆☆';
    const partyTag = c.inParty ? ` ${GREEN}[party]${RESET}` : '';
    console.log(`  ${i + 1}. ${getPokemonName(c.name)} Lv.${c.level} ${typeStr} ${YELLOW}${stars}${RESET}${partyTag}`);
  }
}

function cmdSetup(args: string[]): void {
  // ── Flag parsing ──
  let gen = '', lang = '', starter = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gen' && args[i + 1]) gen = args[++i];
    else if (args[i] === '--lang' && args[i + 1]) lang = args[++i];
    else if (args[i] === '--starter' && args[i + 1]) starter = args[++i];
  }
  if (!gen || !lang || !starter) {
    error('Usage: tokenmon setup --gen <gen_id> --lang <en|ko> --starter <pokemon_id>');
    process.exit(1);
  }

  // ── Upfront validation ──
  if (lang !== 'en' && lang !== 'ko') {
    error(`Invalid language "${lang}". Must be "en" or "ko".`);
    process.exit(1);
  }

  const gensDB = getGenerationsDB();
  if (!gensDB.generations[gen]) {
    const available = Object.keys(gensDB.generations).join(', ');
    error(`Invalid generation "${gen}". Available: ${available}`);
    process.exit(1);
  }

  const starterNum = parseInt(starter, 10);
  if (isNaN(starterNum) || starterNum <= 0) {
    error(`Invalid starter "${starter}". Must be a numeric Pokémon ID.`);
    process.exit(1);
  }

  // ── Step 1: Check migration state ──
  console.log(`${CYAN}[1/7] Checking migration state...${RESET}`);
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    // Check for legacy files (state/config exist but no global-config)
    const legacyState = join(DATA_DIR, 'state.json');
    const legacyConfig = join(DATA_DIR, 'config.json');
    if (existsSync(legacyState) && !existsSync(join(DATA_DIR, gen, 'state.json'))) {
      // Legacy install without global-config — create default
      const gc = readGlobalConfig(); // returns DEFAULT_GLOBAL_CONFIG when file missing
      writeGlobalConfig(gc);
      console.log(`  ${GREEN}Created global-config.json (fresh)${RESET}`);
    } else {
      // Fresh install
      const gc = readGlobalConfig();
      writeGlobalConfig(gc);
      console.log(`  ${GREEN}Created global-config.json (fresh)${RESET}`);
    }
  } else {
    console.log(`  ${GRAY}global-config.json exists — skipped${RESET}`);
  }

  // ── Step 2: Switch generation ──
  console.log(`${CYAN}[2/7] Switching generation...${RESET}`);
  const currentGlobalConfig = readGlobalConfig();
  if (currentGlobalConfig.active_generation === gen) {
    console.log(`  ${GRAY}Already on ${gen} — skipped${RESET}`);
  } else {
    const switchResult = withLock(() => {
      const freshGc = readGlobalConfig();
      freshGc.active_generation = gen;
      writeGlobalConfig(freshGc);
      clearActiveGenerationCache();
      setActiveGenerationCache(gen);
      invalidateGenCache();
    });
    if (!switchResult.acquired) {
      error('Failed to acquire lock for gen switch');
      process.exit(1);
    }
    console.log(`  ${GREEN}Set active generation to ${gen}${RESET}`);
  }

  // ── Step 3: Set language ──
  console.log(`${CYAN}[3/7] Setting language...${RESET}`);
  const gcForLang = readGlobalConfig();
  if (gcForLang.language === lang) {
    console.log(`  ${GRAY}Already ${lang} — skipped${RESET}`);
  } else {
    const langResult = withLock(() => {
      const freshGc = readGlobalConfig();
      freshGc.language = lang;
      writeGlobalConfig(freshGc);
    });
    if (!langResult.acquired) {
      error('Failed to acquire lock for language set');
      process.exit(1);
    }
    console.log(`  ${GREEN}Set language to ${lang}${RESET}`);
  }
  initLocale(lang, readGlobalConfig().voice_tone);

  // ── Step 4: Configure statusline ──
  console.log(`${CYAN}[4/7] Configuring statusline...${RESET}`);
  try {
    execSync(`"${PLUGIN_ROOT}/bin/tsx-resolve.sh" "${PLUGIN_ROOT}/src/setup/setup-statusline.ts"`, {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: DATA_DIR },
    });
  } catch {
    warn('  Statusline setup had an issue (non-fatal)');
  }

  // ── Step 5: Auto-detect renderer ──
  console.log(`${CYAN}[5/7] Auto-detecting renderer...${RESET}`);
  const config5 = readConfig(gen);
  if (config5.renderer && config5.renderer !== 'braille') {
    console.log(`  ${GRAY}Renderer already set to ${config5.renderer} — skipped${RESET}`);
  } else {
    const detection = detectRenderer();
    const rendererResult = withLock(() => {
      const freshConfig = readConfig(gen);
      freshConfig.renderer = detection.recommended;
      writeConfig(freshConfig, gen);
    });
    if (!rendererResult.acquired) {
      error('Failed to acquire lock for renderer config');
      process.exit(1);
    }
    console.log(`  ${GREEN}Set renderer to ${detection.recommended}${RESET}`);
  }

  // ── Step 6: Select starter ──
  console.log(`${CYAN}[6/7] Selecting starter...${RESET}`);
  const config6 = readConfig(gen);
  if (config6.starter_chosen) {
    console.log(`  ${GRAY}Starter already chosen — skipped${RESET}`);
  } else {
    const pokemonDB = getPokemonDB();
    const starterKey = starter;

    if (!pokemonDB.pokemon[starterKey]) {
      error(`Pokémon ID "${starter}" not found in ${gen} database.`);
      process.exit(1);
    }

    const starterResult = withLock(() => {
      const freshConfig = readConfig(gen);
      const freshState = readState(gen);
      const pData = pokemonDB.pokemon[starterKey];

      freshConfig.party = [starterKey];
      freshConfig.starter_chosen = true;
      writeConfig(freshConfig, gen);

      if (!freshState.pokemon[starterKey]) {
        const starterLevel = 5;
        const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
        freshState.pokemon[starterKey] = {
          id: pData?.id ?? 0,
          xp: levelToXp(starterLevel, expGroup),
          level: starterLevel,
          friendship: 0,
          ev: 0,
          met: 'starter',
          met_detail: { region: freshConfig.current_region, met_level: starterLevel, met_date: new Date().toISOString().split('T')[0] },
        };
      }
      if (!freshState.unlocked.includes(starterKey)) {
        freshState.unlocked.push(starterKey);
      }
      writeState(freshState, gen);
    });
    if (!starterResult.acquired) {
      error('Failed to acquire lock for starter selection');
      process.exit(1);
    }
    console.log(`  ${GREEN}Chose ${getPokemonName(starterKey)} as starter${RESET}`);
  }

  // ── Step 7: Apply defaults ──
  console.log(`${CYAN}[7/7] Applying defaults...${RESET}`);
  const defaultsResult = withLock(() => {
    const freshConfig = readConfig(gen);
    freshConfig.sprite_mode = 'all';
    freshConfig.info_mode = 'ace_full';

    // Auto-configure sound based on environment
    const isSSH = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
    const isDocker = existsSync('/.dockerenv');
    const isWSL = !!(process.env.WSL_DISTRO_NAME || process.env.WSLENV);

    if (isWSL) {
      freshConfig.cry_enabled = true;
      freshConfig.relay_audio = false;
    } else if (isSSH || isDocker) {
      freshConfig.cry_enabled = false;
      freshConfig.relay_audio = true;
    } else {
      freshConfig.cry_enabled = true;
      freshConfig.relay_audio = false;
    }

    writeConfig(freshConfig, gen);
  });
  if (!defaultsResult.acquired) {
    error('Failed to acquire lock for defaults');
    process.exit(1);
  }
  console.log(`  ${GREEN}Applied default settings${RESET}`);

  console.log('');
  success('Setup complete!');
}

function genRegionName(regionName: string | { en: string; ko: string }): string {
  if (typeof regionName === 'string') return regionName;
  return regionName[getLocale() as 'en' | 'ko'] ?? regionName.en;
}

function cmdGen(sub?: string, arg?: string): void {
  const gensDB = getGenerationsDB();
  const globalConfig = readGlobalConfig();
  const activeGen = globalConfig.active_generation;

  if (!sub || sub === 'status') {
    bold(t('cli.gen.title', { fallback: '🎮 Generation' }));
    console.log('');
    const genData = gensDB.generations[activeGen];
    if (genData) {
      console.log(`  ${BOLD}${genData.name}${RESET} (${genRegionName(genData.region_name)})`);
      console.log(`  ${GRAY}ID: ${activeGen} | Pokémon: #${genData.pokemon_range[0]}-#${genData.pokemon_range[1]}${RESET}`);
    }
    console.log('');
    return;
  }

  if (sub === 'list') {
    bold(t('cli.gen.list_title', { fallback: '📋 Available Generations' }));
    console.log('');
    const sorted = Object.values(gensDB.generations).sort((a, b) => a.order - b.order);
    for (const gen of sorted) {
      const marker = gen.id === activeGen ? ` ${GREEN}← active${RESET}` : '';
      const config = readConfig(gen.id);
      const setupStatus = config.starter_chosen ? '' : ` ${YELLOW}(not set up)${RESET}`;
      console.log(`  ${BOLD}${gen.name}${RESET} [${gen.id}] — ${genRegionName(gen.region_name)}${marker}${setupStatus}`);
    }
    console.log('');
    info(t('cli.gen.switch_hint', { fallback: 'Use: gen switch <id>' }));
    return;
  }

  if (sub === 'switch') {
    if (!arg) {
      error(t('cli.gen.switch_usage', { fallback: 'Usage: gen switch <gen_id>' }));
      info(t('cli.gen.switch_example', { fallback: 'Example: gen switch gen1' }));
      return;
    }
    const targetGen = arg;
    if (!gensDB.generations[targetGen]) {
      error(t('cli.gen.not_found', { fallback: `Generation "${targetGen}" not found.` }));
      const available = Object.keys(gensDB.generations).join(', ');
      info(t('cli.gen.available', { fallback: `Available: ${available}` }));
      return;
    }
    if (targetGen === activeGen) {
      warn(t('cli.gen.already_active', { fallback: `Already on ${targetGen}.` }));
      return;
    }

    // Validate generation has required data files before switching
    const genDir = join(PLUGIN_ROOT, 'data', targetGen);
    const requiredFiles = ['pokemon.json', 'regions.json', 'achievements.json', 'pokedex-rewards.json'];
    const missingFiles = requiredFiles.filter(f => !existsSync(join(genDir, f)));
    // Also check i18n files
    const i18nDir = join(genDir, 'i18n');
    if (!existsSync(i18nDir) || !existsSync(join(i18nDir, 'en.json')) || !existsSync(join(i18nDir, 'ko.json'))) {
      missingFiles.push('i18n/en.json or i18n/ko.json');
    }
    if (missingFiles.length > 0) {
      error(t('cli.gen.incomplete_data', { fallback: `Generation ${targetGen} is missing data files: ${missingFiles.join(', ')}` }));
      return;
    }

    // Switch generation under lock
    const switchResult = withLock(() => {
      const freshGlobalConfig = readGlobalConfig();
      freshGlobalConfig.active_generation = targetGen;
      writeGlobalConfig(freshGlobalConfig);
      clearActiveGenerationCache();
      setActiveGenerationCache(targetGen);
      invalidateGenCache();

      // Reset region to 1 (regions are per-generation, IDs don't carry over)
      const targetConfig = readConfig(targetGen);
      if (targetConfig.current_region !== '1') {
        targetConfig.current_region = '1';
        writeConfig(targetConfig, targetGen);
      }
      return { starter_chosen: targetConfig.starter_chosen };
    });
    if (!switchResult.acquired) {
      error(t('cli.lock_failed', { fallback: 'Failed to acquire lock. Please try again.' }));
      return;
    }

    const genData = gensDB.generations[targetGen];
    success(t('cli.gen.switched', { fallback: `Switched to ${genData.name} (${genRegionName(genData.region_name)})` }));
    info(t('cli.gen.restart_hint', { fallback: 'Restart your session for the switch to take effect.' }));
    if (!switchResult.value.starter_chosen) {
      console.log('');
      warn(t('cli.gen.needs_setup', { fallback: 'This generation needs initial setup. Run /tkm:tkm starter to choose your starter!' }));
    }
    return;
  }

  error(t('cli.gen.unknown_sub', { fallback: `Unknown subcommand: ${sub}` }));
  info(t('cli.gen.usage', { fallback: 'Usage: gen [list|switch <id>|status]' }));
}

function cmdHelp(): void {
  bold(t('cli.help.title'));
  console.log('');
  info(t('cli.help.usage'));
  console.log('');
  bold(t('cli.help.commands'));
  console.log(t('cli.help.cmd_status'));
  console.log(t('cli.help.cmd_starter'));
  console.log(t('cli.help.cmd_party'));
  console.log(t('cli.help.cmd_party_add'));
  console.log(t('cli.help.cmd_party_remove'));
  console.log(t('cli.help.cmd_unlock'));
  console.log(t('cli.help.cmd_achievements'));
  console.log(t('cli.help.cmd_evolve'));
  console.log(t('cli.help.cmd_evolve_pokemon'));
  console.log(t('cli.help.cmd_notifications'));
  console.log(t('cli.help.cmd_notifications_clear'));
  console.log(t('cli.help.cmd_dashboard'));
  console.log(t('cli.help.cmd_stats'));
  console.log(t('cli.help.cmd_legendary'));
  console.log(t('cli.help.cmd_box'));
  console.log(t('cli.help.cmd_party_swap'));
  console.log(t('cli.help.cmd_party_reorder'));
  console.log(t('cli.help.cmd_party_suggest'));
  console.log(t('cli.help.cmd_items'));
  console.log(t('cli.help.cmd_region'));
  console.log(t('cli.help.cmd_region_list'));
  console.log(t('cli.help.cmd_region_move'));
  console.log(t('cli.help.cmd_guide'));
  console.log(t('cli.help.cmd_pokedex'));
  console.log(t('cli.help.cmd_pokedex_name'));
  console.log(t('cli.help.cmd_pokedex_type'));
  console.log(t('cli.help.cmd_pokedex_region'));
  console.log(t('cli.help.cmd_pokedex_rarity'));
  console.log(t('cli.help.cmd_config'));
  console.log(t('cli.help.cmd_uninstall'));
  console.log(t('cli.help.cmd_uninstall_keep'));
  console.log(t('cli.help.cmd_reset'));
  console.log(t('cli.help.cmd_friendly_battle'));
  console.log(t('cli.help.cmd_cheat'));
  console.log(t('cli.help.cmd_help'));
  console.log('');
  bold(t('cli.help.examples'));
  console.log(t('cli.help.ex1'));
  console.log(t('cli.help.ex2'));
  console.log(t('cli.help.ex3'));
  console.log(t('cli.help.ex4'));
}

// Main dispatch
const args = process.argv.slice(2);
const command = args[0] ?? 'help';

// Initialize locale from config before any i18n usage
initLocale(readConfig().language ?? 'ko', readGlobalConfig().voice_tone);

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'starter':
    cmdStarter(args[1]);
    break;
  case 'party':
    cmdParty(args[1] ?? 'list', args[2]);
    break;
  case 'unlock':
    if (args[1] === 'list' || !args[1]) cmdUnlockList();
    else error(t('cli.unlock.usage'));
    break;
  case 'achievements':
    cmdAchievements();
    break;
  case 'items':
    cmdItems();
    break;
  case 'region':
    cmdRegion(args[1], args.slice(2).join(' ') || undefined);
    break;
  case 'evolve':
    cmdEvolve(args[1], args[2]);
    break;
  case 'notifications':
    cmdNotifications(args[1]);
    break;
  case 'dashboard':
    cmdDashboard();
    break;
  case 'stats':
    cmdStats();
    break;
  case 'legendary':
    cmdLegendary(args.slice(1).join(' ') || undefined);
    break;
  case 'box':
    cmdBox();
    break;
  case 'star': {
    const { execSync } = await import('child_process');
    try {
      execSync('gh api -X PUT user/starred/ThunderConch/tkm', { stdio: 'pipe' });
      const starResult = withLock(() => {
        const s = readState();
        s.star_dismissed = true;
        writeState(s);
      });
      success(t('star.success'));
    } catch {
      error(t('star.failed'));
    }
    break;
  }
  case 'star-dismiss': {
    const dismissResult = withLock(() => {
      const s = readState();
      s.star_dismissed = true;
      writeState(s);
    });
    if (!dismissResult.acquired) { error(t('cli.lock_failed')); process.exit(1); }
    success(t('star.dismissed'));
    break;
  }
  case 'gen':
    cmdGen(args[1], args[2]);
    break;
  case 'setup':
    cmdSetup(args.slice(1));
    break;
  case 'guide':
    cmdGuide(args[1]);
    break;
  case 'pokedex':
    cmdPokedex();
    break;
  case 'config':
    if (args[1] === 'set') cmdConfigSet(args[2], args[3]);
    else error(t('cli.config.usage_set'));
    break;
  case 'uninstall': {
    const { execSync } = await import('child_process');
    const uninstallArgs = args.includes('--keep-state') ? ' --keep-state' : '';
    execSync(`"${PLUGIN_ROOT}/bin/tsx-resolve.sh" "${PLUGIN_ROOT}/scripts/uninstall.ts"${uninstallArgs}`, { stdio: 'inherit' });
    break;
  }
  case 'call':
    cmdCall(args[1] ?? '');
    break;
  case 'nickname':
    cmdNickname(args[1] ?? '', args.slice(2).join(' ') || undefined);
    break;
  case 'reset':
    cmdReset(args.includes('--confirm'));
    break;
  case 'friendly-battle': {
    const { runFriendlyBattleCli } = await import('./friendly-battle.js');
    await runFriendlyBattleCli(args.slice(1));
    break;
  }
  case 'cheat':
    cmdCheat(args[1], args[2], args[3]);
    break;
  case 'voice_tone':
    cmdConfigSet('voice_tone', args[1]);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default: {
    const query = args.join(' ');
    const volumeKeywords = ['사용 토큰별 경험치 배율', '볼륨 배율', '토큰 배율', 'volume multiplier', 'token xp table', 'volume bonus'];
    if (volumeKeywords.some(k => query.includes(k))) {
      const locale = getLocale();
      if (locale === 'ko') {
        bold('[ 토큰 사용량별 보너스 ]');
        console.log('  ~10,000 토큰   보통');
        console.log('  ~40,000 토큰   경험치↑ 인카운터↑');
        console.log('  ~100,000 토큰  경험치↑↑ 인카운터↑↑ 레어↑');
        console.log('  100,000+ 토큰  경험치↑↑↑ 인카운터↑↑↑ 레어↑↑');
      } else {
        bold('[ Volume Bonus by Token Usage ]');
        console.log('  ~10,000 tokens   Normal');
        console.log('  ~40,000 tokens   XP↑ Encounter↑');
        console.log('  ~100,000 tokens  XP↑↑ Encounter↑↑ Rare↑');
        console.log('  100,000+ tokens  XP↑↑↑ Encounter↑↑↑ Rare↑↑');
      }
      break;
    }
    error(t('cli.unknown_command', { command }));
    console.log('');
    cmdHelp();
    process.exit(1);
  }
}
