import type { BattleState } from '../../core/types.js';
import type { RoomSeat } from '../rooms/index.js';
import {
  applyReplacementBySlot,
  getRemainingCount,
  getSeatTeam,
  hasAliveSeatPokemon,
  resolveAuthoritativeTurn,
  toEngineAction,
} from './battle-engine-adapter.js';
import {
  createForfeitEvent,
  createLoggedEventsFromTurn,
  createReplacementEvents,
} from './battle-event-log.js';
import type {
  BattleCommand,
  BattleFinishReason,
  BattleLoggedEvent,
  BattleSessionRecord,
  BattleSessionResult,
} from './battle-types.js';

export interface BattleTurnResolution {
  nextPhase: 'awaiting_actions' | 'awaiting_replacement' | 'finished';
  events: BattleLoggedEvent[];
  result: BattleSessionResult | null;
}

export function resolveSubmittedActions(args: {
  session: BattleSessionRecord;
  commands: Record<RoomSeat, BattleCommand>;
  recordedAt: string;
}): BattleTurnResolution {
  const { session, commands, recordedAt } = args;
  const beforeState = cloneBattleState(session.battleState);

  const hostAction = toEngineAction(session, 'host', commands.host);
  const guestAction = toEngineAction(session, 'guest', commands.guest);
  resolveAuthoritativeTurn(session.battleState, hostAction, guestAction);

  const events = createLoggedEventsFromTurn({
    session,
    beforeState,
    commands,
  });

  const result = maybeBuildResultFromBattleState(session, recordedAt);
  if (result) {
    session.phase = 'finished';
    session.result = result;
    return {
      nextPhase: 'finished',
      events,
      result,
    };
  }

  const pendingReplacementSeats = getPendingReplacementSeats(session);
  if (pendingReplacementSeats.length > 0) {
    session.phase = 'awaiting_replacement';
    session.pendingReplacementSeats = pendingReplacementSeats;
    return {
      nextPhase: 'awaiting_replacement',
      events,
      result: null,
    };
  }

  session.phase = 'awaiting_actions';
  session.turn += 1;
  return {
    nextPhase: 'awaiting_actions',
    events,
    result: null,
  };
}

export function resolveSubmittedReplacements(args: {
  session: BattleSessionRecord;
  replacementSlots: Partial<Record<RoomSeat, number>>;
  recordedAt: string;
}): BattleTurnResolution {
  const { session, replacementSlots, recordedAt } = args;
  for (const seat of session.pendingReplacementSeats) {
    const slot = replacementSlots[seat];
    if (typeof slot === 'number') {
      applyReplacementBySlot(session, seat, slot);
    }
  }

  const events = createReplacementEvents(session, replacementSlots);
  const result = maybeBuildResultFromBattleState(session, recordedAt);
  if (result) {
    session.phase = 'finished';
    session.result = result;
    return {
      nextPhase: 'finished',
      events,
      result,
    };
  }

  session.pendingReplacementSeats = [];
  session.phase = 'awaiting_actions';
  session.turn += 1;

  return {
    nextPhase: 'awaiting_actions',
    events,
    result: null,
  };
}

export function resolveForfeit(args: {
  session: BattleSessionRecord;
  forfeitingSeat: RoomSeat;
  recordedAt: string;
}): BattleTurnResolution {
  const { session, forfeitingSeat, recordedAt } = args;
  const winnerSeat: RoomSeat = forfeitingSeat === 'host' ? 'guest' : 'host';
  const result: BattleSessionResult = {
    winnerSeat,
    loserSeat: forfeitingSeat,
    reason: 'forfeit',
    recordedAt,
  };
  session.phase = 'finished';
  session.result = result;
  return {
    nextPhase: 'finished',
    events: createForfeitEvent(forfeitingSeat),
    result,
  };
}

function getPendingReplacementSeats(session: BattleSessionRecord): RoomSeat[] {
  const seats: RoomSeat[] = [];
  if (needsReplacement(session, 'host')) {
    seats.push('host');
  }
  if (needsReplacement(session, 'guest')) {
    seats.push('guest');
  }
  return seats;
}

function needsReplacement(session: BattleSessionRecord, seat: RoomSeat): boolean {
  const team = getSeatTeam(session, seat);
  const active = team.pokemon[team.activeIndex];
  return Boolean(active?.fainted && hasAliveSeatPokemon(session, seat));
}

function maybeBuildResultFromBattleState(
  session: BattleSessionRecord,
  recordedAt: string,
): BattleSessionResult | null {
  const hostAlive = hasAliveSeatPokemon(session, 'host');
  const guestAlive = hasAliveSeatPokemon(session, 'guest');

  if (hostAlive && guestAlive) {
    return null;
  }

  const winnerSeat: RoomSeat = hostAlive ? 'host' : 'guest';
  const loserSeat: RoomSeat = winnerSeat === 'host' ? 'guest' : 'host';
  const reason: BattleFinishReason = winnerSeat === 'host'
    ? 'all_opponent_pokemon_fainted'
    : 'all_opponent_pokemon_fainted';

  return {
    winnerSeat,
    loserSeat,
    reason,
    recordedAt,
  };
}

function cloneBattleState(state: BattleState): BattleState {
  return structuredClone(state);
}

export function createEndedPayloadResult(session: BattleSessionRecord, viewerSeat: RoomSeat) {
  const viewerWon = session.result?.winnerSeat === viewerSeat;
  return {
    result: viewerWon ? 'win' as const : 'loss' as const,
    reason: session.result?.reason ?? 'forfeit',
    finalVisibleState: {
      self: {
        remainingCount: getRemainingCount(session, viewerSeat),
      },
      opponent: {
        remainingCount: getRemainingCount(session, viewerSeat === 'host' ? 'guest' : 'host'),
      },
    },
  };
}
