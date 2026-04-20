import { getPokemonDB, getAchievementsDB, getCommonAchievementsDB, getAchievementName, getPokemonName } from './pokemon-data.js';
import { markCaught } from './pokedex.js';
import { levelToXp, xpToLevel } from './xp.js';
import { t } from '../i18n/index.js';
import type { State, Config, AchievementEvent, CommonState } from './types.js';

/**
 * Check all achievements against current state.
 * Returns list of newly unlocked achievements.
 */
export function checkAchievements(state: State, config: Config, commonState?: CommonState, generation?: string): AchievementEvent[] {
  const db = getAchievementsDB(generation);
  const pokemonDB = getPokemonDB();
  const events: AchievementEvent[] = [];

  for (const ach of db.achievements) {
    if (state.achievements[ach.id]) continue;

    let triggered = false;
    switch (ach.trigger_type) {
      case 'session_count':
        triggered = state.session_count >= ach.trigger_value;
        break;
      case 'error_count':
        triggered = state.error_count >= ach.trigger_value;
        break;
      case 'evolution_count':
        triggered = state.evolution_count >= ach.trigger_value;
        break;
      case 'total_tokens':
        triggered = state.total_tokens_consumed >= ach.trigger_value;
        break;
      case 'permission_count':
        triggered = state.permission_count >= ach.trigger_value;
        break;
      case 'battle_wins':
        triggered = (state.battle_wins ?? 0) >= ach.trigger_value;
        break;
      case 'battle_count':
        triggered = (state.battle_count ?? 0) >= ach.trigger_value;
        break;
      case 'catch_count':
        triggered = (state.catch_count ?? 0) >= ach.trigger_value;
        break;
      case 'badge_count':
        triggered = (state.gym_badges ?? []).length >= ach.trigger_value;
        break;
      case 'champion_defeated': {
        const championBadges = (state.gym_badges ?? []).filter(b => b.startsWith('champion_'));
        triggered = championBadges.length >= ach.trigger_value;
        break;
      }
    }

    if (!triggered) continue;

    state.achievements[ach.id] = true;

    const event: AchievementEvent = {
      id: ach.id,
      name: getAchievementName(ach.id),
    };

    // Handle reward pokemon
    if (ach.reward_pokemon) {
      const rewardName = ach.reward_pokemon;
      const pData = pokemonDB.pokemon[rewardName];
      if (state.unlocked.includes(rewardName) && state.pokemon[rewardName] && pData) {
        // Already owned: XP dump
        const rewardLevel = (ach as { reward_level?: number }).reward_level;
        const group = pData.exp_group ?? 'slow';
        const bonusXp = levelToXp(rewardLevel ?? 75, group);
        state.pokemon[rewardName].xp += bonusXp;
        state.pokemon[rewardName].level = xpToLevel(state.pokemon[rewardName].xp, group);
        event.rewardXpDump = bonusXp;
        event.rewardPokemon = rewardName;
      } else {
        // New grant OR recovery from unlocked/pokemon divergence
        if (!state.unlocked.includes(rewardName)) {
          state.unlocked.push(rewardName);
        }
        if (pData && !state.pokemon[rewardName]) {
          const rewardLevel = (ach as { reward_level?: number }).reward_level;
          let level: number;
          if (rewardLevel) {
            level = rewardLevel;
          } else if (pData.rarity === 'legendary' || pData.rarity === 'mythical') {
            level = 50;
          } else {
            const partyLevels = (config.party ?? []).map((name: string) => state.pokemon[name]?.level ?? 0).filter((l: number) => l > 0);
            level = partyLevels.length > 0 ? Math.round(partyLevels.reduce((a, b) => a + b, 0) / partyLevels.length) : 1;
          }
          const xp = levelToXp(level, pData.exp_group);
          state.pokemon[rewardName] = {
            id: pData.id, xp, level, friendship: 0, ev: 0,
            met: 'achievement',
            met_detail: { met_level: level, met_date: new Date().toISOString().split('T')[0], from: ach.id },
          };
        }
        markCaught(state, rewardName);
        event.rewardPokemon = rewardName;
      }
    }

    applyAchievementEffects(ach.id, state, config, commonState, generation);

    // For dual-existence IDs (e.g. hundred_k_tokens in both common and gen4),
    // also mark commonState so recalculateCommonEffects includes their effects on restart
    if (commonState && !commonState.achievements[ach.id]) {
      commonState.achievements[ach.id] = true;
    }

    events.push(event);
  }

  return events;
}

