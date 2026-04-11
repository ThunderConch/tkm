import {
  createBattlePokemon,
  createBattleState,
  getActivePokemon,
  hasAlivePokemon,
  resolveTurn,
} from '../../core/turn-battle.js';
import type { BattleState, BattleTeam, TurnAction } from '../../core/types.js';
import type { ActivePartySnapshot } from '../parties/index.js';
import type { RoomSeat } from '../rooms/index.js';
import type {
  BattleCommand,
  BattleDataResolver,
  BattlePokemonRuntimeMetadata,
  BattleSeatRuntimeState,
  BattleSessionRecord,
} from './battle-types.js';

export function buildSeatRuntimeState(party: ActivePartySnapshot): BattleSeatRuntimeState {
  return {
    userId: party.playerId,
    partySnapshotId: party.snapshotId,
    partySnapshotVersion: party.snapshotVersion,
    members: party.members.map((member) => ({
      slot: member.slot,
      pokemonInstanceId: member.pokemonInstanceId,
      speciesId: member.speciesId,
      nickname: member.nickname,
      levelActual: member.levelActual,
      levelEffective: member.levelEffective,
      moveIds: [...member.moves],
    })),
  };
}

export function createAuthoritativeBattleState(args: {
  generation: ActivePartySnapshot['generation'];
  hostParty: ActivePartySnapshot;
  guestParty: ActivePartySnapshot;
  dataResolver: BattleDataResolver;
}): BattleState {
  const { generation, hostParty, guestParty, dataResolver } = args;

  const hostTeam = hostParty.members.map((member) => createRuntimeBattlePokemon(generation, member, dataResolver));
  const guestTeam = guestParty.members.map((member) => createRuntimeBattlePokemon(generation, member, dataResolver));

  return createBattleState(hostTeam, guestTeam);
}

function createRuntimeBattlePokemon(
  generation: ActivePartySnapshot['generation'],
  member: ActivePartySnapshot['members'][number],
  dataResolver: BattleDataResolver,
) {
  const species = dataResolver.resolveSpecies(generation, member.speciesId);
  if (!species) {
    throw new Error(`Unknown species for battle session: ${member.speciesId}`);
  }

  const moves = member.moves.map((moveId) => {
    const move = dataResolver.resolveMove(generation, moveId);
    if (!move) {
      throw new Error(`Unknown move for battle session: ${moveId}`);
    }
    return move;
  });

  return createBattlePokemon(
    {
      id: species.id,
      types: species.types,
      level: member.levelEffective,
      baseStats: species.base_stats,
      displayName: member.nickname ?? species.name,
    },
    moves,
  );
}

export function seatToEngineSide(seat: RoomSeat): 'player' | 'opponent' {
  return seat === 'host' ? 'player' : 'opponent';
}

export function getSeatTeam(session: BattleSessionRecord, seat: RoomSeat): BattleTeam {
  return session.battleState[seatToEngineSide(seat)];
}

export function getSeatRuntimeMember(
  session: BattleSessionRecord,
  seat: RoomSeat,
  slot: number,
): BattlePokemonRuntimeMetadata | undefined {
  return session.seatState[seat].members.find((member) => member.slot === slot);
}

export function getSeatRuntimeMemberByIndex(
  session: BattleSessionRecord,
  seat: RoomSeat,
  index: number,
): BattlePokemonRuntimeMetadata | undefined {
  return session.seatState[seat].members[index];
}

export function getActiveRuntimeMember(
  session: BattleSessionRecord,
  seat: RoomSeat,
): BattlePokemonRuntimeMetadata | undefined {
  const team = getSeatTeam(session, seat);
  return getSeatRuntimeMemberByIndex(session, seat, team.activeIndex);
}

export function getActiveSlot(session: BattleSessionRecord, seat: RoomSeat): number | null {
  return getActiveRuntimeMember(session, seat)?.slot ?? null;
}

export function hasAliveSeatPokemon(session: BattleSessionRecord, seat: RoomSeat): boolean {
  return hasAlivePokemon(getSeatTeam(session, seat));
}

export function getRemainingCount(session: BattleSessionRecord, seat: RoomSeat): number {
  return getSeatTeam(session, seat).pokemon.filter((pokemon) => !pokemon.fainted).length;
}

export function findPokemonIndexBySlot(session: BattleSessionRecord, seat: RoomSeat, slot: number): number {
  return session.seatState[seat].members.findIndex((member) => member.slot === slot);
}

export function toEngineAction(
  session: BattleSessionRecord,
  seat: RoomSeat,
  command: BattleCommand,
): TurnAction {
  switch (command.type) {
    case 'choose_move':
      return { type: 'move', moveIndex: command.moveSlot - 1 };
    case 'choose_switch': {
      const pokemonIndex = findPokemonIndexBySlot(session, seat, command.targetSlot);
      return { type: 'switch', pokemonIndex };
    }
    case 'forfeit':
      return { type: 'surrender' };
    case 'choose_replacement':
      throw new Error('Replacement commands are resolved outside the battle engine.');
  }
}

export function resolveAuthoritativeTurn(
  state: BattleState,
  hostAction: TurnAction,
  guestAction: TurnAction,
) {
  return resolveTurn(state, hostAction, guestAction);
}

export function collectAliveBenchSlots(session: BattleSessionRecord, seat: RoomSeat): number[] {
  const team = getSeatTeam(session, seat);
  return team.pokemon
    .map((pokemon, index) => ({ pokemon, index }))
    .filter(({ pokemon, index }) => index !== team.activeIndex && !pokemon.fainted)
    .map(({ index }) => session.seatState[seat].members[index]?.slot)
    .filter((slot): slot is number => typeof slot === 'number');
}

export function applyReplacementBySlot(session: BattleSessionRecord, seat: RoomSeat, slot: number): void {
  const team = getSeatTeam(session, seat);
  const pokemonIndex = findPokemonIndexBySlot(session, seat, slot);
  if (pokemonIndex < 0) {
    throw new Error(`Unknown replacement slot ${slot} for ${seat}`);
  }
  team.activeIndex = pokemonIndex;
}

export function getActiveBattlePokemon(session: BattleSessionRecord, seat: RoomSeat) {
  return getActivePokemon(getSeatTeam(session, seat));
}
