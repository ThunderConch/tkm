import { readFileSync } from 'fs';
import { readState, writeState, writeSession } from '../core/state.js';
import { readConfig } from '../core/config.js';
import { checkAchievements, formatAchievementMessage } from '../core/achievements.js';
import { refreshNotifications, getActiveNotifications, updateKnownRegions } from '../core/notifications.js';
import { playCry } from '../audio/play-cry.js';
import { initLocale } from '../i18n/index.js';
import { withLock } from '../core/lock.js';
import type { HookInput, HookOutput } from '../core/types.js';

function readStdin(): string {
  try {
    const data = readFileSync(0, 'utf-8');
    return data || '{}';
  } catch {
    return '{}';
  }
}

function main(): void {
  const input = JSON.parse(readStdin()) as HookInput;
  const sessionId = input.session_id ?? '';

  const messages: string[] = [];

  const result = withLock(() => {
    const state = readState();
    const config = readConfig();
    initLocale(config.language ?? 'ko');

    // Reset session.json for new session
    writeSession({
      session_id: sessionId,
      agent_assignments: [],
      evolution_events: [],
      achievement_events: [],
    });

    // Increment session_count
    state.session_count += 1;
    state.last_session_id = sessionId;

    // Check achievements (first_session, ten_sessions)
    const achEvents = checkAchievements(state, config);
    for (const achEvent of achEvents) {
      messages.push(formatAchievementMessage(achEvent));
    }

    // Refresh notifications and include active ones in output
    updateKnownRegions(state);
    refreshNotifications(state, config);
    const activeNotifs = getActiveNotifications(state);
    if (activeNotifs.length > 0) {
      const icons: Record<string, string> = {
        evolution_ready: '✨',
        region_unlocked: '🗺️',
        achievement_near: '🏆',
      };
      for (const n of activeNotifs) {
        const icon = icons[n.type] ?? '📢';
        messages.push(`${icon} ${n.message}`);
      }
    }

    writeState(state);
  });

  // Lock failed — skip gracefully (state not mutated)
  if (result === null) {
    // no-op: proceed without state changes
  }

  // Play cry async (fire and forget)
  try {
    playCry();
  } catch {
    // Ignore audio errors
  }

  const output: HookOutput = { continue: true };
  if (messages.length > 0) {
    output.system_message = messages.join('\n');
  }
  console.log(JSON.stringify(output));
}

main();
