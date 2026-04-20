import { getPokemonDB, parseCrossGenRef, ensurePokemonInDB } from './pokemon-data.js';
import { isShinyKey, toBaseId, toShinyKey } from './shiny-utils.js';
import type { State, Config, EvolutionResult, EvolutionContext, BranchEvolution, PokemonState } from './types.js';

const FRIENDSHIP_THRESHOLD = 220;

export interface BranchInfo {
  name: string;
  conditionMet: boolean;
  conditionLabel: string;
}

/**
 * Mark a pokemon ready for evolution prompt. Returns true if already prompted
 * (caller should return null). Used by both single-chain paths in checkEvolution.
 */
function markEvolutionReady(pState: PokemonState, target: string): boolean {
  if (pState.evolution_prompt_shown) return true;
  if (!pState.evolution_ready) {
    pState.evolution_ready = true;
    pState.evolution_options = [target];
  }
  return false;
}

/**
 * Check if a pokemon should evolve given the current context.
 * Supports: level, friendship, trade (achievement proxy), item, region.
 *
 * When `evolves_to` is an array (branching evolution), returns null
 * and sets evolution_ready on the PokemonState instead.
 * The caller must check state.pokemon[name].evolution_ready separately.
 */
export function checkEvolution(
  pokemonName: string,
  context: EvolutionContext,
  state?: State,
): EvolutionResult | null {
  const db = getPokemonDB();
  const baseId = toBaseId(pokemonName);
  const data = db.pokemon[baseId] ?? ensurePokemonInDB(baseId) ?? undefined;
  if (!data) return null;

  // Branching evolution: block auto-evolve, set flags on state.
  // Note: checkEvolution is only called for party pokemon (stop.ts),
  // so zombie state entries (old forms kept for pokedex) are never re-processed.
  if (Array.isArray(data.evolves_to)) {
    if (state) {
      const eligible = getEligibleBranches(pokemonName, context);
      // Filter out branches whose evolved form is already in unlocked
      const filtered = eligible.filter(b => {
        const evolvedKey = isShinyKey(pokemonName) ? toShinyKey(b.name) : b.name;
        return !state.unlocked.includes(evolvedKey);
      });
      const conditionMet = filtered.filter(b => b.conditionMet);
      const pState = state.pokemon[pokemonName];
      if (pState && !pState.evolution_prompt_shown) {
        if (conditionMet.length > 0 && !pState.evolution_ready) {
          pState.evolution_ready = true;
          pState.evolution_options = conditionMet.map(b => b.name);
        } else if (conditionMet.length === 0 && pState.evolution_ready) {
          // Clear stale flag when all branches are now blocked
          pState.evolution_ready = undefined;
          pState.evolution_options = undefined;
        }
      }
    }
    return null;
  }

  // Single-path evolution via evolves_to string
  if (typeof data.evolves_to === 'string') {
    let targetName = data.evolves_to;
    let targetData = db.pokemon[targetName] as typeof db.pokemon[string] | undefined;

    // Handle cross-gen reference (e.g., "gen1:25")
    const crossRef = parseCrossGenRef(targetName);
    if (crossRef) {
      targetName = crossRef.id;
      targetData = ensurePokemonInDB(targetName) ?? undefined;
    } else if (!targetData) {
      // Plain ID that's not in the active gen's db — try cross-gen injection.
      targetData = ensurePokemonInDB(targetName) ?? undefined;
    }

    if (!targetData) return null;

    // Block re-evolution if direct evolved form already in unlocked
    if (state) {
      const evolvedKey = isShinyKey(pokemonName) ? toShinyKey(targetName) : targetName;
      if (state.unlocked.includes(evolvedKey)) return null;
    }

    const condition = data.evolves_condition;
    if (condition) {
      if (!checkCondition(condition, context)) return null;
    } else if (data.evolves_at != null) {
      if (!(context.newLevel >= data.evolves_at && context.oldLevel < data.evolves_at)) return null;
    } else {
      return null;
    }

    // Flag-based flow when state is provided (mirrors branch evolution pattern)
    if (state) {
      const pState = state.pokemon[pokemonName];
      if (pState) markEvolutionReady(pState, targetName);
      return null;
    }

    return { oldPokemon: pokemonName, newPokemon: targetName, newId: targetData.id, level: context.newLevel };
  }

  // Legacy path: line[stage+1] lookup
  const nextStage = data.stage + 1;
  if (nextStage >= data.line.length) return null;
  const nextPokemon = data.line[nextStage];
  const nextData = db.pokemon[nextPokemon] ?? ensurePokemonInDB(nextPokemon) ?? undefined;
  if (!nextData) return null;

  // Block re-evolution if direct evolved form already in unlocked
  if (state) {
    const evolvedKey = isShinyKey(pokemonName) ? toShinyKey(nextPokemon) : nextPokemon;
    if (state.unlocked.includes(evolvedKey)) return null;
  }

  const condition = data.evolves_condition;

  // Special condition evolutions
  if (condition) {
    const triggered = checkCondition(condition, context);
    if (!triggered) return null;

    // Flag-based flow when state is provided
    if (state) {
      const pState = state.pokemon[pokemonName];
      if (pState) markEvolutionReady(pState, nextPokemon);
      return null;
    }

    return {
      oldPokemon: pokemonName,
      newPokemon: nextPokemon,
      newId: nextData.id,
      level: context.newLevel,
    };
  }

  // Level-based evolution (default)
  if (data.evolves_at == null) return null;
  if (context.newLevel >= data.evolves_at && context.oldLevel < data.evolves_at) {
    // Flag-based flow when state is provided
    if (state) {
      const pState = state.pokemon[pokemonName];
      if (pState) markEvolutionReady(pState, nextPokemon);
      return null;
    }

    return {
      oldPokemon: pokemonName,
      newPokemon: nextPokemon,
      newId: nextData.id,
      level: context.newLevel,
    };
  }

  return null;
}

