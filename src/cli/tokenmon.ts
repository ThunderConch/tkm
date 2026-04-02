#!/usr/bin/env -S npx tsx
import * as readline from 'readline';
import { readFileSync } from 'fs';
import { readState, writeState } from '../core/state.js';
import { readConfig, writeConfig, getDefaultConfig } from '../core/config.js';
import { getPokemonDB, getAchievementsDB, getAchievementName, getAchievementDescription, getAchievementRarityLabel, getRegionName, getRegionDescription, getPokemonName } from '../core/pokemon-data.js';
import { levelToXp } from '../core/xp.js';
import { playCry } from '../audio/play-cry.js';
import { getCompletion, getPokedexList, syncPokedexFromUnlocked } from '../core/pokedex.js';
import { getCurrentRegion, getRegionList, moveToRegion } from '../core/regions.js';
import { renderGuide, renderGuideIndex } from '../core/guide.js';
import { getEligibleBranches, applyBranchEvolution } from '../core/evolution.js';
import { getActiveNotifications, dismissAll } from '../core/notifications.js';
import { t, initLocale } from '../i18n/index.js';
import { withLock } from '../core/lock.js';
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
      const pData = pokemonDB.pokemon[pokemon];
      const pokemonId = pData?.id ?? 0;
      const types = pData?.types?.join('/') ?? '';
      const evolvesAt = pData?.evolves_at;
      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      const bar = xpBar(xp, level, expGroup);
      const evolInfo = evolvesAt != null ? t('cli.status.evolves_at', { level: evolvesAt }) : '';

      console.log(`  ${BOLD}${getPokemonName(pokemon)}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET}`);
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
}

function cmdStarter(): void {
  const config = readConfig();
  const state = readState();
  const pokemonDB = getPokemonDB();

  if (config.starter_chosen) {
    warn(t('cli.starter.already_chosen'));
    info(t('cli.starter.current_party', { party: config.party.map(getPokemonName).join(', ') }));
    return;
  }

  bold(t('cli.starter.prompt_title'));
  console.log('');

  const starters = pokemonDB.starters;
  for (let i = 0; i < starters.length; i++) {
    const s = starters[i];
    const pData = pokemonDB.pokemon[s];
    const types = pData?.types?.join('/') ?? '';
    const pokemonId = pData?.id ?? '?';
    console.log(`  ${i + 1}) ${BOLD}${getPokemonName(s)}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET}`);
  }

  console.log('');
  // Read choice from stdin
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(t('cli.starter.prompt_input', { count: starters.length }), (answer: string) => {
    rl.close();
    const choice = parseInt(answer, 10);
    if (isNaN(choice) || choice < 1 || choice > starters.length) {
      error(t('cli.starter.invalid_choice'));
      process.exit(1);
    }

    const chosen = starters[choice - 1];

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
        freshState.pokemon[chosen] = { id: pData?.id ?? 0, xp: levelToXp(starterLevel, expGroup), level: starterLevel, friendship: 0, ev: 0 };
      }
      if (!freshState.unlocked.includes(chosen)) {
        freshState.unlocked.push(chosen);
      }
      writeState(freshState);
    });

    if (lockResult === null) {
      error(t('cli.lock_busy'));
      process.exit(1);
    }

    success(t('cli.starter.chosen', { pokemon: getPokemonName(chosen) }));
    playCry(chosen);
  });
}

function cmdParty(subcmd: string, pokemon?: string): void {
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
      // Validation before lock
      if (!config.party.includes(pokemon)) {
        error(t('cli.party.dispatch_not_in_party', { pokemon }));
        process.exit(1);
      }
      const dispatchResult = withLock(() => {
        const freshConfig = readConfig();
        freshConfig.default_dispatch = pokemon!;
        writeConfig(freshConfig);
      });
      if (dispatchResult === null) { error(t('cli.lock_failed')); process.exit(1); }
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
      if (addResult === null) { error(t('cli.lock_failed')); process.exit(1); }
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
      if (removeResult === null) { error(t('cli.lock_failed')); process.exit(1); }
      success(t('cli.party.remove_success', { pokemon }));
      break;
    }
    default: {
      // list
      bold(t('cli.party.header'));
      for (const p of config.party) {
        const level = state.pokemon[p]?.level ?? 1;
        const xp = state.pokemon[p]?.xp ?? 0;
        const expGroup: ExpGroup = pokemonDB.pokemon[p]?.exp_group ?? 'medium_fast';
        const bar = xpBar(xp, level, expGroup);
        console.log(`  ${BOLD}${getPokemonName(p)}${RESET} Lv.${level} [${GREEN}${bar}${RESET}]`);
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
    const pokemonId = pokemonDB.pokemon[p]?.id ?? 0;
    const types = pokemonDB.pokemon[p]?.types?.join('/') ?? '';
    console.log(`  ${BOLD}${getPokemonName(p)}${RESET} [#${pokemonId}] ${GRAY}${types}${RESET} Lv.${level}`);
  }
}

