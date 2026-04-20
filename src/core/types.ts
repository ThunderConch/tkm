// Shared types for tokenmon

export type ExpGroup = 'medium_fast' | 'medium_slow' | 'slow' | 'fast' | 'erratic' | 'fluctuating';

export type SpriteRenderer = 'kitty' | 'sixel' | 'iterm2' | 'braille';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythical';

export interface BaseStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  sp_attack?: number;
  sp_defense?: number;
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
  shiny_caught?: boolean;
}

export type MetType =
  | 'starter'
  | 'wild'
  | 'evolution'
  | 'achievement'
  | 'fateful_encounter'
  | 'unknown';

export interface MetDetail {
  region?: string;       // 지역 ID (예: "1" = 떡잎마을)
  met_level?: number;    // 만난 레벨
  met_date?: string;     // 만난 날짜 (YYYY-MM-DD)
  from?: string;         // 출처 상세 (업적 ID, 전설 그룹, 진화 전 포켓몬 등)
}

export interface PokemonState {
  id: number;
  xp: number;
  level: number;
  friendship: number;
  ev: number;
  shiny?: boolean;
  nickname?: string;
  call_count?: number;
  evolution_ready?: boolean;
  evolution_options?: string[];
  evolution_prompt_shown?: boolean;
  moves?: number[];
  met?: MetType;
  met_detail?: MetDetail;
}

export type NotificationType = 'evolution_ready' | 'region_unlocked' | 'achievement_near' | 'legendary_unlocked';

export interface MilestoneReward {
  id: string;
  threshold: number;
  reward_type: 'pokeball' | 'xp_multiplier' | 'legendary_unlock' | 'party_slot' | 'title';
  reward_value: number | string;
  legendary_bonus?: string;
  label: { en: string; ko: string };
}

export interface LegendaryGroup {
  label: { en: string; ko: string };
  description: { en: string; ko: string };
  options: string[];
}

export interface LegendaryPending {
  group: string;
  options: string[];
}

export interface PokedexRewardsDB {
  milestones: MilestoneReward[];
  legendary_groups: Record<string, LegendaryGroup>;
  type_master: {
    xp_bonus: number;
    legendary_unlock_threshold: number;
    legendary_group: string;
    special_legends: LegendaryGroup;
  };
  chain_completion_reward: {
    pokeball_min: number;
    pokeball_max: number;
  };
}

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  created: string;
  data?: Record<string, unknown>;
}

export interface Stats {
  streak_days: number;
  longest_streak: number;
  last_active_date: string;
  weekly_xp: number;
  weekly_battles_won: number;
  weekly_battles_lost: number;
  weekly_catches: number;
  weekly_encounters: number;
  total_xp_earned: number;
  total_battles_won: number;
  total_battles_lost: number;
  total_catches: number;
  total_encounters: number;
  codex_tokens_consumed: number;
  codex_xp_earned: number;
  last_reset_week: string;
}

export interface TimeEvent {
  id: string;
  hours: number[];
  type_boost: Record<string, number>;
  label: { en: string; ko: string };
}

export interface DayEvent {
  id: string;
  day: number;
  rare_multiplier: number;
  label: { en: string; ko: string };
}

export interface StreakEvent {
  id: string;
  days: number;
  reward: string;
  label: { en: string; ko: string };
}

export interface MilestoneEvent {
  id: string;
  trigger_type: string;
  trigger_value: number;
  reward: string;
  label: { en: string; ko: string };
}

export interface EventsDB {
  time_of_day: TimeEvent[];
  day_of_week: DayEvent[];
  streak: StreakEvent[];
  milestone: MilestoneEvent[];
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
  migrated_version?: string;
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
  encounter_rate_bonus?: number;
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
  last_drop: string | null;
  last_achievement: string | null;
  notifications: Notification[];
  dismissed_notifications: string[];
  last_known_regions: number;
  stats: Stats;
  events_triggered: string[];
  pokedex_milestones_claimed: string[];
  type_masters: string[];
  legendary_pool: string[];
  legendary_pending: LegendaryPending[];
  titles: string[];
  completed_chains: string[];
  star_dismissed: boolean;
  shiny_encounter_count: number;
  shiny_catch_count: number;
  shiny_escaped_count: number;
  rest_bonus?: {
    multiplier: number;
    turns_remaining: number;
  };
  pending_tier?: string | null;
  context_tokens_used?: number;
  gym_badges?: string[];
  rare_weight_multiplier?: number;
  last_codex_xp?: number | null;
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
  /** Send audio to a peon-ping relay instead of playing locally. Independent of peon_ping_integration. */
  relay_audio: boolean;
  /** Relay server hostname. Shares peon_ping_port. */
  relay_host: string;
  /** Local PLUGIN_ROOT on the relay host, used to translate remote file paths. */
  relay_sound_root: string;
  current_region: string;
  default_dispatch: string | null;
  sprite_mode: 'all' | 'ace_only' | 'emoji_all' | 'emoji_ace';
  renderer: SpriteRenderer;
  info_mode: 'ace_full' | 'name_level' | 'all_full' | 'ace_level';
  tips_enabled: boolean;
  notifications_enabled: boolean;
  pp_enabled: boolean;
  language: 'ko' | 'en';
}

export interface Session {
  session_id: string | null;
  agent_assignments: AgentAssignment[];
  evolution_events: string[];
  achievement_events: string[];
}

export type SessionGenMap = Record<string, { generation: string; created: string; last_seen: string }>;

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
  rewardXpDump?: number;
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
  totalXpApplied?: number;
  dispatchBonus?: number;
  caught: boolean;
  typeMultiplier: number;
  ballCost: number;
  shiny?: boolean;
  partyFull?: boolean;
}

