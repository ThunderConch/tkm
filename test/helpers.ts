import type { State, Config } from '../src/core/types.js';

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
    notifications: [],
    dismissed_notifications: [],
    last_known_regions: 1,
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
    language: 'ko' as const,
    renderer: 'braille' as const,
    ...overrides,
  };
}
