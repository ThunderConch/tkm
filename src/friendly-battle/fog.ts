import type { BattlePokemon, BattleState } from '../core/types.js';
import type {
  FogState,
  FriendlyBattleBattleEvent,
  FriendlyBattleRole,
} from './contracts.js';

type FogBenchEntry = FogState['opponentBenchRevealed'][number];

interface FogMetadata {
  opponentSpecies: string[];
  activeSpecies: string;
}

const FOG_METADATA = Symbol('friendly-battle.fog-metadata');
const USED_MOVE_PATTERN = /^(.+?) used ([^!]+)!$/;
const SWITCH_IN_PATTERNS = [
  /^Opponent sent out ([^!]+)!$/,
  /^(.+?) sent out ([^!]+)!$/,
  /^Go! ([^!]+)!$/,
];

function oppTeamForRole(state: BattleState, role: FriendlyBattleRole): BattleState['player'] {
  return role === 'host' ? state.opponent : state.player;
}

function hpPercent(mon: BattlePokemon): number {
  if (mon.maxHp <= 0) return 0;
  return Math.round((mon.currentHp / mon.maxHp) * 100);
}

function speciesName(mon: BattlePokemon): string {
  return mon.displayName ?? mon.name ?? String(mon.id ?? '');
}

function benchEntry(mon: BattlePokemon): FogBenchEntry {
  return {
    species: speciesName(mon),
    level: mon.level,
    hpPercent: hpPercent(mon),
  };
}

function getMetadata(state: BattleState, role: FriendlyBattleRole): FogMetadata {
  const opponent = oppTeamForRole(state, role);
  return {
    opponentSpecies: opponent.pokemon.map((pokemon) => speciesName(pokemon)),
    activeSpecies: speciesName(opponent.pokemon[opponent.activeIndex] ?? opponent.pokemon[0] ?? {
      id: 0,
      name: '',
      displayName: '',
    } as BattlePokemon),
  };
}

function attachMetadata(fog: FogState, metadata: FogMetadata): FogState {
  Object.defineProperty(fog, FOG_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return fog;
}

function metadataFromFog(fog: FogState): FogMetadata | null {
  return (fog as FogState & { [FOG_METADATA]?: FogMetadata })[FOG_METADATA] ?? null;
}

function nextBenchHiddenCount(metadata: FogMetadata, revealed: FogBenchEntry[]): number {
  const totalBench = Math.max(0, metadata.opponentSpecies.length - 1);
  return Math.max(0, totalBench - revealed.length);
}

function parseSwitchSpecies(message: string): string | null {
  for (const pattern of SWITCH_IN_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    return match.at(-1) ?? null;
  }
  return null;
}

export function deriveFogState(state: BattleState, role: FriendlyBattleRole): FogState {
  const opponent = oppTeamForRole(state, role);
  const active = opponent.pokemon[opponent.activeIndex];
  const metadata = getMetadata(state, role);
  const fog: FogState = {
    opponentActive: {
      species: active ? speciesName(active) : '',
      level: active?.level ?? 1,
      hpPercent: active ? hpPercent(active) : 0,
      visibleStatus: active?.statusCondition ?? null,
      revealedMoves: [],
    },
    opponentBenchRevealed: [],
    opponentBenchHidden: Math.max(0, opponent.pokemon.length - 1),
  };
  return attachMetadata(fog, metadata);
}

function accumulateWithState(
  previous: FogState,
  event: FriendlyBattleBattleEvent,
  state: BattleState,
  role: FriendlyBattleRole,
): FogState {
  const metadata = getMetadata(state, role);
  const opponent = oppTeamForRole(state, role);
  const revealedMoves = [...previous.opponentActive.revealedMoves];
  const benchBySpecies = new Map(previous.opponentBenchRevealed.map((entry) => [entry.species, entry] as const));
  let changed = false;

  if (event.type === 'turn_resolved') {
    for (const message of event.messages) {
      const used = USED_MOVE_PATTERN.exec(message);
      if (used && used[1] === previous.opponentActive.species && !revealedMoves.includes(used[2])) {
        revealedMoves.push(used[2]);
        changed = true;
        continue;
      }

      const switchedSpecies = parseSwitchSpecies(message);
      if (!switchedSpecies || switchedSpecies === previous.opponentActive.species || benchBySpecies.has(switchedSpecies)) {
        continue;
      }
      const mon = opponent.pokemon.find((pokemon) => speciesName(pokemon) === switchedSpecies);
      if (!mon) continue;
      benchBySpecies.set(switchedSpecies, benchEntry(mon));
      changed = true;
    }
  }

  const active = opponent.pokemon[opponent.activeIndex];
  const next: FogState = {
    opponentActive: {
      species: active ? speciesName(active) : previous.opponentActive.species,
      level: active?.level ?? previous.opponentActive.level,
      hpPercent: active ? hpPercent(active) : previous.opponentActive.hpPercent,
      visibleStatus: active?.statusCondition ?? previous.opponentActive.visibleStatus,
      revealedMoves: changed || previous.opponentActive.species === (active ? speciesName(active) : previous.opponentActive.species)
        ? revealedMoves
        : previous.opponentActive.revealedMoves,
    },
    opponentBenchRevealed: [...benchBySpecies.values()],
    opponentBenchHidden: nextBenchHiddenCount(metadata, [...benchBySpecies.values()]),
  };

  if (!changed
    && next.opponentActive.species === previous.opponentActive.species
    && next.opponentActive.level === previous.opponentActive.level
    && next.opponentActive.hpPercent === previous.opponentActive.hpPercent
    && next.opponentActive.visibleStatus === previous.opponentActive.visibleStatus
    && next.opponentBenchHidden === previous.opponentBenchHidden
    && next.opponentBenchRevealed.length === previous.opponentBenchRevealed.length
  ) {
    return attachMetadata(previous, metadata);
  }

  return attachMetadata(next, metadata);
}

export function accumulateFogState(
  previous: FogState,
  event: FriendlyBattleBattleEvent,
  state: BattleState,
  role: FriendlyBattleRole,
): FogState;
export function accumulateFogState(
  previous: FogState,
  state: BattleState,
  role: FriendlyBattleRole,
  event: FriendlyBattleBattleEvent,
): FogState;
export function accumulateFogState(
  previous: FogState,
  arg2: FriendlyBattleBattleEvent | BattleState,
  arg3: BattleState | FriendlyBattleRole,
  arg4: FriendlyBattleRole | FriendlyBattleBattleEvent,
): FogState {
  const event = 'type' in arg2 ? arg2 as FriendlyBattleBattleEvent : arg4 as FriendlyBattleBattleEvent;
  const state = 'type' in arg2 ? arg3 as BattleState : arg2 as BattleState;
  const role = 'type' in arg2 ? arg4 as FriendlyBattleRole : arg3 as FriendlyBattleRole;

  if (!event || !state || !role) return previous;
  return accumulateWithState(previous, event, state, role);
}

export function getFogMetadata(fog: FogState): FogMetadata | null {
  return metadataFromFog(fog);
}
