import type { BattlePokemon, BattleState } from '../../core/types.js';
import type { RoomSeat } from '../rooms/index.js';
import {
  collectAliveBenchSlots,
  getActiveBattlePokemon,
  getActiveSlot,
  getSeatRuntimeMemberByIndex,
  getSeatTeam,
} from './battle-engine-adapter.js';
import type {
  BattleActionRequestPayload,
  BattleCommand,
  BattleForfeitEvent,
  BattleLoggedEvent,
  BattleReplacementRequestPayload,
  BattleSessionRecord,
  ProjectedBattleEvent,
  ViewerRelativeSide,
  ViewerVisibleState,
  VisibleActivePokemon,
  VisibleBenchPokemon,
  VisibleMoveOption,
} from './battle-types.js';

function opponentSeat(seat: RoomSeat): RoomSeat {
  return seat === 'host' ? 'guest' : 'host';
}

function toViewerSide(viewerSeat: RoomSeat, seat: RoomSeat): ViewerRelativeSide {
  return viewerSeat === seat ? 'self' : 'opponent';
}

function toVisibleMove(slot: number, moveId: string, currentPp: number): VisibleMoveOption {
  return {
    slot,
    id: moveId,
    disabled: currentPp <= 0,
    currentPp,
  };
}

function toVisibleBenchPokemon(session: BattleSessionRecord, seat: RoomSeat, index: number): VisibleBenchPokemon {
  const runtime = getSeatRuntimeMemberByIndex(session, seat, index);
  const pokemon = getSeatTeam(session, seat).pokemon[index];
  if (!runtime || !pokemon) {
    throw new Error(`Missing bench member metadata for ${seat} index ${index}`);
  }

  return {
    slot: runtime.slot,
    speciesId: runtime.speciesId,
    nickname: runtime.nickname,
    fainted: pokemon.fainted,
  };
}

function toVisibleActivePokemon(
  session: BattleSessionRecord,
  seat: RoomSeat,
  includeMoves: boolean,
): VisibleActivePokemon {
  const team = getSeatTeam(session, seat);
  const runtime = getSeatRuntimeMemberByIndex(session, seat, team.activeIndex);
  const pokemon = getActiveBattlePokemon(session, seat);
  if (!runtime || !pokemon) {
    throw new Error(`Missing active Pokémon metadata for ${seat}`);
  }

  const visibleActive: VisibleActivePokemon = {
    slot: runtime.slot,
    speciesId: runtime.speciesId,
    nickname: runtime.nickname,
    levelActual: runtime.levelActual,
    levelEffective: runtime.levelEffective,
    hp: pokemon.currentHp,
    hpMax: pokemon.maxHp,
    status: pokemon.statusCondition,
    fainted: pokemon.fainted,
  };

  if (includeMoves) {
    visibleActive.moves = runtime.moveIds.map((moveId, index) =>
      toVisibleMove(index + 1, moveId, pokemon.moves[index]?.currentPp ?? 0),
    );
  }

  return visibleActive;
}

export function createViewerVisibleState(session: BattleSessionRecord, viewerSeat: RoomSeat): ViewerVisibleState {
  const enemySeat = opponentSeat(viewerSeat);
  const selfTeam = getSeatTeam(session, viewerSeat);
  const opponentTeam = getSeatTeam(session, enemySeat);

  return {
    self: {
      active: toVisibleActivePokemon(session, viewerSeat, true),
      bench: selfTeam.pokemon
        .map((_, index) => index)
        .filter((index) => index !== selfTeam.activeIndex)
        .map((index) => toVisibleBenchPokemon(session, viewerSeat, index)),
    },
    opponent: {
      active: toVisibleActivePokemon(session, enemySeat, false),
      benchCount: opponentTeam.pokemon.filter((_, index) => index !== opponentTeam.activeIndex).length,
    },
  };
}

