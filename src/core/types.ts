// Shared types for tokenmon

export type ExpGroup = 'medium_fast' | 'medium_slow' | 'slow' | 'fast' | 'erratic' | 'fluctuating';

export type SpriteRenderer = 'kitty' | 'sixel' | 'iterm2' | 'braille';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythical';

export interface BaseStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface BranchEvolution {
  name: string;
  condition: string;
}

export interface PokemonData {
  id: number;
  name: string;
  types: string[];
  stage: number;
  line: string[];
  evolves_at: number | null;
  evolves_condition?: string;
  evolves_to?: string | BranchEvolution[];
  unlock: string;
  exp_group: ExpGroup;
  rarity: Rarity;
  region: string;
  base_stats: BaseStats;
  catch_rate: number;
}

export interface TypeMatchup {
  strong: string[];
  weak: string[];
  immune: string[];
}

export interface RarityWeights {
  common: number;
  uncommon: number;
  rare: number;
  legendary: number;
  mythical: number;
}

export interface PokemonDB {
  pokemon: Record<string, PokemonData>;
  starters: string[];
  type_colors: Record<string, string>;
  type_chart: Record<string, TypeMatchup>;
  rarity_weights: RarityWeights;
}

export interface PokedexEntry {
  seen: boolean;
  caught: boolean;
  first_seen: string | null;
}

export interface PokemonState {
  id: number;
  xp: number;
  level: number;
  friendship: number;
  ev: number;
  evolution_ready?: boolean;
  evolution_options?: string[];
}

export type NotificationType = 'evolution_ready' | 'region_unlocked' | 'achievement_near';

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  created: string;
  data?: Record<string, unknown>;
}

export interface EvolutionContext {
  oldLevel: number;
  newLevel: number;
  friendship: number;
  currentRegion: string;
  unlockedAchievements: string[];
  items: Record<string, number>;
}

export interface State {
  state_version?: number;
  pokemon: Record<string, PokemonState>;
  unlocked: string[];
  achievements: Record<string, boolean>;
  total_tokens_consumed: number;
  session_count: number;
  error_count: number;
  permission_count: number;
  evolution_count: number;
  last_session_id: string | null;
  xp_bonus_multiplier: number;
  last_session_tokens: Record<string, number>;
  pokedex: Record<string, PokedexEntry>;
  encounter_count: number;
  catch_count: number;
  battle_count: number;
  battle_wins: number;
  battle_losses: number;
  items: Record<string, number>;
  cheat_log: Array<{ timestamp: string; command: string }>;
  last_battle: BattleResult | null;
  last_tip: { id: string; text: string } | null;
  notifications: Notification[];
  dismissed_notifications: string[];
  last_known_regions: number;
}

export interface Config {
  tokens_per_xp: number;
  party: string[];
  starter_chosen: boolean;
  volume: number;
  sprite_enabled: boolean;
  cry_enabled: boolean;
  xp_formula: string;
  xp_bonus_multiplier: number;
  max_party_size: number;
  peon_ping_integration: boolean;
  peon_ping_port: number;
  current_region: string;
  default_dispatch: string | null;
  sprite_mode: 'all' | 'ace_only' | 'emoji_all' | 'emoji_ace';
  renderer: SpriteRenderer;
  info_mode: 'ace_full' | 'name_level' | 'all_full' | 'ace_level';
  tips_enabled: boolean;
  notifications_enabled: boolean;
  language: 'ko' | 'en';
}

export interface Session {
  session_id: string | null;
  agent_assignments: AgentAssignment[];
  evolution_events: string[];
  achievement_events: string[];
}

export interface AgentAssignment {
  agent_id: string;
  pokemon: string;
  xp_multiplier: number;
}

export interface Achievement {
  id: string;
  trigger_type: string;
  trigger_value: number;
  reward_pokemon: string | null;
  reward_effects?: Array<{type: string; [key: string]: unknown}>;
  rarity: number;
}

export interface AchievementsDB {
  achievements: Achievement[];
}

export interface EvolutionResult {
  oldPokemon: string;
  newPokemon: string;
  newId: number;
  level: number;
}

export interface AchievementEvent {
  id: string;
  name: string;
  rewardPokemon?: string;
  rewardMessage?: string;
}

export interface RegionData {
  id: number;
  level_range: [number, number];
  pokemon_pool: string[];
  unlock_condition: { type: string; value: number } | null;
}

export interface RegionsDB {
  regions: Record<string, RegionData>;
  default_region: string;
}

export interface EncounterResult {
  pokemon: string;
  level: number;
  rarity: string;
  region: string;
  caught: boolean;
}

export interface BattleResult {
  attacker: string;
  defender: string;
  defenderLevel: number;
  winRate: number;
  won: boolean;
  xpReward: number;
  caught: boolean;
  typeMultiplier: number;
}

export interface HookInput {
  session_id?: string;
  agent_id?: string;
  [key: string]: unknown;
}

export interface HookOutput {
  continue: boolean;
  system_message?: string;
}