export interface WildPokemon {
  name: string;
  level: number;
  shiny: boolean;
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

// ── Multi-generation support ──

export type VoiceTone = 'claude' | 'pokemon';

export interface WeatherEvent {
  condition: string;
  type_boost: Record<string, number>;
  label: { en: string; ko: string };
  emoji: string;
}

export interface GlobalConfig {
  active_generation: string;
  language: 'ko' | 'en';
  voice_tone: VoiceTone;
  weather_enabled: boolean;
  weather_location: string;
}

export interface GenerationData {
  id: string;
  name: string;
  region_name: string | { en: string; ko: string };
  pokemon_range: [number, number];
  starters: string[];
  order: number;
}

export interface GenerationsDB {
  generations: Record<string, GenerationData>;
  default_generation: string;
}

export interface SharedDB {
  type_colors: Record<string, string>;
  type_chart: Record<string, TypeMatchup>;
  rarity_weights: RarityWeights;
}

// ── Volume Tier System ──

export type VolumeTierName = 'normal' | 'heated' | 'intense' | 'legendary';

export interface VolumeTier {
  name: VolumeTierName;
  minTokens: number;
  xpMultiplier: number;
  encounterMultiplier: number;
  rarityWeights: RarityWeights;
}

// ── Common State (shared across all generations) ──

export interface CommonState {
  achievements: Record<string, boolean>;
  encounter_rate_bonus: number;
  xp_bonus_multiplier: number;
  items: Record<string, number>;
  max_party_size_bonus: number;
  session_count: number;
  total_tokens_consumed: number;
  battle_count: number;
  battle_wins: number;
  catch_count: number;
  evolution_count: number;
  error_count: number;
  permission_count: number;
  total_gym_badges: number;
  completed_gym_gens: number;
  titles: string[];
  rare_weight_multiplier: number;
  last_codex_tokens_total: number;
  last_turn_ts?: number;
}

// ── Stdin data from Claude Code ──

export interface RateLimitWindow {
  used_percentage: number;
  resets_at: number;
}

export interface StdinRateLimits {
  five_hour?: RateLimitWindow;
  seven_day?: RateLimitWindow;
}

export interface StdinContextWindow {
  used_percentage: number;
  remaining_percentage: number;
  context_window_size: number;
}

export interface StdinData {
  rate_limits?: StdinRateLimits;
  context_window?: StdinContextWindow;
}

// ── Battle System Types ──

export type MoveCategory = 'physical' | 'special' | 'status';

export type StatusCondition =
  | 'burn'
  | 'poison'
  | 'badly_poisoned'
  | 'paralysis'
  | 'sleep'
  | 'freeze';

export type VolatileStatusType = 'confusion' | 'flinch' | 'leech_seed';

export interface VolatileStatus {
  type: VolatileStatusType;
  turnsRemaining?: number;
  sourceSide?: 'player' | 'opponent';
  /**
   * Seeder slot (activeIndex at the time of application) for leech-seed
   * ownership. When the seeder switches out, its leech-seed markers on the
   * opposing team are cleared so healing cannot redirect to the replacement.
   */
  sourceSlot?: number;
}

export interface StatStages {
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
  accuracy: number;
  evasion: number;
}

export interface StatChange {
  target: 'self' | 'opponent';
  stat: keyof StatStages;
  stages: number;
  chance: number;
}

export interface HealEffect {
  type: 'heal';
  fraction: number;
}

export interface RestEffect {
  type: 'rest';
}

export interface RecoilEffect {
  type: 'recoil';
  fraction: number;
}

export interface DrainEffect {
  type: 'drain';
  fraction: number;
}

export type MoveEffect = HealEffect | RestEffect | RecoilEffect | DrainEffect;

export interface MoveData {
  id: number;
  name: string;
  nameKo: string;
  nameEn: string;
  type: string;
  category: MoveCategory;
  power: number;
  accuracy: number | null;
  pp: number;
  effect?: {
    type: StatusCondition;
    chance: number;
  };
  volatileEffect?: {
    type: VolatileStatusType;
    chance: number;
  };
  statChanges?: StatChange[];
  moveEffect?: MoveEffect;
}

export interface PokemonMovePool {
  pool: Array<{ moveId: number; learnLevel: number }>;
}

export interface BattleMove {
  data: MoveData;
  currentPp: number;
}

export interface BattlePokemon {
  id: number;
  name: string;
  displayName: string;
  types: string[];
  level: number;
  maxHp: number;
  currentHp: number;
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
  moves: BattleMove[];
  fainted: boolean;
  statusCondition: StatusCondition | null;
  toxicCounter: number;
  sleepCounter: number;
  volatileStatuses: VolatileStatus[];
  statStages: StatStages;
}

export interface BattleTeam {
  pokemon: BattlePokemon[];
  activeIndex: number;
}

export type TurnAction =
  | { type: 'move'; moveIndex: number }
  | { type: 'switch'; pokemonIndex: number }
  | { type: 'surrender' };

export interface TurnResult {
  messages: string[];
  playerFainted: boolean;
  opponentFainted: boolean;
}

export interface BattleState {
  player: BattleTeam;
  opponent: BattleTeam;
  turn: number;
  log: string[];
  phase: 'select_action' | 'resolve_turn' | 'fainted_switch' | 'battle_end';
  winner: 'player' | 'opponent' | null;
}

export interface GymData {
  id: number;
  leader: string;
  leaderKo: string;
  type: string;
  badge: string;
  badgeKo: string;
  team: GymPokemon[];
  region: string;
}

export interface GymPokemon {
  species: number;
  level: number;
  moves: number[];
}