export function createActionRequestPayload(
  session: BattleSessionRecord,
  seat: RoomSeat,
): BattleActionRequestPayload {
  const active = toVisibleActivePokemon(session, seat, true);
  const deadlineMs = session.rulesetSnapshot.battlePolicy.actionTimeoutSeconds * 1000;
  const availableMoves = active.moves ?? [];
  const availableSwitches = collectAliveBenchSlots(session, seat).map((slot) => {
    const index = session.seatState[seat].members.findIndex((member) => member.slot === slot);
    return toVisibleBenchPokemon(session, seat, index);
  });

  return {
    turn: session.turn,
    phase: 'awaiting_actions',
    requestId: `battle:${session.battleId}:turn:${session.turn}:seat:${seat}:action`,
    deadlineMs,
    request: {
      kind: 'choose_move_or_switch',
      activePokemon: active,
      availableMoves,
      availableSwitches,
    },
  };
}

export function createReplacementRequestPayload(
  session: BattleSessionRecord,
  seat: RoomSeat,
): BattleReplacementRequestPayload {
  const deadlineMs = session.rulesetSnapshot.battlePolicy.actionTimeoutSeconds * 1000;
  const faintedSlot = getActiveSlot(session, seat);
  const availableReplacements = collectAliveBenchSlots(session, seat).map((slot) => {
    const index = session.seatState[seat].members.findIndex((member) => member.slot === slot);
    return toVisibleBenchPokemon(session, seat, index);
  });

  return {
    turn: session.turn,
    phase: 'awaiting_replacement',
    requestId: `battle:${session.battleId}:turn:${session.turn}:seat:${seat}:replacement`,
    deadlineMs,
    faintedSlot,
    availableReplacements,
  };
}

function pushMoveEvent(
  events: BattleLoggedEvent[],
  session: BattleSessionRecord,
  seat: RoomSeat,
  command: Extract<BattleCommand, { type: 'choose_move' }>,
  beforeState: BattleState,
): void {
  const team = seat === 'host' ? beforeState.player : beforeState.opponent;
  const runtime = getSeatRuntimeMemberByIndex(session, seat, team.activeIndex);
  if (!runtime) {
    return;
  }

  events.push({
    eventType: 'move_used',
    actorSeat: seat,
    actorSlot: runtime.slot,
    actorSpeciesId: runtime.speciesId,
    moveSlot: command.moveSlot,
    moveId: runtime.moveIds[command.moveSlot - 1] ?? `slot-${command.moveSlot}`,
  });
}

function pushSwitchEvent(
  events: BattleLoggedEvent[],
  session: BattleSessionRecord,
  seat: RoomSeat,
  command: Extract<BattleCommand, { type: 'choose_switch' }>,
  beforeState: BattleState,
): void {
  const team = seat === 'host' ? beforeState.player : beforeState.opponent;
  const fromRuntime = getSeatRuntimeMemberByIndex(session, seat, team.activeIndex);
  const toRuntime = session.seatState[seat].members.find((member) => member.slot === command.targetSlot);
  if (!toRuntime) {
    return;
  }

  events.push({
    eventType: 'switch_used',
    actorSeat: seat,
    fromSlot: fromRuntime?.slot ?? null,
    toSlot: toRuntime.slot,
    speciesId: toRuntime.speciesId,
  });
}

function pushStateDiffEvents(
  events: BattleLoggedEvent[],
  session: BattleSessionRecord,
  seat: RoomSeat,
  beforePokemon: BattlePokemon,
  afterPokemon: BattlePokemon,
  index: number,
): void {
  const runtime = getSeatRuntimeMemberByIndex(session, seat, index);
  if (!runtime) {
    return;
  }

  const damage = Math.max(0, beforePokemon.currentHp - afterPokemon.currentHp);
  if (damage > 0) {
    events.push({
      eventType: 'damage_applied',
      targetSeat: seat,
      targetSlot: runtime.slot,
      targetSpeciesId: runtime.speciesId,
      hp: afterPokemon.currentHp,
      hpMax: afterPokemon.maxHp,
      damage,
      fainted: afterPokemon.fainted,
    });
  }

  if (beforePokemon.statusCondition !== afterPokemon.statusCondition && afterPokemon.statusCondition) {
    events.push({
      eventType: 'status_applied',
      targetSeat: seat,
      targetSlot: runtime.slot,
      targetSpeciesId: runtime.speciesId,
      status: afterPokemon.statusCondition,
    });
  }

  if (!beforePokemon.fainted && afterPokemon.fainted) {
    events.push({
      eventType: 'pokemon_fainted',
      targetSeat: seat,
      targetSlot: runtime.slot,
      targetSpeciesId: runtime.speciesId,
    });
  }
}