function cmdAchievements(): void {
  const state = readState();
  const achDB = getAchievementsDB();

  bold(t('cli.achievements.header'));
  console.log('');

  for (const ach of achDB.achievements) {
    const achieved = !!state.achievements[ach.id];
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
    console.log(t('cli.config.key_tips_enabled'));
    console.log(t('cli.config.key_notifications'));
    console.log(t('cli.config.help_renderer'));

    process.exit(1);
  }

  const config = readConfig();
  const numericKeys = ['tokens_per_xp', 'max_party_size', 'peon_ping_port'];
  const floatKeys = ['volume', 'xp_bonus_multiplier'];
  const boolKeys = ['sprite_enabled', 'cry_enabled', 'peon_ping_integration', 'tips_enabled', 'notifications_enabled'];
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
  if (configResult === null) { error(t('cli.lock_failed')); process.exit(1); }
  success(t('cli.config.set_success', { key, value }));
}

function cmdPokedex(pokemonName?: string, filterKey?: string, filterVal?: string): void {
  const state = readState();
  const pokemonDB = getPokemonDB();
  syncPokedexFromUnlocked(state);

  // Detail view for single pokemon
  if (pokemonName && pokemonName !== '--type' && pokemonName !== '--region' && pokemonName !== '--rarity') {
    const pData = pokemonDB.pokemon[pokemonName];
    if (!pData) {
      error(t('cli.pokedex.not_found', { name: pokemonName }));
      process.exit(1);
    }

    const pdex = state.pokedex?.[pokemonName];
    const statusIcon = pdex?.caught ? `${GREEN}●${RESET}` : pdex?.seen ? `${YELLOW}◐${RESET}` : `${GRAY}○${RESET}`;
    const statusText = pdex?.caught ? t('cli.pokedex.status_caught') : pdex?.seen ? t('cli.pokedex.status_seen') : t('cli.pokedex.status_unknown');

    bold(`=== ${pokemonName} (#${pData.id}) ===`);
    console.log('');
    console.log(`  ${t('cli.pokedex.detail_status', { icon: statusIcon, status: statusText })}`);
    console.log(`  ${t('cli.pokedex.detail_type', { types: pData.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join(' / ') })}`);
    console.log(`  ${t('cli.pokedex.detail_rarity', { rarity: pData.rarity })}`);
    console.log(`  ${t('cli.pokedex.detail_region', { region: pData.region })}`);
    console.log(`  ${t('cli.pokedex.detail_exp_group', { group: pData.exp_group })}`);
    console.log(`  ${t('cli.pokedex.detail_catch_rate', { rate: pData.catch_rate })}`);
    console.log(`  ${t('cli.pokedex.detail_base_stats', { hp: pData.base_stats.hp, atk: pData.base_stats.attack, def: pData.base_stats.defense, spd: pData.base_stats.speed })}`);
    console.log(`  ${t('cli.pokedex.detail_line', { line: pData.line.join(' → ') })}`);
    if (pData.evolves_at) console.log(`  ${t('cli.pokedex.detail_evolves_at', { level: pData.evolves_at })}`);
    if (pData.evolves_condition) console.log(`  ${t('cli.pokedex.detail_evolves_cond', { cond: pData.evolves_condition })}`);
    if (pdex?.first_seen) console.log(`  ${t('cli.pokedex.detail_first_seen', { date: pdex.first_seen })}`);

    if (state.pokemon[pokemonName]) {
      const ps = state.pokemon[pokemonName];
      console.log(`  ${t('cli.pokedex.detail_current_level', { level: ps.level, xp: formatNumber(ps.xp) })}`);
    }
    return;
  }

  // Parse filters
  const filters: { type?: string; region?: string; rarity?: string } = {};
  const allArgs = process.argv.slice(2);
  for (let i = 1; i < allArgs.length; i++) {
    if (allArgs[i] === '--type' && allArgs[i + 1]) { filters.type = allArgs[++i]; }
    else if (allArgs[i] === '--region' && allArgs[i + 1]) { filters.region = allArgs[++i]; }
    else if (allArgs[i] === '--rarity' && allArgs[i + 1]) { filters.rarity = allArgs[++i]; }
  }

  // List view
  const completion = getCompletion(state);
  const list = getPokedexList(state, Object.keys(filters).length > 0 ? filters : undefined);

  bold(t('cli.pokedex.list_title'));
  console.log(t('cli.pokedex.list_summary', { seen: completion.seen, caught: completion.caught, total: completion.total, seenPct: completion.seenPct, caughtPct: completion.caughtPct }));
  console.log('');

  const filterDesc = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ');
  if (filterDesc) info(t('cli.pokedex.filter', { filter: filterDesc }));

  for (const entry of list) {
    const icon = entry.status === 'caught' ? `${GREEN}●${RESET}`
      : entry.status === 'seen' ? `${YELLOW}◐${RESET}`
      : `${GRAY}○${RESET}`;
    const typeStr = entry.types.map((tp: string) => `${pokemonDB.type_colors[tp] ?? ''}${tp}${RESET}`).join('/');
    const nameDisplay = entry.status === 'unknown' ? `${GRAY}???${RESET}` : entry.name;
    console.log(`  ${icon} #${String(entry.id).padStart(3, '0')} ${nameDisplay.padEnd(8)} ${typeStr} ${GRAY}${entry.rarity}${RESET}`);
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
    if (moveResult === null) { error(t('cli.lock_failed')); process.exit(1); }
    if (!moveResult.ok) { error(moveResult.error); process.exit(1); }
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
    };
    writeState(defaultState);
  });
  if (resetResult === null) { error(t('cli.lock_failed')); process.exit(1); }
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
        if (!state.pokemon[arg1!]) state.pokemon[arg1!] = { id: pData.id, xp: 0, level: 1, friendship: 0, ev: 0 };
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

  if (cheatResult === null) { error(t('cli.lock_failed')); process.exit(1); }
  if (typeof cheatResult === 'string' && cheatResult === t('cli.cheat.no_pokemon', { name: arg1 })) {
    error(cheatResult);
  } else if (cheatResult) {
    success(cheatResult);
  }
}

