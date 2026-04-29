#!/usr/bin/env -S npx tsx
/**
 * moves.ts — View and manage Tokenmon moves for party pokemon.
 *
 * Usage:
 *   moves.ts                       — show moves for all party pokemon
 *   moves.ts <name>                — show moves for specific pokemon
 *   moves.ts <name> list           — show all learnable moves
 *   moves.ts <name> swap <slot> <moveId> — swap a move slot
 */
import { readState, writeState } from '../core/state.js';
import { withLockRetry } from '../core/lock.js';
import { readConfig, readGlobalConfig } from '../core/config.js';
import { getMoveData, getPokemonMovePool, assignDefaultMoves } from '../core/moves.js';
import { getPokemonName, getPokemonDB, resolveNameToId, getDisplayName } from '../core/pokemon-data.js';
import { getActiveGeneration } from '../core/paths.js';
import { t, initLocale, getLocale } from '../i18n/index.js';

initLocale(readGlobalConfig().language);

// ANSI helpers
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';

function typeColor(type: string): string {
  const colors: Record<string, string> = {
    normal: '\x1b[0m',
    fire: '\x1b[31m',
    water: '\x1b[34m',
    grass: '\x1b[32m',
    electric: '\x1b[33m',
    ice: '\x1b[96m',
    fighting: '\x1b[31m',
    poison: '\x1b[35m',
    ground: '\x1b[33m',
    flying: '\x1b[96m',
    psychic: '\x1b[95m',
    bug: '\x1b[32m',
    rock: '\x1b[33m',
    ghost: '\x1b[35m',
    dragon: '\x1b[34m',
    dark: '\x1b[90m',
    steel: '\x1b[37m',
    fairy: '\x1b[95m',
  };
  return colors[type] ?? RESET;
}

function categoryLabel(cat: string): string {
  return cat === 'physical' ? t('cli.moves.physical') : t('cli.moves.special');
}

const gen = getActiveGeneration();
const state = readState(gen);
const config = readConfig(gen);
const db = getPokemonDB(gen);
const args = process.argv.slice(2);

/** Display moves for a single pokemon */
function showPokemonMoves(pokemonId: string): void {
  const pState = state.pokemon[pokemonId];
  if (!pState) {
    console.error(`  ${RED}${t('cli.moves.not_owned', { name: getPokemonName(pokemonId, gen) })}${RESET}`);
    return;
  }

  const displayName = getDisplayName(pokemonId, pState.nickname);
  const moves = pState.moves ?? assignDefaultMoves(pState.id, pState.level);

  console.log();
  console.log(`  ${BOLD}${displayName}${RESET} ${GRAY}Lv.${pState.level}${RESET}`);

  if (moves.length === 0) {
    console.log(`    ${GRAY}${t('cli.moves.no_moves')}${RESET}`);
    return;
  }

  for (let i = 0; i < moves.length; i++) {
    const moveData = getMoveData(moves[i]);
    if (!moveData) {
      console.log(`    ${i + 1}. ${GRAY}??? (ID:${moves[i]})${RESET}`);
      continue;
    }
    const tc = typeColor(moveData.type);
    const nameDisplay = getLocale() === 'ko' ? (moveData.nameKo || moveData.name) : (moveData.nameEn || moveData.nameKo || moveData.name);
    const cat = categoryLabel(moveData.category);
    console.log(
      `    ${i + 1}. ${BOLD}${nameDisplay}${RESET} ${GRAY}(${tc}${moveData.type}${GRAY}/${cat})${RESET} 위력:${moveData.power} PP:${moveData.pp}`,
    );
  }
}

/** Show all learnable moves for a pokemon */
function showLearnableMoves(pokemonId: string): void {
  const pState = state.pokemon[pokemonId];
  if (!pState) {
    console.error(`  ${RED}${t('cli.moves.not_owned', { name: getPokemonName(pokemonId, gen) })}${RESET}`);
    return;
  }

  const displayName = getDisplayName(pokemonId, pState.nickname);
  const pool = getPokemonMovePool(pState.id);
  const currentMoves = new Set(pState.moves ?? []);

  console.log();
  const learnableLabel = getLocale() === 'ko' ? '습득 가능 기술' : 'Learnable moves';
  console.log(`  ${BOLD}${displayName}${RESET} ${GRAY}Lv.${pState.level}${RESET} — ${learnableLabel}`);
  console.log();

  if (pool.length === 0) {
    console.log(`    ${GRAY}${t('cli.moves.no_learnable')}${RESET}`);
    return;
  }

  for (const entry of pool) {
    const moveData = getMoveData(entry.moveId);
    if (!moveData) continue;

    const learned = currentMoves.has(entry.moveId);
    const canLearn = entry.learnLevel <= pState.level;
    const tc = typeColor(moveData.type);
    const nameDisplay = getLocale() === 'ko' ? (moveData.nameKo || moveData.name) : (moveData.nameEn || moveData.nameKo || moveData.name);
    const cat = categoryLabel(moveData.category);
    const icon = learned ? `${GREEN}●` : canLearn ? `${CYAN}○` : `${GRAY}·`;
    const levelTag = canLearn ? '' : ` ${GRAY}(Lv.${entry.learnLevel})${RESET}`;

    console.log(
      `    ${icon}${RESET} ${BOLD}${nameDisplay}${RESET} ${GRAY}(${tc}${moveData.type}${GRAY}/${cat})${RESET} 위력:${moveData.power} PP:${moveData.pp}${levelTag} ${GRAY}ID:${entry.moveId}${RESET}`,
    );
  }

  console.log();
  if (getLocale() === 'ko') {
    console.log(`    ${GREEN}●${RESET} 장착중  ${CYAN}○${RESET} 습득 가능  ${GRAY}·${RESET} 레벨 부족`);
  } else {
    console.log(`    ${GREEN}●${RESET} Equipped  ${CYAN}○${RESET} Learnable  ${GRAY}·${RESET} Level insufficient`);
  }
  console.log();
}

