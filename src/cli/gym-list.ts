#!/usr/bin/env -S npx tsx
/**
 * gym-list.ts — Show gym status and badge progress for the active generation.
 */
import { loadGymData } from '../core/gym.js';
import { readState } from '../core/state.js';
import { getActiveGeneration } from '../core/paths.js';
import { getSharedDB } from '../core/pokemon-data.js';
import { t, initLocale, getLocale } from '../i18n/index.js';
import { readGlobalConfig } from '../core/config.js';

initLocale(readGlobalConfig().language);

// ANSI helpers
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const CYAN = '\x1b[36m';

const gen = getActiveGeneration();
const state = readState(gen);
const badges = state.gym_badges ?? [];
const sharedDB = getSharedDB();

// Type color lookup
function typeColor(type: string): string {
  const colors: Record<string, string> = {
    normal: '\x1b[0m',
    fire: '\x1b[31m',
    water: '\x1b[34m',
    grass: '\x1b[32m',
    electric: '\x1b[33m',
    ice: '\x1b[96m',
    fighting: '\x1b[31m',
    poison: '\x1b[35m',
    ground: '\x1b[33m',
    flying: '\x1b[96m',
    psychic: '\x1b[95m',
    bug: '\x1b[32m',
    rock: '\x1b[33m',
    ghost: '\x1b[35m',
    dragon: '\x1b[34m',
    dark: '\x1b[90m',
    steel: '\x1b[37m',
    fairy: '\x1b[95m',
  };
  return colors[type] ?? RESET;
}

try {
  const gyms = loadGymData(gen);

  const genLabel = gen.toUpperCase().replace('GEN', 'GEN');
  console.log();
  console.log(`  ${BOLD}🏟️  ${t('cli.gym_list.title', { gen: genLabel })}${RESET}`);
  console.log();

  if (gyms.length === 0) {
    console.log(`  ${GRAY}${t('cli.gym_list.empty')}${RESET}`);
  }

  for (const gym of gyms) {
    const cleared = badges.includes(gym.badge);
    const icon = cleared ? `${GREEN}✅` : `${GRAY}⬜`;
    const tc = typeColor(gym.type);
    const leaderDisplay = getLocale() === 'ko' ? (gym.leaderKo || gym.leader) : gym.leader;
    const badgeDisplay = getLocale() === 'ko' ? (gym.badgeKo || gym.badge) : (gym.badge ? `${gym.badge.charAt(0).toUpperCase() + gym.badge.slice(1)} Badge` : gym.badge);
    const maxLevel = gym.team.length > 0 ? Math.max(...gym.team.map(p => p.level)) : 0;
    const levelDisplay = maxLevel > 0 ? `${GRAY}Lv.${maxLevel}${RESET}` : '';

    console.log(
      `  ${icon} ${RESET}${BOLD}${gym.id}.${RESET} ${leaderDisplay} ${GRAY}(${tc}${gym.type}${GRAY})${RESET} — ${badgeDisplay} ${levelDisplay}`,
    );
  }

  const clearedCount = gyms.filter(g => badges.includes(g.badge)).length;
  console.log();
  console.log(`  ${CYAN}${t('cli.gym_list.badge_count', { count: clearedCount, total: gyms.length })}${RESET}`);
  console.log();
} catch (err: any) {
  console.error(`  ⚠️  ${t('cli.gym_list.error', { gen })}`)
  process.exit(1);
}