function cmdEvolve(pokemonArg?: string, targetArg?: string): void {
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
      console.log(`  ${BOLD}${getPokemonName(p)}${RESET} → ${opts.map(getPokemonName).join(' / ')}`);
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
  const branches = getEligibleBranches(pokemonArg, ctx);
  const eligible = branches.filter(b => b.conditionMet);

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

  // Show branches and prompt
  bold(t('cli.evolve.select_header', { pokemon: getPokemonName(pokemonArg) }));
  console.log('');
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    const icon = b.conditionMet ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const targetData = pokemonDB.pokemon[b.name];
    const types = targetData?.types?.join('/') ?? '';
    console.log(`  ${i + 1}) ${icon} ${BOLD}${getPokemonName(b.name)}${RESET} ${GRAY}${types}${RESET}`);
    console.log(`     ${GRAY}${t('cli.evolve.condition', { cond: b.conditionLabel })}${RESET}`);
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
    // Multiple eligible — select
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(t('cli.evolve.prompt_select', { count: eligible.length }), (answer: string) => {
      rl.close();
      const idx = parseInt(answer, 10);
      // Map selection back to eligible branches using their position in the full branches list
      const eligibleIndices = branches.map((b, i) => b.conditionMet ? i : -1).filter(i => i >= 0);
      const selectedFullIdx = eligibleIndices[idx - 1];
      if (isNaN(idx) || idx < 1 || idx > eligible.length || selectedFullIdx === undefined) {
        error(t('cli.evolve.invalid_choice'));
        process.exit(1);
      }
      executeEvolve(pokemonArg!, branches[selectedFullIdx].name, config);
    });
  }
}

function executeEvolve(pokemonName: string, targetName: string, _config: unknown): void {
  const evolveResult = withLock(() => {
    const freshState = readState();
    const freshConfig = readConfig();
    const result = applyBranchEvolution(freshState, freshConfig, pokemonName, targetName);
    if (!result) return null;
    writeState(freshState);
    writeConfig(freshConfig);
    return result;
  });

  if (evolveResult === null) {
    error(t('cli.lock_failed'));
    process.exit(1);
  }
  if (!evolveResult) {
    error(t('cli.evolve.failed'));
    return;
  }

  success(t('cli.evolve.success', { old: getPokemonName(evolveResult.oldPokemon), new: getPokemonName(evolveResult.newPokemon) }));
  playCry(evolveResult.newPokemon);
}

function cmdNotifications(subcmd?: string): void {
  const state = readState();

  if (subcmd === 'clear') {
    const clearResult = withLock(() => {
      const freshState = readState();
      dismissAll(freshState);
      writeState(freshState);
    });
    if (clearResult === null) { error(t('cli.lock_failed')); process.exit(1); }
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
initLocale(readConfig().language ?? 'ko');

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'starter':
    cmdStarter();
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
  case 'guide':
    cmdGuide(args[1]);
    break;
  case 'pokedex':
    cmdPokedex(args[1], args[2], args[3]);
    break;
  case 'config':
    if (args[1] === 'set') cmdConfigSet(args[2], args[3]);
    else error(t('cli.config.usage_set'));
    break;
  case 'uninstall': {
    const { execSync } = await import('child_process');
    const uninstallArgs = args.includes('--keep-state') ? ' --keep-state' : '';
    execSync(`"${process.env.CLAUDE_PLUGIN_ROOT || '.'}/bin/tsx-resolve.sh" "${process.env.CLAUDE_PLUGIN_ROOT || '.'}/scripts/uninstall.ts"${uninstallArgs}`, { stdio: 'inherit' });
    break;
  }
  case 'reset':
    cmdReset(args.includes('--confirm'));
    break;
  case 'cheat':
    cmdCheat(args[1], args[2], args[3]);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    error(t('cli.unknown_command', { command }));
    console.log('');
    cmdHelp();
    process.exit(1);
}
