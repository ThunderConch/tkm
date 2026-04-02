import { getPokemonDB } from './pokemon-data.js';
import type { State, Config, EvolutionResult, EvolutionContext, BranchEvolution } from './types.js';

const FRIENDSHIP_THRESHOLD = 220;

export interface BranchInfo {
  name: string;
  conditionMet: boolean;
  conditionLabel: string;
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
  const data = db.pokemon[pokemonName];
  if (!data) return null;

  // Branching evolution: block auto-evolve, set flags on state.
  // Note: checkEvolution is only called for party pokemon (stop.ts),
  // so zombie state entries (old forms kept for pokedex) are never re-processed.
  if (Array.isArray(data.evolves_to)) {
    if (state) {
      const eligible = getEligibleBranches(pokemonName, context);
      if (eligible.some(b => b.conditionMet)) {
        const pState = state.pokemon[pokemonName];
        if (pState && !pState.evolution_ready) {
          pState.evolution_ready = true;
          pState.evolution_options = eligible
            .filter(b => b.conditionMet)
            .map(b => b.name);
        }
      }
    }
    return null;
  }

  // Single-path evolution via evolves_to string
  if (typeof data.evolves_to === 'string') {
    const targetName = data.evolves_to;
    const targetData = db.pokemon[targetName];
    if (!targetData) return null;
    const condition = data.evolves_condition;
    if (condition) {
      if (!checkCondition(condition, context)) return null;
    } else if (data.evolves_at != null) {
      if (!(context.newLevel >= data.evolves_at && context.oldLevel < data.evolves_at)) return null;
    } else {
      return null;
    }
    return { oldPokemon: pokemonName, newPokemon: targetName, newId: targetData.id, level: context.newLevel };
  }

  // Legacy path: line[stage+1] lookup
  const nextStage = data.stage + 1;
  if (nextStage >= data.line.length) return null;
  const nextPokemon = data.line[nextStage];
  const nextData = db.pokemon[nextPokemon];
  if (!nextData) return null;

  const condition = data.evolves_condition;

  // Special condition evolutions
  if (condition) {
    const triggered = checkCondition(condition, context);
    if (!triggered) return null;

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
  const data = db.pokemon[pokemonName];
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
  const data = db.pokemon[pokemonName];
  if (!data || !Array.isArray(data.evolves_to)) return null;

  const branch = (data.evolves_to as BranchEvolution[]).find(b => b.name === targetName);
  if (!branch) return null;

  const targetData = db.pokemon[targetName];
  if (!targetData) return null;

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
  const friendship = state.pokemon[evolution.oldPokemon]?.friendship ?? 0;
  const ev = state.pokemon[evolution.oldPokemon]?.ev ?? 0;

  // Add evolved pokemon to state.
  // Note: old form is intentionally kept in state.pokemon for collection/pokedex tracking.
  state.pokemon[evolution.newPokemon] = {
    id: evolution.newId,
    xp: currentXp,
    level: evolution.level,
    friendship,
    ev,
  };

  // Add to unlocked if not already there
  if (!state.unlocked.includes(evolution.newPokemon)) {
    state.unlocked.push(evolution.newPokemon);
  }

  // Increment evolution count
  state.evolution_count += 1;

  // Replace in party config
  config.party = config.party.map(p => p === evolution.oldPokemon ? evolution.newPokemon : p);
}