function applyAchievementEffects(achievementId: string, state: State, config: Config, commonState?: CommonState, generation?: string): void {
  const db = getAchievementsDB(generation);
  const ach = db.achievements.find(a => a.id === achievementId);

  // Process structured reward_effects from achievements.json
  if (ach?.reward_effects) {
    for (const effect of ach.reward_effects as Array<{ type: string; item?: string; count?: number; value?: number }>) {
      switch (effect.type) {
        case 'add_item':
          state.items[effect.item as string] = (state.items[effect.item as string] ?? 0) + (effect.count ?? 1);
          break;
        case 'xp_bonus':
          state.xp_bonus_multiplier += (effect.value ?? 0);
          break;
        case 'party_slot':
          config.max_party_size = Math.min(6, config.max_party_size + (effect.count ?? 1));
          break;
        case 'unlock_legendary':
          // Flag-only effect — no direct state change needed
          break;
        case 'title':
          if (effect.value) {
            const titleStr = String(effect.value);
            if (!state.titles.includes(titleStr)) state.titles.push(titleStr);
            // Do NOT write per-gen titles to commonState — they are per-gen only.
            // Only common achievement titles belong in commonState.titles.
          }
          break;
        case 'rare_weight_multiplier':
          // Per-gen only: don't write to commonState (common effects are recalculated
          // from common achievements by recalculateCommonEffects at session start)
          state.rare_weight_multiplier = (state.rare_weight_multiplier ?? 1.0) * (effect.value ?? 1.0);
          break;
        case 'encounter_rate_bonus':
          // Per-gen only: don't write to commonState (common effects are recalculated
          // from common achievements by recalculateCommonEffects at session start)
          state.encounter_rate_bonus = (state.encounter_rate_bonus ?? 0) + (effect.value ?? 0);
          break;
      }
    }
  }
}

/**
 * Check common achievements against commonState trigger counters.
 * Returns list of newly unlocked common achievements.
 */
export function checkCommonAchievements(commonState: CommonState, config: Config, state: State): AchievementEvent[] {
  const db = getCommonAchievementsDB();
  const pokemonDB = getPokemonDB();
  const events: AchievementEvent[] = [];

  for (const ach of db.achievements) {
    if (commonState.achievements[ach.id]) continue;
    // Skip if gen-specific checkAchievements already processed this ID
    // (dual-existence IDs like hundred_k_tokens exist in both common and gen4)
    if (state.achievements[ach.id]) continue;

    let triggered = false;
    switch (ach.trigger_type) {
      case 'session_count':
        triggered = commonState.session_count >= ach.trigger_value;
        break;
      case 'error_count':
        triggered = commonState.error_count >= ach.trigger_value;
        break;
      case 'evolution_count':
        triggered = commonState.evolution_count >= ach.trigger_value;
        break;
      case 'total_tokens':
        triggered = commonState.total_tokens_consumed >= ach.trigger_value;
        break;
      case 'permission_count':
        triggered = commonState.permission_count >= ach.trigger_value;
        break;
      case 'battle_wins':
        triggered = commonState.battle_wins >= ach.trigger_value;
        break;
      case 'battle_count':
        triggered = commonState.battle_count >= ach.trigger_value;
        break;
      case 'catch_count':
        triggered = commonState.catch_count >= ach.trigger_value;
        break;
      case 'badge_count':
        triggered = commonState.total_gym_badges >= ach.trigger_value;
        break;
      case 'all_gen_badges':
        triggered = commonState.completed_gym_gens >= ach.trigger_value;
        break;
    }

    if (!triggered) continue;

    commonState.achievements[ach.id] = true;
    state.achievements[ach.id] = true;

    const event: AchievementEvent = {
      id: ach.id,
      name: getAchievementName(ach.id),
    };

    // Apply effects to commonState and per-gen state
    applyCommonAchievementEffects(ach, commonState, config, state);

    events.push(event);
  }

  return events;
}

function applyCommonAchievementEffects(
  ach: { reward_effects?: Array<{ type: string; item?: string; count?: number; value?: number }> },
  commonState: CommonState,
  config: Config,
  state: State,
): void {
  if (!ach.reward_effects) return;
  for (const effect of ach.reward_effects) {
    switch (effect.type) {
      case 'encounter_rate_bonus':
        commonState.encounter_rate_bonus += (effect.value ?? 0);
        break;
      case 'xp_bonus':
        commonState.xp_bonus_multiplier += (effect.value ?? 0);
        break;
      case 'party_slot':
        commonState.max_party_size_bonus += (effect.count ?? 0);
        config.max_party_size = Math.min(6, config.max_party_size + (effect.count ?? 1));
        break;
      case 'add_item':
        commonState.items[effect.item as string] = (commonState.items[effect.item as string] ?? 0) + (effect.count ?? 1);
        break;
      case 'unlock_legendary':
        break;
      case 'title':
        if (effect.value) {
          const titleStr = String(effect.value);
          if (!state.titles.includes(titleStr)) state.titles.push(titleStr);
          if (!commonState.titles) commonState.titles = [];
          if (!commonState.titles.includes(titleStr)) commonState.titles.push(titleStr);
        }
        break;
      case 'rare_weight_multiplier':
        state.rare_weight_multiplier = (state.rare_weight_multiplier ?? 1.0) * (effect.value ?? 1.0);
        commonState.rare_weight_multiplier = (commonState.rare_weight_multiplier ?? 1.0) * (effect.value ?? 1.0);
        break;
    }
  }
}

/**
 * Format achievement event as a notification message.
 */
export function formatAchievementMessage(event: AchievementEvent): string {
  if (event.rewardXpDump && event.rewardPokemon) {
    // XP dump for duplicate — show generic unlock message, not "got pokemon"
    return t('achievement.unlocked', { name: event.name }) + '!';
  }
  if (event.rewardPokemon) {
    return t('achievement.unlocked_pokemon', { name: event.name, pokemon: getPokemonName(event.rewardPokemon) });
  }
  return t('achievement.unlocked', { name: event.name }) + '!';
}