/**
 * Get eligible evolution branches for a branching pokemon.
 */
export function getEligibleBranches(
  pokemonName: string,
  context: EvolutionContext,
): BranchInfo[] {
  const db = getPokemonDB();
  const baseId = toBaseId(pokemonName);
  // Cross-gen fallback: load the source pokemon into the active generation's
  // DB when it originates from another gen (e.g. Eevee in a gen4 save).
  const data = db.pokemon[baseId] ?? ensurePokemonInDB(baseId) ?? undefined;
  if (!data || !Array.isArray(data.evolves_to)) return [];

  return (data.evolves_to as BranchEvolution[]).map(branch => ({
    name: branch.name,
    conditionMet: checkBranchCondition(branch.condition, context),
    conditionLabel: branch.condition,
  }));
}

/**
 * Apply a user-selected branch evolution.
 */
export function applyBranchEvolution(
  state: State,
  config: Config,
  pokemonName: string,
  targetName: string,
): EvolutionResult | null {
  const db = getPokemonDB();
  const baseId = toBaseId(pokemonName);
  const data = db.pokemon[baseId] ?? ensurePokemonInDB(baseId) ?? undefined;
  if (!data || !Array.isArray(data.evolves_to)) return null;

  const branch = (data.evolves_to as BranchEvolution[]).find(b => b.name === targetName);
  if (!branch) return null;

  // Cross-gen fallback for the target data too (Vaporeon etc. may live in gen1).
  const targetData = db.pokemon[targetName] ?? ensurePokemonInDB(targetName) ?? undefined;
  if (!targetData) return null;

  // Block re-evolution if direct evolved form already in unlocked (defense-in-depth)
  const evolvedKey = isShinyKey(pokemonName) ? toShinyKey(targetName) : targetName;
  if (state.unlocked.includes(evolvedKey)) return null;

  const pState = state.pokemon[pokemonName];
  if (!pState) return null;

  const result: EvolutionResult = {
    oldPokemon: pokemonName,
    newPokemon: targetName,
    newId: targetData.id,
    level: pState.level,
  };

  applyEvolution(state, config, result, pState.xp);

  // Clear branching flags
  pState.evolution_ready = undefined;
  pState.evolution_options = undefined;
  pState.evolution_prompt_shown = undefined;

  return result;
}

/**
 * Apply a user-selected single-chain evolution (string `evolves_to` or legacy line[stage+1]).
 * Mirrors applyBranchEvolution for non-branching pokemon.
 */
export function applySingleChainEvolution(
  state: State,
  config: Config,
  pokemonName: string,
  targetName: string,
): EvolutionResult | null {
  const db = getPokemonDB();
  const baseId = toBaseId(pokemonName);
  const data = db.pokemon[baseId] ?? ensurePokemonInDB(baseId) ?? undefined;
  if (!data) return null;

  // Must be single-chain (not branching)
  if (Array.isArray(data.evolves_to)) return null;

  // Validate target: either string evolves_to (optionally cross-gen) or legacy line[stage+1]
  let resolvedTarget: string | null = null;
  let targetData: typeof db.pokemon[string] | undefined;

  if (typeof data.evolves_to === 'string') {
    resolvedTarget = data.evolves_to;
    targetData = db.pokemon[resolvedTarget];
    const crossRef = parseCrossGenRef(resolvedTarget);
    if (crossRef) {
      resolvedTarget = crossRef.id;
      targetData = ensurePokemonInDB(resolvedTarget) ?? undefined;
    } else if (!targetData) {
      // Plain numeric ID target that only lives in another generation's dex
      // (e.g. Charmeleon #5 on a gen4-active save). Pull it in so single-chain
      // evolutions complete instead of erroring out after the prompt.
      targetData = ensurePokemonInDB(resolvedTarget) ?? undefined;
    }
  } else {
    // Legacy path: line[stage+1]
    const nextStage = data.stage + 1;
    if (nextStage < data.line.length) {
      resolvedTarget = data.line[nextStage];
      targetData = db.pokemon[resolvedTarget] ?? ensurePokemonInDB(resolvedTarget) ?? undefined;
    }
  }

  if (!resolvedTarget || !targetData) return null;
  if (resolvedTarget !== targetName) return null;

  // Block re-evolution if already unlocked (defense-in-depth)
  const evolvedKey = isShinyKey(pokemonName) ? toShinyKey(targetName) : targetName;
  if (state.unlocked.includes(evolvedKey)) return null;

  const pState = state.pokemon[pokemonName];
  if (!pState) return null;

  const result: EvolutionResult = {
    oldPokemon: pokemonName,
    newPokemon: targetName,
    newId: targetData.id,
    level: pState.level,
  };

  applyEvolution(state, config, result, pState.xp);

  // Clear flags
  pState.evolution_ready = undefined;
  pState.evolution_options = undefined;
  pState.evolution_prompt_shown = undefined;

  return result;
}