export function createLoggedEventsFromTurn(args: {
  session: BattleSessionRecord;
  beforeState: BattleState;
  commands: Record<RoomSeat, BattleCommand>;
}): BattleLoggedEvent[] {
  const { session, beforeState, commands } = args;
  const events: BattleLoggedEvent[] = [];

  for (const seat of ['host', 'guest'] as const) {
    const command = commands[seat];
    if (command?.type === 'choose_switch') {
      pushSwitchEvent(events, session, seat, command, beforeState);
    }
  }

  for (const seat of ['host', 'guest'] as const) {
    const command = commands[seat];
    if (command?.type === 'choose_move') {
      pushMoveEvent(events, session, seat, command, beforeState);
    }
  }

  const sides: Array<[RoomSeat, BattleState['player']]> = [
    ['host', beforeState.player],
    ['guest', beforeState.opponent],
  ];

  for (const [seat, beforeTeam] of sides) {
    const afterTeam = getSeatTeam(session, seat);
    beforeTeam.pokemon.forEach((beforePokemon, index) => {
      const afterPokemon = afterTeam.pokemon[index];
      if (!afterPokemon) {
        return;
      }
      pushStateDiffEvents(events, session, seat, beforePokemon, afterPokemon, index);
    });
  }

  return events;
}

export function createReplacementEvents(
  session: BattleSessionRecord,
  replacementSlots: Partial<Record<RoomSeat, number>>,
): BattleLoggedEvent[] {
  const events: BattleLoggedEvent[] = [];

  for (const seat of ['host', 'guest'] as const) {
    const slot = replacementSlots[seat];
    if (typeof slot !== 'number') {
      continue;
    }

    const runtime = session.seatState[seat].members.find((member) => member.slot === slot);
    if (!runtime) {
      continue;
    }

    events.push({
      eventType: 'replacement_selected',
      actorSeat: seat,
      slot,
      speciesId: runtime.speciesId,
    });
  }

  return events;
}

export function createForfeitEvent(forfeitingSeat: RoomSeat): BattleForfeitEvent[] {
  return [
    {
      eventType: 'forfeit',
      actorSeat: forfeitingSeat,
    },
  ];
}

export function projectEventsForViewer(
  viewerSeat: RoomSeat,
  events: BattleLoggedEvent[],
): ProjectedBattleEvent[] {
  return events.map((event): ProjectedBattleEvent => {
    switch (event.eventType) {
      case 'move_used':
        return {
          eventType: 'move_used',
          actor: toViewerSide(viewerSeat, event.actorSeat),
          actorSlot: event.actorSlot,
          actorSpeciesId: event.actorSpeciesId,
          moveSlot: event.moveSlot,
          moveId: event.moveId,
        };
      case 'switch_used':
        return {
          eventType: 'switch_used',
          actor: toViewerSide(viewerSeat, event.actorSeat),
          fromSlot: event.fromSlot,
          toSlot: event.toSlot,
          speciesId: event.speciesId,
        };
      case 'damage_applied':
        return {
          eventType: 'damage_applied',
          target: toViewerSide(viewerSeat, event.targetSeat),
          targetSlot: event.targetSlot,
          targetSpeciesId: event.targetSpeciesId,
          hp: event.hp,
          hpMax: event.hpMax,
          damage: event.damage,
          fainted: event.fainted,
        };
      case 'status_applied':
        return {
          eventType: 'status_applied',
          target: toViewerSide(viewerSeat, event.targetSeat),
          targetSlot: event.targetSlot,
          targetSpeciesId: event.targetSpeciesId,
          status: event.status,
        };
      case 'pokemon_fainted':
        return {
          eventType: 'pokemon_fainted',
          target: toViewerSide(viewerSeat, event.targetSeat),
          targetSlot: event.targetSlot,
          targetSpeciesId: event.targetSpeciesId,
        };
      case 'replacement_selected':
        return {
          eventType: 'replacement_selected',
          actor: toViewerSide(viewerSeat, event.actorSeat),
          slot: event.slot,
          speciesId: event.speciesId,
        };
      case 'forfeit':
        return {
          eventType: 'forfeit',
          actor: toViewerSide(viewerSeat, event.actorSeat),
        };
    }
  });
}
