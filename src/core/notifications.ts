import { getAchievementsDB, getCommonAchievementsDB, getRegionsDB, getAchievementName } from './pokemon-data.js';
import { isRegionUnlocked } from './regions.js';
import { t } from '../i18n/index.js';
import type { State, Config, Notification, CommonState } from './types.js';

/**
 * Scan state for conditions that warrant notifications.
 * Returns new notifications not already dismissed.
 */
export function checkPendingNotifications(state: State, config: Config, commonState?: CommonState): Notification[] {
  if (!config.notifications_enabled) return [];

  const now = new Date().toISOString().split('T')[0];
  const notifications: Notification[] = [];

  // 1. Evolution ready
  for (const [name, pState] of Object.entries(state.pokemon)) {
    if (!pState.evolution_ready) continue;
    if (pState.evolution_prompt_shown) continue;  // already prompted via stop block
    if (!config.party.includes(name)) continue;
    const id = `evolution_ready:${name}`;
    if (state.dismissed_notifications.includes(id)) continue;
    notifications.push({
      id,
      type: 'evolution_ready',
      message: t('notification.evolution_ready', { pokemon: name }),
      created: now,
      data: { pokemon: name, options: pState.evolution_options },
    });
  }

  // 2. Region unlocked (compare against last_known_regions)
  const regionsDB = getRegionsDB();
  let unlockedCount = 0;
  for (const regionName of Object.keys(regionsDB.regions)) {
    if (isRegionUnlocked(regionName, state)) unlockedCount++;
  }
  if (unlockedCount > state.last_known_regions) {
    const id = `region_unlocked:${unlockedCount}`;
    if (!state.dismissed_notifications.includes(id)) {
      notifications.push({
        id,
        type: 'region_unlocked',
        message: t('notification.region_unlocked', { count: unlockedCount - state.last_known_regions }),
        created: now,
      });
    }
  }

  // 3. Achievement near (>= 90% progress)
  const achDB = getAchievementsDB();
  for (const ach of achDB.achievements) {
    if (state.achievements[ach.id]) continue;
    const progress = getAchievementProgress(ach.trigger_type, ach.trigger_value, state);
    if (progress >= 0.9) {
      const id = `achievement_near:${ach.id}`;
      if (state.dismissed_notifications.includes(id)) continue;
      notifications.push({
        id,
        type: 'achievement_near',
        message: t('notification.achievement_near', { name: getAchievementName(ach.id), pct: Math.round(progress * 100) }),
        created: now,
      });
    }
  }

  // 3b. Common achievement near (>= 90% progress)
  const commonAchDB = getCommonAchievementsDB();
  for (const ach of commonAchDB.achievements) {
    if (commonState?.achievements?.[ach.id]) continue;
    const progress = getCommonAchievementProgress(ach.trigger_type, ach.trigger_value, commonState);
    if (progress >= 0.9) {
      const id = `achievement_near:${ach.id}`;
      if (state.dismissed_notifications.includes(id)) continue;
      notifications.push({
        id,
        type: 'achievement_near',
        message: t('notification.achievement_near', { name: getAchievementName(ach.id), pct: Math.round(progress * 100) }),
        created: now,
      });
    }
  }

  // 4. Legendary unlocked
  if (state.legendary_pending.length > 0) {
    const id = `legendary_unlocked:${state.legendary_pending.map(p => p.group).join(',')}`;
    if (!state.dismissed_notifications.includes(id)) {
      notifications.push({
        id,
        type: 'legendary_unlocked',
        message: t('notification.legendary_unlocked'),
        created: now,
      });
    }
  }

  return notifications;
}

/**
 * Get active (non-dismissed) notifications from state.
 */
export function getActiveNotifications(state: State): Notification[] {
  return state.notifications.filter(n => !state.dismissed_notifications.includes(n.id));
}

/**
 * Dismiss a single notification by ID.
 */
export function dismissNotification(state: State, id: string): void {
  if (!state.dismissed_notifications.includes(id)) {
    state.dismissed_notifications.push(id);
  }
}

/**
 * Dismiss all current notifications.
 */
export function dismissAll(state: State): void {
  for (const n of state.notifications) {
    if (!state.dismissed_notifications.includes(n.id)) {
      state.dismissed_notifications.push(n.id);
    }
  }
}

/**
 * Update state.notifications with freshly checked notifications.
 * Also prunes dismissed_notifications to prevent unbounded growth.
 */
export function refreshNotifications(state: State, config: Config, commonState?: CommonState): void {
  state.notifications = checkPendingNotifications(state, config, commonState);

  // Prune: keep only dismissed IDs that match current active notifications + cap at 100
  const activeIds = new Set(state.notifications.map(n => n.id));
  if (state.dismissed_notifications.length > 100) {
    state.dismissed_notifications = state.dismissed_notifications.filter(id => activeIds.has(id));
  }
}

/**
 * Update last_known_regions to current count so region notifications don't repeat.
 */
export function updateKnownRegions(state: State): void {
  const regionsDB = getRegionsDB();
  let count = 0;
  for (const regionName of Object.keys(regionsDB.regions)) {
    if (isRegionUnlocked(regionName, state)) count++;
  }
  state.last_known_regions = count;
}

function getCommonAchievementProgress(triggerType: string, triggerValue: number, commonState?: CommonState): number {
  if (!commonState) return 0;
  let current = 0;
  switch (triggerType) {
    case 'session_count': current = commonState.session_count; break;
    case 'error_count': current = commonState.error_count; break;
    case 'evolution_count': current = commonState.evolution_count; break;
    case 'total_tokens': current = commonState.total_tokens_consumed; break;
    case 'permission_count': current = commonState.permission_count; break;
    case 'battle_wins': current = commonState.battle_wins; break;
    case 'battle_count': current = commonState.battle_count; break;
    case 'catch_count': current = commonState.catch_count; break;
    case 'badge_count': current = commonState.total_gym_badges; break;
    case 'all_gen_badges': current = commonState.completed_gym_gens; break;
    default: return 0;
  }
  return triggerValue > 0 ? current / triggerValue : 0;
}

function getAchievementProgress(triggerType: string, triggerValue: number, state: State): number {
  let current = 0;
  switch (triggerType) {
    case 'session_count': current = state.session_count; break;
    case 'error_count': current = state.error_count; break;
    case 'evolution_count': current = state.evolution_count; break;
    case 'total_tokens': current = state.total_tokens_consumed; break;
    case 'permission_count': current = state.permission_count; break;
    case 'battle_wins': current = state.battle_wins ?? 0; break;
    case 'battle_count': current = state.battle_count ?? 0; break;
    case 'catch_count': current = state.catch_count ?? 0; break;
    case 'badge_count': current = (state.gym_badges ?? []).length; break;
    case 'champion_defeated': {
      current = (state.gym_badges ?? []).filter(b => b.startsWith('champion_')).length;
      break;
    }
    case 'all_gen_badges': {
      // all_gen_badges only exists in common achievements; not reached from per-gen scan
      return 0;
    }
    default: return 0;
  }
  return triggerValue > 0 ? current / triggerValue : 0;
}