function checkBranchCondition(condition: string, context: EvolutionContext): boolean {
  if (condition.startsWith('level:')) {
    const lvl = parseInt(condition.slice(6));
    return context.newLevel >= lvl;
  }
  // Reuse existing condition checks
  return checkCondition(condition, context);
}

function checkCondition(condition: string, context: EvolutionContext): boolean {
  // String-based conditions from PokeAPI crawler
  if (condition === 'friendship') {
    return context.friendship >= FRIENDSHIP_THRESHOLD;
  }
  if (condition === 'trade') {
    // Trade evolution via achievement proxy
    return context.unlockedAchievements.includes('ten_sessions');
  }
  if (condition.startsWith('item:')) {
    const itemName = condition.slice(5);
    return (context.items[itemName] ?? 0) > 0;
  }
  if (condition.startsWith('trade_item:')) {
    // Trade with held item - treat as achievement proxy
    return context.unlockedAchievements.includes('ten_sessions');
  }
  if (condition.startsWith('held_item:')) {
    const itemName = condition.slice(10);
    return (context.items[itemName] ?? 0) > 0;
  }
  if (condition.startsWith('location:')) {
    const location = condition.slice(9);
    return context.currentRegion === location;
  }
  if (condition.startsWith('move:') || condition.startsWith('move_type:')) {
    // Move-based evolution: trigger on level up (simplified)
    return context.newLevel > context.oldLevel;
  }
  if (condition === 'special') {
    // Generic special: trigger on level up as fallback
    return context.newLevel > context.oldLevel;
  }
  return false;
}

// Friendship constants
export const FRIENDSHIP_PER_SESSION = 2;
export const FRIENDSHIP_PER_LEVELUP = 5;
export const FRIENDSHIP_PER_BATTLE_WIN = 1;

/**
 * Add friendship to a pokemon in state.
 */
export function addFriendship(state: State, pokemonName: string, amount: number): void {
  if (!state.pokemon[pokemonName]) return;
  state.pokemon[pokemonName].friendship = (state.pokemon[pokemonName].friendship ?? 0) + amount;
}

/**
 * Apply evolution result to state and config.
 */
export function applyEvolution(
  state: State,
  config: Config,
  evolution: EvolutionResult,
  currentXp: number,
): void {
  const old = state.pokemon[evolution.oldPokemon];

  // Add evolved pokemon to state, carrying over all existing fields (nickname, ev, friendship, etc.)
  // then overriding only what changes on evolution.
  // Note: old form is intentionally kept in state.pokemon for collection/pokedex tracking.
  // Shiny pokemon evolves to shiny evolved form
  const newKey = isShinyKey(evolution.oldPokemon) ? toShinyKey(evolution.newPokemon) : evolution.newPokemon;
  state.pokemon[newKey] = {
    ...old,
    id: evolution.newId,
    xp: currentXp,
    level: evolution.level,
    met: 'evolution',
    met_detail: { met_level: evolution.level, met_date: new Date().toISOString().split('T')[0], from: evolution.oldPokemon },
  };

  // Add to unlocked if not already there
  if (!state.unlocked.includes(newKey)) {
    state.unlocked.push(newKey);
  }

  // Remove pre-evolution from unlocked (it stays in state.pokemon for pokedex tracking)
  const oldKey = evolution.oldPokemon;
  const oldIdx = state.unlocked.indexOf(oldKey);
  if (oldIdx !== -1) {
    state.unlocked.splice(oldIdx, 1);
  }

  // Increment evolution count
  state.evolution_count += 1;

  // Replace in party config
  config.party = config.party.map(p => p === evolution.oldPokemon ? newKey : p);
}
