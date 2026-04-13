import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import type { State, Config } from '../src/core/types.js';
import { setActiveGenerationCache } from '../src/core/paths.js';

// Pin active generation to gen4 for tests (prevents env leakage from global-config.json)
setActiveGenerationCache('gen4');

/**
 * Canonical test factory for State — includes ALL fields from the State interface.
 * When new fields are added to State, update this single file.
 */
export function makeState(overrides: Partial<State> = {}): State {
  return {
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
    stats: {
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
      last_reset_week: '',
    },
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
    gym_badges: [],
    rare_weight_multiplier: 1.0,
    ...overrides,
  };
}

/**
 * Canonical test factory for Config — includes ALL fields from the Config interface.
 * When new fields are added to Config, update this single file.
 */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    tokens_per_xp: 10000,
    party: [],
    starter_chosen: true,
    volume: 0.5,
    sprite_enabled: true,
    cry_enabled: true,
    xp_formula: 'medium_fast',
    xp_bonus_multiplier: 1.0,
    max_party_size: 6,
    peon_ping_integration: false,
    peon_ping_port: 19998,
    current_region: '1',
    default_dispatch: null,
    sprite_mode: 'all',
    info_mode: 'ace_full',
    tips_enabled: true,
    notifications_enabled: true,
    pp_enabled: true,
    language: 'ko' as const,
    renderer: 'braille' as const,
    ...overrides,
  };
}

/**
 * Run a copy/paste shell command through the platform default shell.
 * This keeps integration tests portable across local shells and CI images
 * that may not have zsh installed.
 */
export function spawnShellCommand(
  command: string,
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, {
    ...options,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
