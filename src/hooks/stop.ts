import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readState, writeState, pruneSessionTokens, readSessionGenMap, writeSessionGenMap, readCommonState, writeCommonState, readSession } from '../core/state.js';
import { readConfig, writeConfig, readGlobalConfig, writeGlobalConfig } from '../core/config.js';
import { getPokemonDB, getPokemonName, ensurePokemonInDB } from '../core/pokemon-data.js';
import { levelToXp, xpToLevel } from '../core/xp.js';
import { checkEvolution, addFriendship, FRIENDSHIP_PER_LEVELUP, FRIENDSHIP_PER_SESSION } from '../core/evolution.js';
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
import { setActiveGenerationCache, getActiveGeneration, DATA_DIR, PLUGIN_ROOT } from '../core/paths.js';
import { isShinyKey, toBaseId, toShinyKey } from '../core/shiny-utils.js';
import { recordXp, recordBattle, recordCatch, recordEncounter, recordShinyEncounter, recordShinyCatch, recordShinyEscaped } from '../core/stats.js';
import { loadGymData } from '../core/gym.js';
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

    // Self-healing: remove party entries not in state.unlocked (fix #49 migration edge case)
    if (state.unlocked.length > 0) {
      const partyBefore = config.party.length;
      config.party = config.party.filter(p => state.unlocked.includes(p));
      if (config.party.length !== partyBefore) {
        writeConfig(config, gen);
      }
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

      // First Codex read: set baseline only, no XP (prevents historical backlog from flooding XP)
      if (codexPreCheck > 0 && codexPrev === 0 && commonState.last_codex_tokens_total === undefined) {
        commonState.last_codex_tokens_total = codexPreCheck;
        commonState.last_turn_ts = Date.now();
        writeCommonState(commonState);
        writeState(state, gen);
        return 'no_delta';
      }

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

    // Build dispatch multiplier map from session agent_assignments
    const session = readSession(gen, sessionId || undefined);
    const dispatchMultipliers = new Map<string, number>();
    for (const a of session.agent_assignments) {
      dispatchMultipliers.set(a.pokemon, a.xp_multiplier);
    }

    // Ensure cross-gen evolved Pokemon are in the DB (e.g., Pikachu in gen2)
    for (const name of config.party) {
      if (name && !pokemonDB.pokemon[name]) ensurePokemonInDB(name);
    }

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
          met: 'wild',
          met_detail: { region: config.current_region, met_level: 1, met_date: new Date().toISOString().split('T')[0] },
        };
      }

      const expGroup: ExpGroup = pData?.exp_group ?? 'medium_fast';
      const currentXp = state.pokemon[pokemonName].xp;
      const currentLevel = state.pokemon[pokemonName].level;
      const floor = getTurnFloor(currentLevel);
      const dispatchMult = dispatchMultipliers.get(pokemonName) ?? 1.0;
      const finalXp = Math.floor(Math.max(floor, xpPerPokemon) * restMult * dispatchMult);
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
      // Flag-based evolution: checkEvolution sets evolution_ready on the state
      // for both branch and single-chain evolutions. Auto-evolve no longer happens
      // here — block emission in post-lock scan triggers AskUserQuestion flow.
      checkEvolution(pokemonName, evoContext, state);
    }

    // ── Codex flat XP (no volume tier / rest bonus, normal turn) ──
    const codexTotalTokens = readCodexTotalTokens();
    const codexPrev = commonState.last_codex_tokens_total ?? 0;
    let codexDelta = 0;
    let codexXpTotal = 0;

    // First Codex read: set baseline only, no XP (prevents historical backlog from flooding XP)
    if (codexTotalTokens > 0 && codexPrev === 0 && commonState.last_codex_tokens_total === undefined) {
      commonState.last_codex_tokens_total = codexTotalTokens;
    } else {
      codexDelta = Math.max(0, codexTotalTokens - codexPrev);
    }

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
    const achEvents2 = checkAchievements(state, config, commonState, gen);
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
    const preBadgeCount = (state.gym_badges ?? []).length;

    // Random encounter + battle (with volume tier and commonState)
    try {
      const battleResult = processEncounter(state, config, appliedTier, commonState, restMult, dispatchMultipliers);
      if (battleResult) {
        state.last_battle = battleResult;
        const battleMsg = formatEncounterMessage(battleResult);
        if (battleMsg) messages.push(battleMsg);

        // Record battle stats
        recordEncounter(state);
        recordBattle(state, battleResult.won);
        recordXp(state, battleResult.totalXpApplied ?? battleResult.xpReward);
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

    // Gym badge sync
    const currentBadgeCount = (state.gym_badges ?? []).length;
    commonState.total_gym_badges += currentBadgeCount - preBadgeCount;

    // Check if current gen is fully completed (all badges including champion)
    if (currentBadgeCount > preBadgeCount) {
      const gyms = loadGymData(gen);
      const badges = state.gym_badges ?? [];
      if (gyms.length > 0 && gyms.every(g => badges.includes(g.badge))) {
        // Recalculate completed gens (idempotent, gen completion is rare)
        let completedCount = 0;
        for (const genKey of ['gen1','gen2','gen3','gen4','gen5','gen6','gen7','gen8','gen9']) {
          const genGyms = loadGymData(genKey);
          // Use in-memory state for current gen (not yet written to disk), disk for others
          const genState = genKey === gen ? state : readState(genKey);
          const genBadges = genState.gym_badges ?? [];
          if (genGyms.length > 0 && genGyms.every(g => genBadges.includes(g.badge))) {
            completedCount++;
          }
        }
        commonState.completed_gym_gens = completedCount;
      }
    }

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

  // ── Evolution block detection (post-lock, runs regardless of result type) ──
  // Scan party for pokemon with evolution_ready && !evolution_prompt_shown.
  // If found, emit decision:"block" with a reason instructing Claude to use
  // AskUserQuestion. Runs BEFORE the first_stop/no_delta early return so the
  // prompt fires on the very first turn of a session where evolution is
  // already pending (e.g. after a cheat/test seed, or a resumed session
  // where evolution conditions were met but the user had not yet been
  // prompted). Flag is set AFTER block emission (Risk 6: duplication > loss).
  {
    const postConfig = readConfig(gen);
    const postState = readState(gen);
    const candidates: Array<{ name: string; options: string[] }> = [];
    for (const name of postConfig.party) {
      const ps = postState.pokemon[name];
      if (ps?.evolution_ready && !ps.evolution_prompt_shown) {
        candidates.push({ name, options: ps.evolution_options ?? [] });
      }
    }
    if (candidates.length > 0) {
      const batch = candidates.slice(0, 4);
      const candidateList = batch
        .map(c => t('hook.evolution_candidate_line', {
          pokemon: getPokemonName(c.name),
          targets: c.options.map(o => getPokemonName(o)).join(', '),
        }))
        .join('\n');
      let reason = t('hook.evolution_block_reason', { candidateList });
      // Test-harness awareness: when the dev /tkm:test-evolve harness has an
      // active cycle (marker file at .tokenmon/test-backup/current.json),
      // tack on the verify + restore instructions so Claude closes the
      // cycle inside the same turn even if the skill-invocation context
      // has fallen out of the current prompt window.
      try {
        const currentPtr = join(DATA_DIR, 'test-backup', 'current.json');
        if (existsSync(currentPtr)) {
          const tsxResolve = join(PLUGIN_ROOT, 'bin', 'tsx-resolve.sh');
          const testCli = join(PLUGIN_ROOT, 'src', 'cli', 'test-evolve.ts');
          reason += '\n\n[TEST HARNESS ACTIVE] '
            + 'After you run tokenmon evolve (or after a Refuse), you MUST, in the same turn without stopping, run exactly:\n'
            + `  "${tsxResolve}" "${testCli}" --verify\n`
            + `  "${tsxResolve}" "${testCli}" --restore\n`
            + 'Show both outputs to the user, then print a compact final report (scenario name, pick, verify verdict, restore confirmation).';
        }
      } catch {
        // Harness check is best-effort; missing paths/stat errors must not
        // suppress the core evolution block.
      }
      playCry();
      // Preserve level-up/achievement messages from the parent lock; systemMessage is
      // user-facing only, so merging it here does not interfere with the block reason
      // that Claude consumes.
      const blockOutput: { decision: 'block'; reason: string; system_message?: string } = {
        decision: 'block',
        reason,
      };
      if (messages.length > 0) {
        blockOutput.system_message = messages.join('\n');
      }
      console.log(JSON.stringify(blockOutput));

      // Set evolution_prompt_shown AFTER block emission to avoid silent loss on crash.
      // If this write fails, the block will re-emit on next Stop — duplicate prompt
      // (UX degradation) is strictly preferable to silent infinite-block loops.
      try {
        const lockResult = withLock(() => {
          const s = readState(gen);
          for (const c of batch) {
            if (s.pokemon[c.name]) s.pokemon[c.name].evolution_prompt_shown = true;
          }
          writeState(s, gen);
        });
        if (!lockResult.acquired) {
          process.stderr.write('tokenmon stop: lock busy during evolution_prompt_shown write; will re-prompt next stop\n');
        }
      } catch (err) {
        process.stderr.write(`tokenmon stop: evolution_prompt_shown write failed: ${err}\n`);
      }
      return;
    }
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
