#!/usr/bin/env -S npx tsx
/**
 * Battle Turn CLI — conversation-based gym battle via temp state file.
 *
 * Usage:
 *   npx tsx src/cli/battle-turn.ts --init --gym 1 --gen gen4
 *   npx tsx src/cli/battle-turn.ts --action 1        # use move 1
 *   npx tsx src/cli/battle-turn.ts --action 5        # switch menu
 *   npx tsx src/cli/battle-turn.ts --action switch:2 # switch to index 2
 *   npx tsx src/cli/battle-turn.ts --action 6        # surrender
 *   npx tsx src/cli/battle-turn.ts --end             # clean up
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createBattlePokemon, createBattleState, resolveTurn, getActivePokemon, hasAlivePokemon } from '../core/turn-battle.js';
import { selectAiAction } from '../core/gym-ai.js';
import { getGymById, awardGymVictory, canChallengeGym } from '../core/gym.js';
import { getPokemonDB, getPokemonName, speciesIdToGeneration } from '../core/pokemon-data.js';
import { getActiveGeneration } from '../core/paths.js';
import { initLocale, t } from '../i18n/index.js';
import { readGlobalConfig, readConfig, writeConfig } from '../core/config.js';
import { checkAchievements, checkCommonAchievements, formatAchievementMessage } from '../core/achievements.js';
import { withLockRetry } from '../core/lock.js';
import { readState, writeState, readCommonState, writeCommonState } from '../core/state.js';
import { loadGymData } from '../core/gym.js';
import {
  STATE_DIR,
  readBattleState,
  writeBattleState,
  deleteBattleState,
} from '../core/battle-state-io.js';
import { fallbackMoves, loadMovesData, getLoadedMovesDB, getMovesForPokemon, getDisplayName } from '../core/battle-setup.js';
import type { BattleStateFile } from '../core/battle-state-io.js';
import type { State, Config, MoveData, GymData, BattleState, BattlePokemon, TurnAction } from '../core/types.js';

// ── CLI Arg Parsing ──

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// ── Output Helpers ──

interface PokemonInfo {
  name: string;
  species: number;
  level: number;
  hp: number;
  maxHp: number;
}

function pokemonInfo(p: BattlePokemon): PokemonInfo {
  return {
    name: p.displayName,
    species: p.id,
    level: p.level,
    hp: p.currentHp,
    maxHp: p.maxHp,
  };
}

function buildMenu(player: BattlePokemon): string {
  const moveNames = player.moves
    .map((m, i) => `${i + 1}.${m.data.nameKo}`)
    .join(' ');
  return `${moveNames}\n5.교체 6.항복`;
}

function output(data: Record<string, unknown>): void {
  const payload: Record<string, unknown> = {
    ...data,
  };
  if (!Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
    payload.sessionId = null;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'phase')) {
    payload.phase = null;
  }
  console.log(JSON.stringify(payload));
}

function buildQuestionContext(player: BattlePokemon, opponent: BattlePokemon): string {
  return `⚔️ vs ${opponent.displayName} Lv.${opponent.level} HP:${opponent.currentHp}/${opponent.maxHp} | ${player.displayName} Lv.${player.level} HP:${player.currentHp}/${player.maxHp}`;
}

function buildMoveOptions(player: BattlePokemon): Array<{
  index: number;
  nameKo: string;
  pp: number;
  maxPp: number;
  disabled: boolean;
}> {
  return player.moves.map((move, index) => ({
    index: index + 1,
    nameKo: move.data.nameKo,
    pp: move.currentPp,
    maxPp: move.data.pp,
    disabled: move.currentPp <= 0 || player.fainted,
  }));
}

function buildPartyOptions(
  battleState: BattleState,
  options?: { excludeActive?: boolean; includeFainted?: boolean },
): Array<{
  index: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  fainted: boolean;
}> {
  const excludeActive = options?.excludeActive ?? false;
  const includeFainted = options?.includeFainted ?? true;
  return battleState.player.pokemon
    .map((p, i) => ({ index: i, name: p.displayName, level: p.level, hp: p.currentHp, maxHp: p.maxHp, fainted: p.fainted }))
    .filter((opt) => (!excludeActive || opt.index !== battleState.player.activeIndex) && (includeFainted || !opt.fainted));
}

function buildSwitchOptions(
  battleState: BattleState,
  options?: { excludeActive?: boolean; includeFainted?: boolean },
): Array<{
  index: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
}> {
  return buildPartyOptions(battleState, options)
    .filter((opt) => !opt.fainted)
    .map(({ index, name, level, hp, maxHp }) => ({ index, name, level, hp, maxHp }));
}

function autoSwitchIfForced(battleState: BattleState, messages?: string[]): boolean {
  if (!getActivePokemon(battleState.player).fainted) return false;
  const switchOptions = buildSwitchOptions(battleState, { includeFainted: false });
  if (switchOptions.length !== 1) return false;

  battleState.player.activeIndex = switchOptions[0].index;
  battleState.phase = 'select_action';
  if (messages) {
    messages.push(t('battle.go', { pokemon: getActivePokemon(battleState.player).displayName }));
  }
  return true;
}

function withBattleMetadata(
  bsf: BattleStateFile | null | undefined,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!bsf) {
    return {
      ...data,
      sessionId: null,
      phase: null,
    };
  }
  const status = typeof data.status === 'string' ? data.status : undefined;
  const phase = (status === 'switch_menu' || status === 'fainted_switch') ? 'switch_select' : bsf.battleState.phase;
  return {
    ...data,
    sessionId: bsf.sessionId ?? null,
    phase,
  };
}

// ── Init Flow ──

function handleInit(): void {
  const gymIdStr = getArg('gym');
  const generation = getArg('gen') || getActiveGeneration();
  const stateDir = getArg('state-dir') || STATE_DIR;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, '..', '..');

  // Load state & config (must be loaded BEFORE gym resolution so auto mode can read current_region)
  const genDir = join(stateDir, generation);
  const statePath = join(genDir, 'state.json');
  const configPath = join(genDir, 'config.json');

  if (!existsSync(statePath) || !existsSync(configPath)) {
    output({ status: 'error', messages: [`State or config not found in ${genDir}`] });
    process.exit(1);
  }

  let state: State;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err) {
    output({ status: 'error', messages: [`Failed to parse state: ${statePath}`] });
    process.exit(1);
  }

  let config: Config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    output({ status: 'error', messages: [`Failed to parse config: ${configPath}`] });
    process.exit(1);
  }

  // Load pokemon DB
  let db: ReturnType<typeof getPokemonDB>;
  try {
    db = getPokemonDB(generation);
  } catch {
    output({ status: 'error', messages: [`Failed to load pokemon DB for ${generation}`] });
    process.exit(1);
  }

  // Resolve target gym.
  //
  // Explicit gym id (e.g. `--gym 3`): honor it as before.
  // Missing or `--gym auto`: look up the gym for the player's current_region.
  //   Each region has exactly one gym. If the region's badge is already earned,
  //   reject entry with a "already cleared" message instead of routing to any gym.
  let gym: ReturnType<typeof getGymById>;
  if (gymIdStr && gymIdStr !== 'auto') {
    const explicitId = parseInt(gymIdStr, 10);
    gym = getGymById(generation, explicitId);
    if (!gym) {
      output({ status: 'error', messages: [`Gym ${explicitId} not found for ${generation}`] });
      process.exit(1);
    }
  } else {
    const currentRegion = config.current_region;
    if (!currentRegion) {
      output({ status: 'error', messages: ['current_region is not set in config; cannot resolve gym automatically'] });
      process.exit(1);
    }
    const allGyms = loadGymData(generation);
    const regionGym = allGyms.find((g) => g.region === currentRegion);
    if (!regionGym) {
      output({ status: 'error', messages: [`No gym found for region ${currentRegion} in ${generation}`] });
      process.exit(1);
    }
    const badges = state.gym_badges ?? [];
    if (badges.includes(regionGym.badge)) {
      output({
        status: 'rejected',
        messages: [
          `이 지역(${currentRegion})의 체육관은 이미 클리어했어. 다른 지역으로 이동해야 새 체육관에 도전할 수 있어.`,
        ],
      });
      process.exit(0);
    }
    gym = regionGym;
  }

  const gymId = gym.id;

  // Gate check: player must meet conditions to challenge this gym
  const gateResult = canChallengeGym(gym, state, config, generation);
  if (!gateResult.allowed) {
    output({
      status: 'rejected',
      messages: [
        t('gym.gate_rejected', {
          caught: String(gateResult.caught),
          required: String(gateResult.requiredCaught),
          avgLevel: String(gateResult.avgLevel),
          requiredLevel: String(gateResult.requiredLevel),
        }),
      ],
    });
    process.exit(0);
  }

  // Load move data
  loadMovesData(pluginRoot);

  // Build player team from config.party + state.pokemon
  const playerPartyNames: string[] = [];
  const playerTeam = config.party
    .filter((name) => state.pokemon[name])
    .map((name) => {
      playerPartyNames.push(name);
      const pState = state.pokemon[name];
      const pData = db.pokemon[String(pState.id)];
      if (!pData) {
        const moves = fallbackMoves(['normal'], pState.level);
        return createBattlePokemon(
          { id: pState.id, types: ['normal'], level: pState.level, baseStats: { hp: 50, attack: 50, defense: 50, speed: 50 } },
          moves,
        );
      }
      const displayName = pState.nickname || getPokemonName(pState.id, generation);
      const moves = getMovesForPokemon(pState.id, pState.level, pData.types);
      return createBattlePokemon(
        { id: pState.id, types: pData.types, level: pState.level, baseStats: pData.base_stats, displayName },
        moves,
      );
    });

  if (playerTeam.length === 0) {
    output({ status: 'error', messages: ['No valid pokemon in party'] });
    process.exit(1);
  }

  // Build gym team
  const gymTeam = gym.team.map((gp) => {
    let pData = db.pokemon[String(gp.species)];
    if (!pData) {
      // Cross-gen lookup: gym pokemon might be from a different generation
      const nativeGen = speciesIdToGeneration(gp.species);
      if (nativeGen !== generation) {
        const nativeDb = getPokemonDB(nativeGen);
        pData = nativeDb.pokemon[String(gp.species)];
      }
    }
    const types = pData?.types ?? ['normal'];
    const baseStats = pData?.base_stats ?? { hp: 50, attack: 50, defense: 50, speed: 50 };
    const displayName = getDisplayName(gp.species, generation);

    let moves: MoveData[];
    const mdb = getLoadedMovesDB();
    if (gp.moves && gp.moves.length > 0 && mdb) {
      moves = gp.moves
        .map((mId) => mdb[String(mId)])
        .filter((m): m is MoveData => !!m);
      if (moves.length === 0) {
        moves = getMovesForPokemon(gp.species, gp.level, types);
      }
    } else {
      moves = getMovesForPokemon(gp.species, gp.level, types);
    }

    return createBattlePokemon(
      { id: gp.species, types, level: gp.level, baseStats, displayName },
      moves,
    );
  });

  if (gymTeam.length === 0) {
    output({ status: 'error', messages: ['Gym has no pokemon'] });
    process.exit(1);
  }

  // Clean up any stale terminal battle state before starting a new one
  const existingBsf = readBattleState();
  const currentSessionId = process.env.CLAUDE_SESSION_ID;
  const isExistingBattleLive = !!existingBsf
    && existingBsf.battleState.phase !== 'battle_end';
  if (isExistingBattleLive) {
    if (existingBsf.sessionId && currentSessionId && existingBsf.sessionId !== currentSessionId) {
      output(withBattleMetadata(existingBsf, {
        status: 'rejected',
        messages: [t('battle.other_session')],
      }));
      process.exit(0);
    }
  } else if (existingBsf) {
    deleteBattleState();
  }

  // Create battle state
  const battleState = createBattleState(playerTeam, gymTeam);

  // Save
  const bsf: BattleStateFile = {
    battleState,
    gym,
    generation,
    stateDir,
    playerPartyNames,
    sessionId: process.env.CLAUDE_SESSION_ID || randomUUID(),
  };
  writeBattleState(bsf);

  // Output initial state
  const playerActive = getActivePokemon(battleState.player);
  const opponentActive = getActivePokemon(battleState.opponent);

  output(withBattleMetadata(bsf, {
    status: 'ongoing',
    messages: [
      t('battle.gym_challenge', { leader: gym.leaderKo }),
      t('battle.send_out', { leader: gym.leaderKo, pokemon: opponentActive.displayName }),
      t('battle.go', { pokemon: playerActive.displayName }),
    ],
    menu: buildMenu(playerActive),
    moveOptions: buildMoveOptions(playerActive),
    opponent: pokemonInfo(opponentActive),
    player: pokemonInfo(playerActive),
    badge: null,
    questionContext: buildQuestionContext(playerActive, opponentActive),
  }));
}

// ── Action Flow ──

function handleAction(): void {
  const actionStr = getArg('action');
  if (!actionStr) {
    output({ status: 'error', messages: ['--action <N|switch:N> is required'] });
    process.exit(1);
  }

  const bsf = readBattleState();
  if (!bsf) {
    output({ status: 'error', messages: ['No active battle. Use --init to start one.'] });
    process.exit(1);
  }

  // Session ownership check: only enforce when CLAUDE_SESSION_ID env var exists.
  // Each CLI invocation is a new process (different PID), so PID-based checks
  // would always fail. Skip check entirely for single-user CLI usage.
  if (bsf.sessionId && process.env.CLAUDE_SESSION_ID && bsf.sessionId !== process.env.CLAUDE_SESSION_ID) {
    output({ status: 'error', messages: [t('battle.other_session')] });
    process.exit(1);
  }

  // Guard: reject actions on battles that have already ended
  if (bsf.battleState.phase === 'battle_end') {
    deleteBattleState();
    output({ status: 'error', messages: ['Battle has already ended. State cleaned up.'] });
    process.exit(1);
  }

  const { battleState, gym, generation, stateDir, playerPartyNames } = bsf;

  // Parse action
  let playerAction: TurnAction;

  if (actionStr.startsWith('switch:')) {
    // switch:N — switch to pokemon index N
    const targetIndex = parseInt(actionStr.split(':')[1], 10);
    const targetPokemon = battleState.player.pokemon[targetIndex];
    if (!targetPokemon || targetPokemon.fainted || targetIndex === battleState.player.activeIndex) {
      output({
        status: 'error',
        messages: ['Invalid switch target.'],
      });
      process.exit(1);
    }
    playerAction = { type: 'switch', pokemonIndex: targetIndex };
  } else {
    const actionNum = parseInt(actionStr, 10);

    if (actionNum >= 1 && actionNum <= 4) {
      // Move 1-4
      const moveIndex = actionNum - 1;
      const playerActive = getActivePokemon(battleState.player);
      if (moveIndex >= playerActive.moves.length) {
        output({ status: 'error', messages: [`Move ${actionNum} does not exist.`] });
        process.exit(1);
      }
      playerAction = { type: 'move', moveIndex };
    } else if (actionNum === 5) {
      // Switch menu
      return handleSwitchMenu(battleState);
    } else if (actionNum === 6) {
      // Surrender
      playerAction = { type: 'surrender' };
    } else {
      output({ status: 'error', messages: [`Invalid action: ${actionStr}`] });
      process.exit(1);
    }
  }

  // Get AI action
  const playerActive = getActivePokemon(battleState.player);
  const opponentActive = getActivePokemon(battleState.opponent);

  let aiAction: TurnAction;
  if (playerAction.type === 'surrender') {
    aiAction = { type: 'move', moveIndex: 0 };
  } else {
    aiAction = selectAiAction(opponentActive, playerActive);
  }

  // Resolve turn
  const turnResult = resolveTurn(battleState, playerAction, aiAction);
  const messages = [...turnResult.messages];

  // Post-turn handling
  // Opponent fainted but has more — auto-switch AI
  if (turnResult.opponentFainted && hasAlivePokemon(battleState.opponent)) {
    const nextIdx = battleState.opponent.pokemon.findIndex(
      (p, i) => i !== battleState.opponent.activeIndex && !p.fainted,
    );
    if (nextIdx !== -1) {
      battleState.opponent.activeIndex = nextIdx;
      const newActive = getActivePokemon(battleState.opponent);
      messages.push(t('battle.send_out', { leader: gym.leaderKo, pokemon: newActive.displayName }));
    }
  }

  if (battleState.winner === 'player') {
    writeBattleState(bsf);
    return handleVictory(bsf, messages);
  }
  if (battleState.winner === 'opponent') {
    return handleDefeat(bsf, messages);
  }

  // Player fainted + has more → fainted_switch
  if (battleState.phase === 'fainted_switch') {
    writeBattleState(bsf);
    return handleFaintedSwitch(bsf, messages);
  }

  // Normal continuation
  writeBattleState(bsf);

  const currentPlayer = getActivePokemon(battleState.player);
  const currentOpponent = getActivePokemon(battleState.opponent);

  output(withBattleMetadata(bsf, {
    status: 'ongoing',
    messages,
    menu: buildMenu(currentPlayer),
    moveOptions: buildMoveOptions(currentPlayer),
    opponent: pokemonInfo(currentOpponent),
    player: pokemonInfo(currentPlayer),
    badge: null,
    questionContext: buildQuestionContext(currentPlayer, currentOpponent),
  }));
}

// ── Switch Menu ──

function handleSwitchMenu(battleState: BattleState): void {
  const bsf = readBattleState();
  const switchOptions = buildSwitchOptions(battleState, { excludeActive: true, includeFainted: false });

  if (switchOptions.length === 0) {
    const p = getActivePokemon(battleState.player);
    const o = getActivePokemon(battleState.opponent);
    output(withBattleMetadata(bsf, {
      status: 'ongoing',
      messages: [t('battle.no_switch')],
      menu: buildMenu(p),
      moveOptions: buildMoveOptions(p),
      opponent: pokemonInfo(o),
      player: pokemonInfo(p),
      badge: null,
      questionContext: buildQuestionContext(p, o),
    }));
    return;
  }

  output(withBattleMetadata(bsf, {
    status: 'switch_menu',
    messages: [t('battle.select_switch')],
    switchOptions,
    partyOptions: buildPartyOptions(battleState, { excludeActive: true, includeFainted: true }),
    questionContext: buildQuestionContext(getActivePokemon(battleState.player), getActivePokemon(battleState.opponent)),
  }));
}

// ── Fainted Switch ──

function handleFaintedSwitch(bsf: BattleStateFile, messages: string[]): void {
  const { battleState } = bsf;
  const switchOptions = buildSwitchOptions(battleState, { includeFainted: false });

  if (switchOptions.length === 0) {
    // Should not happen (battle_end would have triggered), but handle gracefully
    output(withBattleMetadata(bsf, {
      status: 'defeat',
      messages: [...messages, t('battle.all_fainted')],
      badge: null,
      opponent: pokemonInfo(getActivePokemon(battleState.opponent)),
      player: pokemonInfo(getActivePokemon(battleState.player)),
    }));
    return;
  }

  // Auto-switch if only 1 option
  if (switchOptions.length === 1) {
    autoSwitchIfForced(battleState, messages);
    const newActive = getActivePokemon(battleState.player);

    // Re-save after auto-switch
    const bsf = readBattleState()!;
    bsf.battleState = battleState;
    writeBattleState(bsf);

    const opp = getActivePokemon(battleState.opponent);
    output(withBattleMetadata(bsf, {
      status: 'ongoing',
      messages,
      menu: buildMenu(newActive),
      moveOptions: buildMoveOptions(newActive),
      opponent: pokemonInfo(opp),
      player: pokemonInfo(newActive),
      badge: null,
      questionContext: buildQuestionContext(newActive, opp),
    }));
    return;
  }

  output(withBattleMetadata(bsf, {
    status: 'fainted_switch',
    messages: [...messages, t('battle.select_next')],
    switchOptions,
    partyOptions: buildPartyOptions(battleState, { excludeActive: true, includeFainted: true }),
    questionContext: `⚔️ vs ${getActivePokemon(battleState.opponent).displayName} — ${t('battle.select_next')}`,
  }));
}

// ── Victory ──

function handleVictory(bsf: BattleStateFile, messages: string[]): void {
  const { battleState, gym, generation, playerPartyNames } = bsf;

  messages.push(t('battle.victory', { leader: gym.leaderKo }));

  // Re-read state inside lock to avoid overwriting hook changes
  const lockResult = withLockRetry(() => {
    const freshState = readState(generation);
    const config = readConfig(generation);
    const commonState = readCommonState();
    const result = awardGymVictory(freshState, gym, playerPartyNames);

    // Check achievements immediately after badge earned (pass commonState for encounter_rate_bonus)
    const achEvents = result.badgeEarned ? checkAchievements(freshState, config, commonState, generation) : [];

    // Update common badge aggregates and check common achievements
    let commonAchEvents: ReturnType<typeof checkCommonAchievements> = [];
    if (result.badgeEarned) {
      commonState.total_gym_badges += 1;

      // Check if current gen is now fully complete
      const gyms = loadGymData(generation);
      const badges = freshState.gym_badges ?? [];
      if (gyms.length > 0 && gyms.every(g => badges.includes(g.badge))) {
        let completedCount = 0;
        for (const genKey of ['gen1','gen2','gen3','gen4','gen5','gen6','gen7','gen8','gen9']) {
          const genGyms = loadGymData(genKey);
          const genState = genKey === generation ? freshState : readState(genKey);
          const genBadges = genState.gym_badges ?? [];
          if (genGyms.length > 0 && genGyms.every(g => genBadges.includes(g.badge))) {
            completedCount++;
          }
        }
        commonState.completed_gym_gens = completedCount;
      }

      commonAchEvents = checkCommonAchievements(commonState, config, freshState);
    }

    writeState(freshState, generation);
    writeCommonState(commonState);
    writeConfig(config, generation);
    return { ...result, achEvents: [...achEvents, ...commonAchEvents], badgeCount: (freshState.gym_badges ?? []).length };
  });

  if (!lockResult.acquired) {
    output({ status: 'error', messages: ['Failed to acquire state lock for victory update.'] });
    process.exit(1);
  }

  const victoryResult = lockResult.value;

  // Badge notification messages
  if (victoryResult.badgeEarned) {
    const isChampion = gym.badge.startsWith('champion_');
    if (isChampion) {
      messages.push('═══════════════════════════════');
      messages.push(`  🏆 ${t('gym.champion_victory_header')} 🏆`);
      messages.push(`  ${t('gym.champion_victory_detail', { region: gym.badgeKo.replace(/ 챔피언배지$/, ''), leader: gym.leaderKo })}`);
      for (const achEvent of victoryResult.achEvents) {
        messages.push(`  ${formatAchievementMessage(achEvent)}`);
      }
      messages.push('═══════════════════════════════');
    } else {
      messages.push(t('gym.badge_earned', { badge: gym.badgeKo, leader: gym.leaderKo, count: victoryResult.badgeCount }));
      for (const achEvent of victoryResult.achEvents) {
        messages.push(formatAchievementMessage(achEvent));
      }
    }
  }

  deleteBattleState();

  output(withBattleMetadata(bsf, {
    status: 'victory',
    messages,
    badge: {
      name: gym.badgeKo,
      earned: victoryResult.badgeEarned,
      xp: victoryResult.xpAwarded,
      count: victoryResult.badgeCount,
      total: 8,
    },
    achievements: victoryResult.achEvents.map(e => ({ id: e.id, name: e.name })),
    opponent: pokemonInfo(getActivePokemon(battleState.opponent)),
    player: pokemonInfo(getActivePokemon(battleState.player)),
  }));
}

// ── Defeat ──

function handleDefeat(bsf: BattleStateFile, messages: string[]): void {
  const { battleState, gym } = bsf;

  messages.push(t('battle.defeat', { leader: gym.leaderKo }));

  deleteBattleState();

  output(withBattleMetadata(bsf, {
    status: 'defeat',
    messages,
    badge: null,
    opponent: pokemonInfo(getActivePokemon(battleState.opponent)),
    player: pokemonInfo(getActivePokemon(battleState.player)),
  }));
}

// ── End Flow ──

function handleEnd(): void {
  const bsf = readBattleState();
  deleteBattleState();
  output(withBattleMetadata(bsf, { status: 'ended', messages: ['Battle state cleared.'] }));
}

// ── Signal Handlers ──

function setupSignalHandlers(): void {
  const cleanup = () => {
    // Don't delete battle state — let user resume or --end manually
    process.exit(1);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ── Main ──

function main(): void {
  // Initialize locale so getPokemonName returns Korean names when language is 'ko'
  const globalConfig = readGlobalConfig();
  initLocale(globalConfig.language);

  setupSignalHandlers();

  try {
    if (hasFlag('init')) {
      handleInit();
    } else if (hasFlag('end')) {
      handleEnd();
    } else if (getArg('action') !== undefined) {
      handleAction();
    } else {
      output({
        status: 'error',
        messages: [
          'Usage:',
          '  --init --gym <id> --gen <gen>   Start battle',
          '  --action <1-4|5|6|switch:N>     Take action',
          '  --end                            Clean up',
        ],
      });
      process.exit(1);
    }
  } catch (err: any) {
    output({
      status: 'error',
      messages: [err.message || 'Unknown error'],
    });
    process.exit(1);
  }
}

main();
