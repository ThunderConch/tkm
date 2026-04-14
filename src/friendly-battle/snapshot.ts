import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fallbackMoves,
  getDisplayName,
  getLoadedMovesDB,
  getMovesForPokemon,
  loadMovesData,
} from '../core/battle-setup.js';
import { getPokemonDB, speciesIdToGeneration } from '../core/pokemon-data.js';
import { createBattlePokemon } from '../core/turn-battle.js';
import type { Config, MoveData, State, BattlePokemon } from '../core/types.js';
import {
  FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION,
  type FriendlyBattlePartySnapshot,
  type FriendlyBattleProgressionRef,
  type FriendlyBattleSnapshotPokemon,
  type FriendlyBattleSnapshotRef,
} from './contracts.js';

// Walk up from this module's file until we find a package.json. That is the
// plugin root regardless of whether we are running from `src/` under tsx
// (`src/friendly-battle/snapshot.ts` → plugin root is 2 levels up) or from
// the compiled `dist/` under plain node (`dist/friendly-battle/snapshot.js`
// → plugin root is 3 levels up). The old hardcoded `../..` pointed at `dist/`
// in the compiled case, which meant `data/moves.json` never resolved and the
// moves DB silently stayed null — breaking per-client localization.
const DEFAULT_PLUGIN_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/' && dir !== '' && !existsSync(join(dir, 'package.json'))) {
    dir = dirname(dir);
  }
  // Fall back to the old behaviour if no package.json was found on the way up.
  return existsSync(join(dir, 'package.json'))
    ? dir
    : resolve(fileURLToPath(new URL('../..', import.meta.url)));
})();

export interface FriendlyBattleSnapshotGenerationHook {
  mapPokemon?: (pokemon: FriendlyBattleSnapshotPokemon) => FriendlyBattleSnapshotPokemon;
  validatePokemon?: (pokemon: FriendlyBattleSnapshotPokemon) => string[];
  validateSnapshot?: (snapshot: FriendlyBattlePartySnapshot) => string[];
}

export type FriendlyBattleSnapshotGenerationHooks =
  Partial<Record<string, FriendlyBattleSnapshotGenerationHook>>;

export interface BuildFriendlyBattleProgressionRefInput {
  config: Config;
  state: State;
  generation: string;
}

export interface BuildFriendlyBattlePartySnapshotInput extends BuildFriendlyBattleProgressionRefInput {
  pluginRoot?: string;
  snapshotId?: string;
  createdAt?: string;
  generationHooks?: FriendlyBattleSnapshotGenerationHooks;
}

export interface ValidateFriendlyBattlePartySnapshotOptions {
  generationHooks?: FriendlyBattleSnapshotGenerationHooks;
}

export function buildFriendlyBattleProgressionRef(
  input: BuildFriendlyBattleProgressionRefInput,
): FriendlyBattleProgressionRef {
  const seen = new Set<string>();
  const partyPokemonIds = input.config.party.filter(Boolean);

  if (partyPokemonIds.length === 0) {
    throw new Error('Friendly battle progression must include at least one pokemon');
  }

  for (const key of partyPokemonIds) {
    if (seen.has(key)) {
      throw new Error(`Friendly battle progression has duplicate party slot: ${key}`);
    }
    if (!input.state.pokemon[key]) {
      throw new Error(`Friendly battle progression is missing progression pokemon: ${key}`);
    }
    seen.add(key);
  }

  return {
    layer: 'progression',
    generation: input.generation,
    partySource: 'current_party',
    partyPokemonIds,
  };
}

export function buildFriendlyBattlePartySnapshot(
  input: BuildFriendlyBattlePartySnapshotInput,
): FriendlyBattlePartySnapshot {
  const progression = buildFriendlyBattleProgressionRef(input);
  const pluginRoot = input.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  loadMovesData(pluginRoot);

  const generationHook = input.generationHooks?.[input.generation];
  const createdAt = input.createdAt ?? new Date().toISOString();
  const snapshot: FriendlyBattlePartySnapshot = {
    layer: 'snapshot',
    schemaVersion: FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId ?? randomUUID(),
    generation: input.generation,
    partySource: progression.partySource,
    partySize: progression.partyPokemonIds.length,
    createdAt,
    pokemon: progression.partyPokemonIds.map((progressionKey, slot) => {
      const pokemon = createSnapshotPokemon(
        progressionKey,
        input.state,
        input.generation,
        slot,
      );
      return generationHook?.mapPokemon ? generationHook.mapPokemon(pokemon) : pokemon;
    }),
  };

  assertValidFriendlyBattlePartySnapshot(snapshot, {
    generationHooks: input.generationHooks,
  });

  return snapshot;
}

export function buildFriendlyBattleProgressionRefFromSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleProgressionRef {
  assertValidFriendlyBattlePartySnapshot(snapshot);

  return {
    layer: 'progression',
    generation: snapshot.generation,
    partySource: snapshot.partySource,
    partyPokemonIds: snapshot.pokemon
      .slice()
      .sort((left, right) => left.slot - right.slot)
      .map((pokemon) => pokemon.progressionKey),
  };
}

export function toFriendlyBattleSnapshotRef(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleSnapshotRef {
  return {
    layer: 'snapshot',
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    partySource: snapshot.partySource,
    partySize: snapshot.partySize,
    createdAt: snapshot.createdAt,
  };
}

export function validateFriendlyBattlePartySnapshot(
  snapshot: FriendlyBattlePartySnapshot,
  options: ValidateFriendlyBattlePartySnapshotOptions = {},
): string[] {
  const issues: string[] = [];

  if (snapshot.layer !== 'snapshot') {
    issues.push('Friendly battle snapshot layer must be "snapshot"');
  }
  if (snapshot.schemaVersion !== FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION) {
    issues.push(
      `Friendly battle snapshot schemaVersion must be ${FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  if (!isNonEmptyString(snapshot.snapshotId)) {
    issues.push('Friendly battle snapshot snapshotId must be a non-empty string');
  }
  if (!isNonEmptyString(snapshot.generation)) {
    issues.push('Friendly battle snapshot generation must be a non-empty string');
  }
  if (!isNonEmptyString(snapshot.createdAt)) {
    issues.push('Friendly battle snapshot createdAt must be a non-empty string');
  }
  if (snapshot.partySize !== snapshot.pokemon.length) {
    issues.push('Friendly battle snapshot partySize must match pokemon length');
  }
  if (snapshot.pokemon.length === 0) {
    issues.push('Friendly battle snapshot must include at least one pokemon');
  }

  const seenSlots = new Set<number>();
  const seenProgressionKeys = new Set<string>();
  for (const pokemon of snapshot.pokemon) {
    if (!Number.isInteger(pokemon.slot) || pokemon.slot < 0) {
      issues.push(`Friendly battle snapshot pokemon slot must be a non-negative integer: ${pokemon.slot}`);
    } else if (seenSlots.has(pokemon.slot)) {
      issues.push(`Friendly battle snapshot pokemon slot must be unique: ${pokemon.slot}`);
    } else {
      seenSlots.add(pokemon.slot);
    }

    if (!isNonEmptyString(pokemon.progressionKey)) {
      issues.push('Friendly battle snapshot pokemon progressionKey must be a non-empty string');
    } else if (seenProgressionKeys.has(pokemon.progressionKey)) {
      issues.push(
        `Friendly battle snapshot pokemon progressionKey must be unique: ${pokemon.progressionKey}`,
      );
    } else {
      seenProgressionKeys.add(pokemon.progressionKey);
    }

    if (!Number.isInteger(pokemon.speciesId) || pokemon.speciesId <= 0) {
      issues.push(`Friendly battle snapshot pokemon speciesId must be a positive integer: ${pokemon.speciesId}`);
    }
    if (!Number.isInteger(pokemon.level) || pokemon.level < 1) {
      issues.push(`Friendly battle snapshot pokemon level must be at least 1: ${pokemon.level}`);
    }
    if (!isNonEmptyString(pokemon.speciesDisplayName)) {
      issues.push('Friendly battle snapshot pokemon speciesDisplayName must be a non-empty string');
    }
    if (!isNonEmptyString(pokemon.displayName)) {
      issues.push('Friendly battle snapshot pokemon displayName must be a non-empty string');
    }
    if (!isNonEmptyString(pokemon.nativeGeneration)) {
      issues.push('Friendly battle snapshot pokemon nativeGeneration must be a non-empty string');
    }
    if (pokemon.types.length === 0) {
      issues.push(`Friendly battle snapshot pokemon types must be non-empty: ${pokemon.progressionKey}`);
    }
    if (pokemon.moves.length === 0) {
      issues.push(`Friendly battle snapshot pokemon must include at least one move: ${pokemon.progressionKey}`);
    }
    if (pokemon.moves.length > 4) {
      issues.push(`Friendly battle snapshot pokemon cannot include more than four moves: ${pokemon.progressionKey}`);
    }
    if (pokemon.baseStats.hp <= 0) {
      issues.push(`Friendly battle snapshot pokemon hp must be positive: ${pokemon.progressionKey}`);
    }
    if (pokemon.baseStats.attack <= 0) {
      issues.push(`Friendly battle snapshot pokemon attack must be positive: ${pokemon.progressionKey}`);
    }
    if (pokemon.baseStats.defense <= 0) {
      issues.push(`Friendly battle snapshot pokemon defense must be positive: ${pokemon.progressionKey}`);
    }
    if (pokemon.baseStats.speed <= 0) {
      issues.push(`Friendly battle snapshot pokemon speed must be positive: ${pokemon.progressionKey}`);
    }

    for (const move of pokemon.moves) {
      if (!Number.isInteger(move.id) || move.id <= 0) {
        issues.push(`Friendly battle snapshot move id must be a positive integer: ${pokemon.progressionKey}`);
      }
      if (move.pp <= 0) {
        issues.push(`Friendly battle snapshot move pp must be positive: ${pokemon.progressionKey}`);
      }
    }

    issues.push(...(options.generationHooks?.[snapshot.generation]?.validatePokemon?.(pokemon) ?? []));
  }

  if (seenSlots.size === snapshot.pokemon.length) {
    const expectedSlots = Array.from({ length: snapshot.pokemon.length }, (_, index) => index);
    const actualSlots = [...seenSlots].sort((left, right) => left - right);
    if (expectedSlots.some((slot, index) => actualSlots[index] !== slot)) {
      issues.push('Friendly battle snapshot pokemon slots must stay contiguous from 0');
    }
  }

  issues.push(...(options.generationHooks?.[snapshot.generation]?.validateSnapshot?.(snapshot) ?? []));

  return issues;
}

export function assertValidFriendlyBattlePartySnapshot(
  snapshot: FriendlyBattlePartySnapshot,
  options: ValidateFriendlyBattlePartySnapshotOptions = {},
): void {
  const issues = validateFriendlyBattlePartySnapshot(snapshot, options);
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
}

export function createBattleTeamFromFriendlyBattleSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): BattlePokemon[] {
  assertValidFriendlyBattlePartySnapshot(snapshot);
  return snapshot.pokemon.map((pokemon) =>
    createBattlePokemon(
      {
        id: pokemon.speciesId,
        types: structuredClone(pokemon.types),
        level: pokemon.level,
        baseStats: structuredClone(pokemon.baseStats),
        displayName: pokemon.displayName,
      },
      structuredClone(pokemon.moves),
    ),
  );
}

function createSnapshotPokemon(
  progressionKey: string,
  state: State,
  generation: string,
  slot: number,
): FriendlyBattleSnapshotPokemon {
  const progressionPokemon = state.pokemon[progressionKey];
  if (!progressionPokemon) {
    throw new Error(`Friendly battle snapshot is missing progression pokemon: ${progressionKey}`);
  }

  const nativeGeneration = speciesIdToGeneration(progressionPokemon.id);
  const pokemonData =
    getPokemonDB(generation).pokemon[String(progressionPokemon.id)] ??
    getPokemonDB(nativeGeneration).pokemon[String(progressionPokemon.id)];

  if (!pokemonData) {
    throw new Error(`Friendly battle snapshot could not resolve pokemon data for species ${progressionPokemon.id}`);
  }

  const speciesDisplayName = getDisplayName(progressionPokemon.id, generation);
  const displayName = progressionPokemon.nickname || speciesDisplayName;

  return {
    slot,
    progressionKey,
    speciesId: progressionPokemon.id,
    speciesDisplayName,
    displayName,
    nickname: progressionPokemon.nickname ?? null,
    shiny: progressionPokemon.shiny ?? false,
    level: progressionPokemon.level,
    types: structuredClone(pokemonData.types),
    baseStats: structuredClone(pokemonData.base_stats),
    moves: resolveSnapshotMoves(progressionPokemon.id, progressionPokemon.level, pokemonData.types, progressionPokemon.moves),
    nativeGeneration,
  };
}

function resolveSnapshotMoves(
  speciesId: number,
  level: number,
  types: string[],
  configuredMoveIds?: number[],
): MoveData[] {
  const loadedMoves = getLoadedMovesDB();
  const configuredMoves =
    loadedMoves && configuredMoveIds
      ? dedupeMoves(
          configuredMoveIds
            .map((moveId) => loadedMoves[String(moveId)])
            .filter((move): move is MoveData => Boolean(move)),
        )
      : [];

  if (configuredMoves.length > 0) {
    return configuredMoves.slice(0, 4).map((move) => structuredClone(move));
  }

  const fallback = getMovesForPokemon(speciesId, level, types);
  return (fallback.length > 0 ? fallback : fallbackMoves(types, level))
    .slice(0, 4)
    .map((move) => structuredClone(move));
}

function dedupeMoves(moves: MoveData[]): MoveData[] {
  const seen = new Set<number>();
  const deduped: MoveData[] = [];
  for (const move of moves) {
    if (seen.has(move.id)) continue;
    seen.add(move.id);
    deduped.push(move);
  }
  return deduped;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