/** Swap a move slot */
function swapMove(pokemonId: string, slot: number, moveId: number): void {
  const pState = state.pokemon[pokemonId];
  if (!pState) {
    console.error(`  ${RED}${getPokemonName(pokemonId, gen)}은(는) 보유하지 않은 포켓몬입니다.${RESET}`);
    process.exit(1);
  }

  // Validate move is learnable
  const pool = getPokemonMovePool(pState.id);
  const poolEntry = pool.find(e => e.moveId === moveId);
  if (!poolEntry) {
    console.error(`  ${RED}${t('cli.moves.not_learnable', { id: moveId })}${RESET}`);
    process.exit(1);
  }

  if (poolEntry.learnLevel > pState.level) {
    console.error(`  ${RED}${t('cli.moves.level_required', { required: poolEntry.learnLevel, current: pState.level })}${RESET}`);
    process.exit(1);
  }

  // Validate slot
  const moves = pState.moves ?? assignDefaultMoves(pState.id, pState.level);
  if (slot < 1 || slot > 4) {
    console.error(`  ${RED}${t('cli.moves.invalid_slot')}${RESET}`);
    process.exit(1);
  }

  // Ensure moves array has at least `slot` entries
  while (moves.length < slot) {
    moves.push(0);
  }

  const oldMoveId = moves[slot - 1];
  const oldMove = getMoveData(oldMoveId);
  const newMove = getMoveData(moveId);
  const displayName = getDisplayName(pokemonId, pState.nickname);

  // Lock-protected state mutation to avoid lost updates from concurrent hooks
  const lockResult = withLockRetry(() => {
    const freshState = readState(gen);
    const freshPState = freshState.pokemon[pokemonId];
    if (!freshPState) return;
    const freshMoves = freshPState.moves ?? assignDefaultMoves(freshPState.id, freshPState.level);
    while (freshMoves.length < slot) {
      freshMoves.push(0);
    }
    freshMoves[slot - 1] = moveId;
    freshPState.moves = freshMoves;
    writeState(freshState, gen);
  });

  if (!lockResult.acquired) {
    console.error(`  ${RED}${t('cli.moves.lock_failed')}${RESET}`);
    process.exit(1);
  }

  const oldName = oldMove ? (getLocale() === 'ko' ? (oldMove.nameKo || oldMove.name) : (oldMove.nameEn || oldMove.nameKo || oldMove.name)) : (getLocale() === 'ko' ? '(없음)' : '(none)');
  const newName = newMove ? (getLocale() === 'ko' ? (newMove.nameKo || newMove.name) : (newMove.nameEn || newMove.nameKo || newMove.name)) : `ID:${moveId}`;

  console.log();
  console.log(`  ${GREEN}${t('cli.moves.swap_success', { name: displayName, slot })}${RESET}`);
  console.log(`    ${GRAY}${oldName}${RESET} → ${BOLD}${newName}${RESET}`);
  console.log();
}

// ── Main ──

if (args.length === 0) {
  // Show moves for all party pokemon
  if (config.party.length === 0) {
    console.log(`  ${GRAY}${t('cli.moves.no_pokemon')}${RESET}`);
    process.exit(0);
  }
  for (const pokemonId of config.party) {
    showPokemonMoves(pokemonId);
  }
  console.log();
} else {
  // Resolve pokemon name/id
  const nameArg = args[0];
  const pokemonId = resolveNameToId(nameArg, state) ?? nameArg;
  const subCommand = args[1]?.toLowerCase();

  if (subCommand === 'list') {
    showLearnableMoves(pokemonId);
  } else if (subCommand === 'swap') {
    const slot = parseInt(args[2], 10);
    const moveId = parseInt(args[3], 10);
    if (isNaN(slot) || isNaN(moveId)) {
      console.error(`  ${RED}${t('cli.moves.swap_usage')}${RESET}`);
      process.exit(1);
    }
    swapMove(pokemonId, slot, moveId);
  } else {
    // Just show moves for this specific pokemon
    showPokemonMoves(pokemonId);
    console.log();
  }
}
