#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SHOW_CURSOR } from './ansi.js';
import { startGameLoop } from './game-loop.js';
import { createBattlePokemon } from '../core/turn-battle.js';
import { getGymById, awardGymVictory, canChallengeGym, loadGymData } from '../core/gym.js';
import { getPokemonName, getPokemonDB, speciesIdToGeneration } from '../core/pokemon-data.js';
import { getActiveGeneration } from '../core/paths.js';
import { initLocale, t, getLocale } from '../i18n/index.js';
import { readGlobalConfig, readConfig, writeConfig } from '../core/config.js';
import { checkAchievements, checkCommonAchievements, formatAchievementMessage } from '../core/achievements.js';
import { readCommonState, readState, writeCommonState, writeState } from '../core/state.js';
import { withLockRetry } from '../core/lock.js';
import { fallbackMoves, loadMovesData, getLoadedMovesDB, getMovesForPokemon, getDisplayName } from '../core/battle-setup.js';
import type { State, Config, MoveData, GymData } from '../core/types.js';

// ── CLI Arg Parsing ──

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ── Main ──

function main(): void {
  // Initialize locale so getPokemonName returns Korean names when language is 'ko'
  const globalConfig = readGlobalConfig();
  initLocale(globalConfig.language);

  const gymIdStr = getArg('gym');
  const generation = getArg('gen') || getActiveGeneration();
  const stateDir = getArg('state-dir') || join(process.env.HOME || '', '.claude', 'tokenmon');
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, '..', '..');

  if (!gymIdStr) {
    console.error('Usage: battle-tui --gym <id> [--gen <generation>] [--state-dir <path>]');
    process.exit(1);
  }

  const gymId = parseInt(gymIdStr, 10);

  // Load state & config
  const genDir = join(stateDir, generation);
  const statePath = join(genDir, 'state.json');
  const configPath = join(genDir, 'config.json');

  if (!existsSync(statePath) || !existsSync(configPath)) {
    console.error(`State or config not found in ${genDir}`);
    process.exit(1);
  }

  const state: State = JSON.parse(readFileSync(statePath, 'utf-8'));
  const config: Config = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Load pokemon DB
  let db: ReturnType<typeof getPokemonDB>;
  try {
    db = getPokemonDB(generation);
  } catch {
    console.error(`Failed to load pokemon DB for ${generation}`);
    process.exit(1);
  }

  // Get gym data
  const gym = getGymById(generation, gymId);
  if (!gym) {
    console.error(`Gym ${gymId} not found for ${generation}`);
    process.exit(1);
  }

  // Gate check: player must meet conditions to challenge this gym
  const gateResult = canChallengeGym(gym, state, config, generation);
  if (!gateResult.allowed) {
    if (gateResult.reason === 'champion_badge_required') {
      console.error(`You must collect all 8 badges before challenging the Champion! (Current badges: ${(state.gym_badges ?? []).length}/8)`);
    } else {
      console.error(`You need to explore more of this region or train your party before challenging this gym! (Pokédex: ${gateResult.caught}/${gateResult.requiredCaught}, Party avg level: Lv.${gateResult.avgLevel}/${gateResult.requiredLevel})`);
    }
    process.exit(1);
  }

  // Load move data (best effort)
  loadMovesData(pluginRoot);

  // Build player team from config.party + state.pokemon
  const playerTeam = config.party
    .filter((name) => state.pokemon[name])
    .map((name) => {
      const pState = state.pokemon[name];
      const pData = db.pokemon[String(pState.id)];
      if (!pData) {
        // Fallback for missing pokemon data
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
    console.error('No valid pokemon in party');
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

    // Try to load specific gym moves first, then fall back
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
    console.error('Gym has no pokemon');
    process.exit(1);
  }

  // Graceful exit handler
  process.on('exit', () => {
    process.stdout.write(SHOW_CURSOR);
  });

  // Start the game loop
  startGameLoop(playerTeam, gymTeam, gym, (result) => {
    // Award victory if player won
    if (result.winner === 'player') {
      // Wrap state mutations in global lock to prevent concurrent clobbering
      // with CLI victory path (stop.ts also uses withLockRetry)
      const lockResult = withLockRetry(() => {
        // Re-read state and config inside lock to avoid stale data (use readState/readConfig for normalization)
        const freshState = readState(generation);
        const freshConfig = readConfig(generation);
        const participatingPokemon = freshConfig.party.filter((name) => freshState.pokemon[name]);
        const victoryResult = awardGymVictory(freshState, gym, participatingPokemon);

        // Check achievements immediately after badge (pass commonState for encounter_rate_bonus)
        const commonState = readCommonState();
        const achEvents = victoryResult.badgeEarned ? checkAchievements(freshState, freshConfig, commonState, generation) : [];

        // Update common badge aggregates and check common achievements
        let commonAchEvents: ReturnType<typeof checkCommonAchievements> = [];
        if (victoryResult.badgeEarned) {
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

          commonAchEvents = checkCommonAchievements(commonState, freshConfig, freshState);
        }

        // Save updated state and config (use writeState for consistency with readState)
        writeState(freshState, generation);
        writeCommonState(commonState);
        writeConfig(freshConfig, generation);

        return {
          victoryResult,
          achEvents: [...achEvents, ...commonAchEvents],
          badgeCount: (freshState.gym_badges ?? []).length,
        };
      });

      if (!lockResult.acquired) {
        process.stderr.write('Failed to acquire state lock for gym victory.\n');
        process.exit(1);
      }

      const { victoryResult, achEvents, badgeCount } = lockResult.value;

      // Badge notification to stderr (stdout is for JSON) — outside lock
      if (victoryResult.badgeEarned) {
        const isChampion = gym.badge.startsWith('champion_');
        if (isChampion) {
          process.stderr.write('\n═══════════════════════════════\n');
          process.stderr.write(`  🏆 ${t('gym.champion_victory_header')} 🏆\n`);
          const champRegion = getLocale() === 'ko'
            ? gym.badgeKo.replace(/ 챔피언배지$/, '')
            : gym.badge.replace(/^champion_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
          const champLeader = getLocale() === 'ko' ? gym.leaderKo : gym.leader;
          process.stderr.write(`  ${t('gym.champion_victory_detail', { region: champRegion, leader: champLeader })}\n`);
          for (const achEvent of achEvents) {
            process.stderr.write(`  ${formatAchievementMessage(achEvent)}\n`);
          }
          process.stderr.write('═══════════════════════════════\n');
        } else {
          const badgeName = getLocale() === 'ko' ? gym.badgeKo : `${gym.badge.charAt(0).toUpperCase() + gym.badge.slice(1)} Badge`;
          const leaderName = getLocale() === 'ko' ? gym.leaderKo : gym.leader;
          process.stderr.write(`\n${t('gym.badge_earned', { badge: badgeName, leader: leaderName, count: badgeCount })}\n`);
          for (const achEvent of achEvents) {
            process.stderr.write(`${formatAchievementMessage(achEvent)}\n`);
          }
        }
      }

      const output = {
        winner: result.winner,
        turnsPlayed: result.turnsPlayed,
        gym: gym.id,
        badge: gym.badge,
        badgeKo: gym.badgeKo,
        badgeEarned: victoryResult.badgeEarned,
        xpAwarded: victoryResult.xpAwarded,
        achievements: achEvents.map(e => ({ id: e.id, name: e.name })),
      };

      console.log(`\n__BATTLE_RESULT__${JSON.stringify(output)}`);
    } else {
      // Defeat — save state (battle count etc. may matter)
      writeState(state, generation);

      const output = {
        winner: result.winner,
        turnsPlayed: result.turnsPlayed,
        gym: gym.id,
        badge: gym.badge,
        badgeKo: gym.badgeKo,
        badgeEarned: false,
        xpAwarded: 0,
      };

      console.log(`\n__BATTLE_RESULT__${JSON.stringify(output)}`);
    }

    process.exit(0);
  });
}

main();
