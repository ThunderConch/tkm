import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readState, writeState, pruneSessionTokens, readSessionGenMap, writeSessionGenMap, readCommonState, writeCommonState } from '../core/state.js';
import { readConfig, writeConfig, readGlobalConfig, writeGlobalConfig } from '../core/config.js';
import { getPokemonDB, getPokemonName } from '../core/pokemon-data.js';
import { levelToXp, xpToLevel } from '../core/xp.js';
import { checkEvolution, applyEvolution, addFriendship, FRIENDSHIP_PER_LEVELUP, FRIENDSHIP_PER_SESSION } from '../core/evolution.js';
import { checkAchievements, checkCommonAchievements, formatAchievementMessage } from '../core/achievements.js';
import { t, initLocale } from '../i18n/index.js';
import type { HookInput, HookOutput, ExpGroup } from '../core/types.js';
import { playCry } from '../audio/play-cry.js';
import { playSfx } from '../audio/play-sfx.js';
import { syncPokedexFromUnlocked, markShinyCaught } from '../core/pokedex.js';
import { processEncounter, formatEncounterMessage } from '../core/encounter.js';
import { addItem, randInt, getDropRateMultiplier } from '../core/items.js';
import { getRegionDropMessage } from '../core/region-messages.js';
import { getVolumeTier, getVolumeTierByName } from '../core/volume-tier.js';
import { withLock, withLockRetry } from '../core/lock.js';
import { setActiveGenerationCache, getActiveGeneration } from '../core/paths.js';
import { isShinyKey, toBaseId, toShinyKey } from '../core/shiny-utils.js';
import { recordXp, recordBattle, recordCatch, recordEncounter, recordShinyEncounter, recordShinyCatch, recordShinyEscaped } from '../core/stats.js';
import { readCodexTotalTokens } from '../core/codex.js';

function getTurnFloor(level: number): number {
  if (level <= 10) return 3;
  if (level <= 20) return 2;
  return 0;
}

function readStdin(): string {
  try {
    const data = readFileSync(0, 'utf-8');
    return data || '{}';
  } catch {
    return '{}';
  }
}

function parseJsonl(filePath: string): { tokens: number; lastCacheTokens: number } {
  const content = readFileSync(filePath, 'utf-8');
  let total = 0;
  let lastCacheTokens = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const msg = obj.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (usage) {
        total += (usage.input_tokens as number) || 0;
        total += (usage.output_tokens as number) || 0;
        // Explicitly NOT counting cache_creation_input_tokens or cache_read_input_tokens for XP
        const cacheRead = (usage.cache_read_input_tokens as number) || 0;
        if (cacheRead > 0) lastCacheTokens = Math.max(lastCacheTokens, cacheRead);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { tokens: total, lastCacheTokens };
}

function findJsonlFile(sessionId: string): string | null {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projectsDir = join(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  // Search project subdirs for session JSONL
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subDir = join(projectsDir, entry.name);
      const candidate = join(subDir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function main(): Promise<void> {
  const input = JSON.parse(readStdin()) as HookInput;
  const sessionId = input.session_id ?? '';

  // Always use the globally active generation.
  // Gen switch is a global operation — all sessions follow it immediately.
  const gen = getActiveGeneration();
  setActiveGenerationCache(gen);

  const output: HookOutput = { continue: true };

  // Pre-lock: read config for early exit check (benign TOCTOU — worst case: enter lock unnecessarily)
  const configCheck = readConfig(gen);
  const globalConfig = readGlobalConfig();
  const needsVoiceToneMigration = (globalConfig.voice_tone as string) === 'classic';
  if (needsVoiceToneMigration) globalConfig.voice_tone = 'claude';
  initLocale(configCheck.language ?? 'en', globalConfig.voice_tone);

  if (configCheck.party.length === 0 || !sessionId) {
    playCry();
    console.log(JSON.stringify(output));
    return;
  }

  // Pre-lock: parse JSONL (read-only, no race condition)
  const jsonlFile = findJsonlFile(sessionId);
  let totalTokens = 0;
  let lastCacheTokens = 0;
  if (jsonlFile) {
    const parsed = parseJsonl(jsonlFile);
    totalTokens = parsed.tokens;
    lastCacheTokens = parsed.lastCacheTokens;
  }

  // Pre-lock: load guide module (read-only module load)
  let getRandomTip: ((state: any, config: any) => { id: string; text: string } | null) | null = null;
  try {
    const guideModule = await import('../core/guide.js');
    getRandomTip = guideModule.getRandomTip;
  } catch {
    // Ignore guide errors
  }

  // All state mutations under global lock
  const messages: string[] = [];
  const achievementMessages: string[] = [];

  const result = withLockRetry(() => {
    const config = readConfig(gen);
    const state = readState(gen);
    const genMap = readSessionGenMap();

    // Clear previous battle/tip/codex result (only show for one turn)
    state.last_battle = null;
    state.last_tip = null;
    state.last_codex_xp = null;

    // Self-healing: register session in gen-map if SessionStart hook didn't fire
    if (sessionId && !genMap[sessionId]) {
      genMap[sessionId] = { generation: gen, created: new Date().toISOString(), last_seen: new Date().toISOString() };
      writeSessionGenMap(genMap);
    }

    // Read common state early (needed for last_turn_ts on all paths)
    const commonState = readCommonState();

    // Delta tracking
    const isFirstStop = !(sessionId in state.last_session_tokens);
    const prevSessionTokens = state.last_session_tokens[sessionId] ?? 0;
    const deltaTokens = totalTokens - prevSessionTokens;


    if (isFirstStop) {
      // First stop in this session: record baseline, no XP yet
      state.last_session_tokens[sessionId] = totalTokens;
      const activeIds = new Set(Object.keys(genMap));
      state.last_session_tokens = pruneSessionTokens(state.last_session_tokens, activeIds);
      commonState.last_turn_ts = Date.now();
      writeCommonState(commonState);
      writeState(state, gen);
      return 'first_stop';
    }

    if (deltaTokens <= 0) {
      // Codex-only path: award Codex XP if available, but skip ALL gameplay side effects
      // (no encounters, drops, rest bonus, tier updates, friendship, evolution checks)
      const codexPreCheck = readCodexTotalTokens();
      const codexPrev = commonState.last_codex_tokens_total ?? 0;
      const codexDelta = Math.max(0, codexPreCheck - codexPrev);
      const tokensPerXpEarly = Math.max(1, config.tokens_per_xp);
      const codexXpOnly = Math.floor(codexDelta / tokensPerXpEarly);

      if (codexXpOnly > 0) {
        const pokemonDB = getPokemonDB();
        for (const pokemonName of config.party) {
          if (!pokemonName || !state.pokemon[pokemonName]) continue;
          const expGroup: ExpGroup = pokemonDB.pokemon[toBaseId(pokemonName)]?.exp_group ?? 'medium_fast';
          const prevLevel = state.pokemon[pokemonName].level;
          state.pokemon[pokemonName].xp += codexXpOnly;
          state.pokemon[pokemonName].level = xpToLevel(state.pokemon[pokemonName].xp, expGroup);
          if (state.pokemon[pokemonName].level > prevLevel) {
            messages.push(t('hook.levelup', { pokemon: getPokemonName(pokemonName), from: prevLevel, to: state.pokemon[pokemonName].level, xp: codexXpOnly }));
          }
        }
        const codexConsumed = codexXpOnly * tokensPerXpEarly;
        commonState.last_codex_tokens_total = codexPrev + codexConsumed;
        state.stats.codex_tokens_consumed = (state.stats.codex_tokens_consumed ?? 0) + codexConsumed;
        state.stats.codex_xp_earned = (state.stats.codex_xp_earned ?? 0) + codexXpOnly;
        state.last_codex_xp = codexXpOnly;
        recordXp(state, codexXpOnly * config.party.filter(Boolean).length);
      }

      commonState.last_turn_ts = Date.now();
      writeCommonState(commonState);
      writeState(state, gen);
      return codexXpOnly > 0 ? 'codex_only' : 'no_delta';
    }

    // Rest bonus activation (before XP calc)
    const now = Date.now();
    const lastTurnTs = commonState.last_turn_ts ?? now;
    const elapsed = now - lastTurnTs;
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let restBonusJustActivated = false;

    if (!state.rest_bonus && elapsed >= TWO_HOURS) {
      if (elapsed >= ONE_DAY) {
        state.rest_bonus = { multiplier: 3.0, turns_remaining: 10 };
      } else if (elapsed >= SIX_HOURS) {
        state.rest_bonus = { multiplier: 2.0, turns_remaining: 5 };
      } else {
        state.rest_bonus = { multiplier: 1.5, turns_remaining: 3 };
      }
      restBonusJustActivated = true;
    }

    const restMult = state.rest_bonus?.multiplier ?? 1.0;

    // Delayed tier: read previous turn's pending_tier for this turn's multipliers
    const appliedTier = getVolumeTierByName(state.pending_tier);
    // Compute NEW tier from this turn's deltaTokens (stored for next turn)
    const currentTier = getVolumeTier(deltaTokens);

    // Calculate XP — common + gen xp_bonus, then tier multiplier
    const tokensPerXp = Math.max(1, config.tokens_per_xp);
    const xpBonus = config.xp_bonus_multiplier + Math.max(0, state.xp_bonus_multiplier - 1.0) + commonState.xp_bonus_multiplier;
    const xpTotal = Math.max(0, Math.floor((deltaTokens / tokensPerXp) * xpBonus * appliedTier.xpMultiplier));
    // All party members receive the full XP (not divided)
    // On Codex-only turns (deltaTokens <= 0), Claude XP is 0 — skip Claude XP award loop
    // deltaTokens is always > 0 here (<=0 handled by early return above)
    const xpPerPokemon = Math.max(1, xpTotal);

    const pokemonDB = getPokemonDB();
    let totalXpGranted = 0;

    // One-time config party migration: swap shiny pokemon to shiny keys
    for (let i = 0; i < config.party.length; i++) {
      const member = config.party[i];
      if (!isShinyKey(member) && state.pokemon[member]?.shiny && state.pokemon[toShinyKey(member)]) {
        config.party[i] = toShinyKey(member);
        state.pokemon[member].shiny = false;
      }
    }
    // Also migrate default_dispatch
    if (config.default_dispatch && !isShinyKey(config.default_dispatch) &&
        state.pokemon[config.default_dispatch]?.shiny && state.pokemon[toShinyKey(config.default_dispatch)]) {
      config.default_dispatch = toShinyKey(config.default_dispatch);
    }

    for (const pokemonName of config.party) {
      if (!pokemonName) continue;

      // Ensure pokemon entry exists
      const pData = pokemonDB.pokemon[toBaseId(pokemonName)];
      if (!state.pokemon[pokemonName]) {
        state.pokemon[pokemonName] = {
          id: pData?.id ?? 0,
          xp: 0,
          level: 1,
          friendship: 0,
          ev: 0,
        };
      }

      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      const currentXp = state.pokemon[pokemonName].xp;
      const currentLevel = state.pokemon[pokemonName].level;
      const floor = getTurnFloor(currentLevel);
      const finalXp = Math.floor(Math.max(floor, xpPerPokemon) * restMult);
      totalXpGranted += finalXp;
      const newXp = currentXp + finalXp;
      const newLevel = xpToLevel(newXp, expGroup);

      // Update state
      state.pokemon[pokemonName].xp = newXp;
      state.pokemon[pokemonName].level = newLevel;

      // Friendship gain per session
      addFriendship(state, pokemonName, FRIENDSHIP_PER_SESSION);

      // Level-up notification + friendship
      if (newLevel > currentLevel) {
        messages.push(t('hook.levelup', { pokemon: getPokemonName(pokemonName), from: currentLevel, to: newLevel, xp: finalXp }));
        addFriendship(state, pokemonName, FRIENDSHIP_PER_LEVELUP);
        playSfx('levelup');
      }

      // Check evolution with context
      const evoContext = {
        oldLevel: currentLevel,
        newLevel,
        friendship: state.pokemon[pokemonName]?.friendship ?? 0,
        currentRegion: config.current_region,
        unlockedAchievements: Object.keys(state.achievements).filter(k => state.achievements[k]),
        items: state.items ?? {},
      };
      const evolution = checkEvolution(pokemonName, evoContext, state);
      if (evolution) {
        applyEvolution(state, config, evolution, newXp);
        messages.push(t('hook.evolution', { pokemon: getPokemonName(pokemonName), newPokemon: getPokemonName(evolution.newPokemon) }));
        playSfx('gacha');

        // Check first_evolution achievement immediately
        const achEvents = checkAchievements(state, config, commonState);
        for (const achEvent of achEvents) {
          const msg = formatAchievementMessage(achEvent);
          messages.push(msg);
          achievementMessages.push(msg);
        }
      }
    }

    // ── Codex flat XP (no volume tier / rest bonus, normal turn) ──
    const codexTotalTokens = readCodexTotalTokens();
    // First-stop and no-delta early exits above intentionally skip this block;
    // any Codex tokens consumed during those turns are deferred to the next qualifying stop.
    const codexPrev = commonState.last_codex_tokens_total ?? 0;
    const codexDelta = Math.max(0, codexTotalTokens - codexPrev);
    let codexXpTotal = 0;

    if (codexDelta > 0) {
      codexXpTotal = Math.max(0, Math.floor(codexDelta / tokensPerXp));

      if (codexXpTotal > 0) {
        for (const pokemonName of config.party) {
          if (!pokemonName) continue;
          if (!state.pokemon[pokemonName]) continue;

          const expGroup: ExpGroup = pokemonDB.pokemon[toBaseId(pokemonName)]?.exp_group ?? 'medium_fast';
          const prevLevel = state.pokemon[pokemonName].level;
          state.pokemon[pokemonName].xp += codexXpTotal;
          state.pokemon[pokemonName].level = xpToLevel(state.pokemon[pokemonName].xp, expGroup);

          if (state.pokemon[pokemonName].level > prevLevel) {
            messages.push(t('hook.levelup', { pokemon: getPokemonName(pokemonName), from: prevLevel, to: state.pokemon[pokemonName].level, xp: codexXpTotal }));
            addFriendship(state, pokemonName, FRIENDSHIP_PER_LEVELUP);
            playSfx('levelup');
          }
        }

        totalXpGranted += codexXpTotal * config.party.filter(Boolean).length;

        // Advance checkpoint by consumed tokens only; remainder is retained.
        // E.g., delta=15000, tokensPerXp=10000 → 1 XP, checkpoint advances by 10000, 5000 retained.
        commonState.last_codex_tokens_total = codexPrev + codexXpTotal * tokensPerXp;

        // Track in stats (count only consumed tokens, not full delta — remainder is re-counted next turn)
        const codexConsumedNormal = codexXpTotal * tokensPerXp;
        state.stats.codex_tokens_consumed = (state.stats.codex_tokens_consumed ?? 0) + codexConsumedNormal;
        state.stats.codex_xp_earned = (state.stats.codex_xp_earned ?? 0) + codexXpTotal;
      }
    }

    // Record XP in stats (total XP earned across all party members, including Codex)
    recordXp(state, totalXpGranted);

    // Update session tokens tracking & total
    state.last_session_tokens[sessionId] = totalTokens;
    const activeIds = new Set(Object.keys(genMap));
    state.last_session_tokens = pruneSessionTokens(state.last_session_tokens, activeIds);
    state.total_tokens_consumed += deltaTokens;
    if (lastCacheTokens > 0) state.context_tokens_used = lastCacheTokens;

    // Sync common trigger counters
    commonState.total_tokens_consumed += deltaTokens;

    // Store new tier for next turn's application (status bar reads this)
    // Note: appliedTier (from previous pending_tier) controls this turn's XP, encounter rate, AND rarity weights
    state.pending_tier = currentTier.name === 'normal' ? null : currentTier.name;

    // Store Codex XP for status-line display (persisted, cleared next turn)
    state.last_codex_xp = codexXpTotal > 0 ? codexXpTotal : null;

    // Check gen-specific achievements (pass commonState for cross-state encounter_rate_bonus writes)
    const achEvents2 = checkAchievements(state, config, commonState);
    for (const achEvent of achEvents2) {
      const msg = formatAchievementMessage(achEvent);
      messages.push(msg);
      achievementMessages.push(msg);
      if (achEvent.rewardPokemon) playSfx('gacha');
    }

    // Sync pokedex from unlocked pokemon
    syncPokedexFromUnlocked(state);

    // Snapshot counters before encounter for delta-based common sync
    const preBattleCount = state.battle_count ?? 0;
    const preBattleWins = state.battle_wins ?? 0;
    const preCatchCount = state.catch_count ?? 0;
    const preEvolutionCount = state.evolution_count ?? 0;

    // Random encounter + battle (with volume tier and commonState)
    try {
      const battleResult = processEncounter(state, config, appliedTier, commonState, restMult);
      if (battleResult) {
        state.last_battle = battleResult;
        const battleMsg = formatEncounterMessage(battleResult);
        if (battleMsg) messages.push(battleMsg);

        // Record battle stats
        recordEncounter(state);
        recordBattle(state, battleResult.won);
        recordXp(state, battleResult.xpReward);
        if (battleResult.caught) recordCatch(state);

        // Record shiny stats
        if (battleResult.shiny) {
          recordShinyEncounter(state);
          if (battleResult.caught) {
            recordShinyCatch(state);
            markShinyCaught(state, toBaseId(battleResult.defender));
          } else {
            recordShinyEscaped(state);
          }
        }

        // Auto-add caught pokemon to party if below max
        if (battleResult.caught && config.party.length < config.max_party_size) {
          if (!config.party.includes(battleResult.defender)) {
            config.party.push(battleResult.defender);
            messages.push(t('hook.party_join', { pokemon: getPokemonName(battleResult.defender) }));
          }
        }
        battleResult.partyFull = config.party.length >= config.max_party_size;

        if (battleResult.won) {
          playSfx('victory');
          if (battleResult.caught) playSfx('gacha');
        } else {
          playSfx('defeat');
        }
      }
    } catch (err) {
      process.stderr.write(`tokenmon encounter error: ${err}\n`);
    }

    // Post-encounter counter sync to commonState (delta-based, not Math.max)
    commonState.battle_count += (state.battle_count ?? 0) - preBattleCount;
    commonState.battle_wins += (state.battle_wins ?? 0) - preBattleWins;
    commonState.catch_count += (state.catch_count ?? 0) - preCatchCount;
    commonState.evolution_count += (state.evolution_count ?? 0) - preEvolutionCount;

    // Check common achievements AFTER counter sync so battle/catch-based achievements
    // (battle_50, battle_wins_25, ten_catches etc.) unlock on the triggering turn
    const commonAchEvents = checkCommonAchievements(commonState, config, state);
    for (const achEvent of commonAchEvents) {
      const msg = formatAchievementMessage(achEvent);
      messages.push(msg);
      achievementMessages.push(msg);
      if (achEvent.rewardPokemon) playSfx('gacha');
    }

    // Rest bonus activation tip (overrides random tip for this turn)
    if (restBonusJustActivated && state.rest_bonus) {
      const hours = Math.max(1, Math.floor(elapsed / (60 * 60 * 1000)));
      state.last_tip = {
        id: 'rest_activate',
        text: t('rest.activate', { hours, turns: state.rest_bonus.turns_remaining, mult: state.rest_bonus.multiplier }),
      };
    } else if (!state.last_battle && config.tips_enabled && getRandomTip) {
      // Show tip when no battle occurred
      const tip = getRandomTip(state, config);
      if (tip) state.last_tip = tip;
    }

    // Non-battle turn ball drop: 10% base chance, 1~3 balls (soft-capped by inventory)
    state.last_drop = null;
    const dropRate = 0.10 * getDropRateMultiplier(state);
    if (!state.last_battle && Math.random() < dropRate) {
      const dropCount = randInt(1, 3);
      addItem(state, 'pokeball', dropCount);
      const gen = getActiveGeneration();
      const regionMsg = getRegionDropMessage(gen, config.current_region, globalConfig.voice_tone as 'claude' | 'pokemon', (config.language ?? 'en') as 'ko' | 'en');
      const dropMsg = regionMsg
        ? `${regionMsg} 🔴×${dropCount}`
        : t('item_drop.generic', { n: dropCount });
      state.last_drop = dropMsg;
      messages.push(dropMsg);
    }

    // Rest bonus countdown (XP-granting turns only)
    if (state.rest_bonus) {
      state.rest_bonus.turns_remaining--;
      if (state.rest_bonus.turns_remaining <= 0) {
        delete state.rest_bonus;
      }
    }

    // Update last_turn_ts on main XP path
    commonState.last_turn_ts = Date.now();

    // Refresh last_seen to prevent pruning of active sessions
    if (genMap[sessionId]) {
      genMap[sessionId].last_seen = new Date().toISOString();
      writeSessionGenMap(genMap);
    }

    // Migrate classic → claude voice_tone under lock (one-time, deferred from pre-lock read)
    if (needsVoiceToneMigration) {
      const gc = readGlobalConfig();
      gc.voice_tone = 'claude';
      writeGlobalConfig(gc);
    }

    state.last_achievement = achievementMessages.length > 0 ? achievementMessages.join('\n') : null;

    writeState(state, gen);
    writeConfig(config, gen);
    writeCommonState(commonState);

    return 'done';
  }, 2, 3000);

  // Lock failed — skip gracefully (state not mutated)
  if (!result.acquired) {
    process.stderr.write(`tokenmon stop: lock timeout after retries, session ${sessionId} XP may be lost\n`);
    playCry();
    console.log(JSON.stringify(output));
    return;
  }

  if (result.value === 'first_stop' || result.value === 'no_delta') {
    playCry();
    console.log(JSON.stringify(output));
    return;
  }

  if (messages.length > 0) {
    output.system_message = messages.join('\n');
  }

  playCry();
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  process.stderr.write(`tokenmon stop: ${err}\n`);
  console.log('{"continue": true}');
});
