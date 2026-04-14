import {
  applyBattleSwitch,
  createBattleState,
  hasAlivePokemon,
  resolveTurn,
} from '../core/turn-battle.js';
import type { BattlePokemon, BattleState, BattleTeam, TurnAction } from '../core/types.js';
import type {
  FriendlyBattleBattleEvent,
  FriendlyBattleBattleRef,
  FriendlyBattleChoice,
  FriendlyBattleChoiceEnvelope,
  FriendlyBattleCompletionReason,
  FriendlyBattleLiveActiveMove,
  FriendlyBattleLiveBattleState,
  FriendlyBattleLivePartyEntry,
  FriendlyBattleLiveTeam,
  FriendlyBattleRole,
  FriendlyBattleTurnPhase,
} from './contracts.js';

export interface FriendlyBattleBattleRuntime {
  battleId: string;
  state: BattleState;
  phase: Exclude<FriendlyBattleTurnPhase, 'idle'>;
  startedAt: string;
  endedAt: string | null;
  pendingChoices: Partial<Record<FriendlyBattleRole, FriendlyBattleChoiceEnvelope>>;
}

export interface CreateFriendlyBattleBattleRuntimeInput {
  battleId: string;
  hostTeam: BattlePokemon[];
  guestTeam: BattlePokemon[];
  startedAt?: string;
}

export function createFriendlyBattleBattleRuntime(
  input: CreateFriendlyBattleBattleRuntimeInput,
): { runtime: FriendlyBattleBattleRuntime; events: FriendlyBattleBattleEvent[] } {
  if (input.hostTeam.length === 0) {
    throw new Error('Friendly battle host team must contain at least one Pokemon');
  }

  if (input.guestTeam.length === 0) {
    throw new Error('Friendly battle guest team must contain at least one Pokemon');
  }

  const runtime: FriendlyBattleBattleRuntime = {
    battleId: input.battleId,
    state: createBattleState(structuredClone(input.hostTeam), structuredClone(input.guestTeam)),
    phase: 'waiting_for_choices',
    startedAt: input.startedAt ?? new Date().toISOString(),
    endedAt: null,
    pendingChoices: {},
  };

  const initialLiveState = buildFriendlyBattleLiveBattleState(runtime.state);
  return {
    runtime,
    events: [
      {
        type: 'battle_initialized',
        battleId: input.battleId,
        turn: runtime.state.turn,
        liveState: initialLiveState,
      },
      {
        type: 'choices_requested',
        turn: runtime.state.turn + 1,
        waitingFor: ['host', 'guest'],
        phase: 'waiting_for_choices',
        liveState: initialLiveState,
      },
    ],
  };
}

export function toFriendlyBattleBattleRef(
  runtime: FriendlyBattleBattleRuntime,
): FriendlyBattleBattleRef {
  return {
    layer: 'battle',
    battleId: runtime.battleId,
    turn: runtime.state.turn,
    phase: runtime.phase,
    startedAt: runtime.startedAt,
    endedAt: runtime.endedAt,
  };
}

export function submitFriendlyBattleChoice(
  runtime: FriendlyBattleBattleRuntime,
  envelope: FriendlyBattleChoiceEnvelope,
): FriendlyBattleBattleEvent[] {
  if (runtime.phase === 'completed') {
    throw new Error('Friendly battle already completed');
  }

  const waitingFor = getWaitingFor(runtime);
  if (!waitingFor.includes(envelope.actor)) {
    throw new Error(`Friendly battle is not waiting for ${envelope.actor}`);
  }

  validateChoiceForPhase(runtime.phase, envelope.choice);
  validateChoiceForActor(runtime, envelope.actor, envelope.choice);

  runtime.pendingChoices[envelope.actor] = envelope;

  if (getWaitingFor(runtime).length > 0) {
    return [];
  }

  if (runtime.phase === 'waiting_for_choices') {
    return resolveChoiceTurn(runtime);
  }

  return resolveFaintedSwitchTurn(runtime);
}

function resolveChoiceTurn(runtime: FriendlyBattleBattleRuntime): FriendlyBattleBattleEvent[] {
  const hostChoice = runtime.pendingChoices.host;
  const guestChoice = runtime.pendingChoices.guest;
  if (!hostChoice || !guestChoice) {
    throw new Error('Friendly battle requires both host and guest choices before resolving');
  }

  const result = resolveTurn(
    runtime.state,
    toTurnAction(hostChoice.choice),
    toTurnAction(guestChoice.choice),
  );

  return finalizeResolution(runtime, {
    messages: result.messages,
    winner: toFriendlyBattleWinner(runtime.state.winner),
    reason: inferCompletionReason(hostChoice.choice, guestChoice.choice),
    submittedAt: latestSubmittedAt(runtime.pendingChoices),
  });
}

function resolveFaintedSwitchTurn(runtime: FriendlyBattleBattleRuntime): FriendlyBattleBattleEvent[] {
  const switchWaiters = computeRequiredSwitchWaiters(runtime.state);

  const submittedChoices = Object.fromEntries(
    switchWaiters.map((role) => [role, runtime.pendingChoices[role]]),
  ) as Record<FriendlyBattleRole, FriendlyBattleChoiceEnvelope | undefined>;

  for (const role of switchWaiters) {
    const envelope = submittedChoices[role];
    if (!envelope) {
      throw new Error(`Friendly battle is still waiting for ${role} to switch`);
    }

    if (envelope.choice.type === 'surrender') {
      return finalizeResolution(runtime, {
        messages: ['항복했다...'],
        winner: role === 'host' ? 'guest' : 'host',
        reason: 'surrender',
        submittedAt: latestSubmittedAt(runtime.pendingChoices),
      });
    }
  }

  const messages: string[] = [];

  for (const role of switchWaiters) {
    const envelope = submittedChoices[role];
    if (!envelope || envelope.choice.type !== 'switch') {
      throw new Error(`Friendly battle ${role} must submit a switch choice`);
    }

    const switched = role === 'host'
      ? applyBattleSwitch(
        runtime.state.player,
        envelope.choice.pokemonIndex,
        messages,
        runtime.state.opponent,
        'player',
      )
      : applyBattleSwitch(
        runtime.state.opponent,
        envelope.choice.pokemonIndex,
        messages,
        runtime.state.player,
        'opponent',
      );

    if (!switched) {
      throw new Error(`Friendly battle ${role} submitted an invalid switch target`);
    }
  }

  runtime.state.phase = 'select_action';

  return finalizeResolution(runtime, {
    messages,
    winner: null,
    reason: null,
    submittedAt: latestSubmittedAt(runtime.pendingChoices),
  });
}

function finalizeResolution(
  runtime: FriendlyBattleBattleRuntime,
  resolution: {
    messages: string[];
    winner: FriendlyBattleRole | null;
    reason: FriendlyBattleCompletionReason | null;
    submittedAt: string;
  },
): FriendlyBattleBattleEvent[] {
  runtime.pendingChoices = {};

  const waiters = resolution.winner === null ? computeRequiredSwitchWaiters(runtime.state) : [];
  const nextPhase = resolution.winner !== null
    ? 'completed'
    : waiters.length > 0
      ? 'awaiting_fainted_switch'
      : 'waiting_for_choices';
  const nextWaiters: FriendlyBattleRole[] = nextPhase === 'completed'
    ? []
    : nextPhase === 'awaiting_fainted_switch'
      ? waiters
      : ['host', 'guest'];

  runtime.phase = nextPhase;

  const postTurnLiveState = buildFriendlyBattleLiveBattleState(runtime.state);
  const events: FriendlyBattleBattleEvent[] = [
    {
      type: 'turn_resolved',
      turn: runtime.state.turn === 0 ? 1 : runtime.state.turn,
      messages: resolution.messages,
      waitingFor: nextWaiters,
      nextPhase,
      winner: resolution.winner,
      liveState: postTurnLiveState,
    },
  ];

  if (resolution.winner !== null) {
    runtime.endedAt = resolution.submittedAt;
    events.push({
      type: 'battle_finished',
      winner: resolution.winner,
      reason: resolution.reason ?? 'completed',
    });
    return events;
  }

  if (waiters.length > 0) {
    events.push({
      type: 'choices_requested',
      turn: runtime.state.turn,
      waitingFor: waiters,
      phase: 'awaiting_fainted_switch',
      liveState: buildFriendlyBattleLiveBattleState(runtime.state),
    });
    return events;
  }

  events.push({
    type: 'choices_requested',
    turn: runtime.state.turn + 1,
    waitingFor: ['host', 'guest'],
    phase: 'waiting_for_choices',
    liveState: buildFriendlyBattleLiveBattleState(runtime.state),
  });
  return events;
}

export function getFriendlyBattleWaitingForRoles(runtime: FriendlyBattleBattleRuntime): FriendlyBattleRole[] {
  const expectedRoles: FriendlyBattleRole[] = runtime.phase === 'awaiting_fainted_switch'
    ? computeRequiredSwitchWaiters(runtime.state)
    : ['host', 'guest'];

  return expectedRoles.filter((role) => runtime.pendingChoices[role] === undefined);
}

function getWaitingFor(runtime: FriendlyBattleBattleRuntime): FriendlyBattleRole[] {
  return getFriendlyBattleWaitingForRoles(runtime);
}

function computeRequiredSwitchWaiters(state: BattleState): FriendlyBattleRole[] {
  const waiters: FriendlyBattleRole[] = [];

  if (requiresForcedSwitch(state.player)) {
    waiters.push('host');
  }

  if (requiresForcedSwitch(state.opponent)) {
    waiters.push('guest');
  }

  return waiters;
}

function requiresForcedSwitch(team: BattleState['player']): boolean {
  const activePokemon = team.pokemon[team.activeIndex];
  return activePokemon !== undefined && activePokemon.fainted && hasAlivePokemon(team);
}

function toTurnAction(choice: FriendlyBattleChoice): TurnAction {
  switch (choice.type) {
    case 'move':
      return { type: 'move', moveIndex: choice.moveIndex };
    case 'switch':
      return { type: 'switch', pokemonIndex: choice.pokemonIndex };
    case 'surrender':
      return { type: 'surrender' };
  }
}

function validateChoiceForPhase(
  phase: FriendlyBattleBattleRuntime['phase'],
  choice: FriendlyBattleChoice,
): void {
  if (phase === 'awaiting_fainted_switch') {
    if (choice.type === 'move') {
      throw new Error('Friendly battle is waiting for a switch choice');
    }
    return;
  }
}

function validateChoiceForActor(
  runtime: FriendlyBattleBattleRuntime,
  actor: FriendlyBattleRole,
  choice: FriendlyBattleChoice,
): void {
  if (choice.type === 'surrender') {
    return;
  }

  const team = getTeamForRole(runtime.state, actor);
  const activePokemon = team.pokemon[team.activeIndex];

  if (!activePokemon) {
    throw new Error(`Friendly battle ${actor} has no active Pokemon`);
  }

  if (choice.type === 'move') {
    const move = activePokemon.moves[choice.moveIndex];
    const hasUsableMoves = activePokemon.moves.some((candidate) => candidate.currentPp > 0);
    if (!move || (hasUsableMoves && move.currentPp <= 0)) {
      throw new Error(`Friendly battle ${actor} submitted an invalid move choice`);
    }
    return;
  }

  const switchTarget = team.pokemon[choice.pokemonIndex];
  if (
    !switchTarget ||
    switchTarget.fainted ||
    choice.pokemonIndex === team.activeIndex
  ) {
    throw new Error(`Friendly battle ${actor} submitted an invalid switch target`);
  }
}

function getTeamForRole(
  state: BattleState,
  actor: FriendlyBattleRole,
): BattleState['player'] {
  return actor === 'host' ? state.player : state.opponent;
}

function inferCompletionReason(
  hostChoice: FriendlyBattleChoice,
  guestChoice: FriendlyBattleChoice,
): FriendlyBattleCompletionReason | null {
  if (hostChoice.type === 'surrender' || guestChoice.type === 'surrender') {
    return 'surrender';
  }

  return null;
}

function toFriendlyBattleWinner(
  winner: BattleState['winner'],
): FriendlyBattleRole | null {
  if (winner === 'player') {
    return 'host';
  }

  if (winner === 'opponent') {
    return 'guest';
  }

  return null;
}

function latestSubmittedAt(
  pendingChoices: Partial<Record<FriendlyBattleRole, FriendlyBattleChoiceEnvelope>>,
): string {
  const submittedAt = Object.values(pendingChoices)
    .map((choice) => choice?.submittedAt)
    .filter((value): value is string => value !== undefined)
    .sort();

  return submittedAt.at(-1) ?? new Date().toISOString();
}

/**
 * Build the authoritative live battle state from the host's runtime. The
 * resulting object is embedded into choices_requested events so the guest
 * daemon can render real HP / PP / fainted info without maintaining its own
 * runtime. Host = state.player, guest = state.opponent (matches the role
 * mapping used everywhere else in the friendly-battle module).
 */
export function buildFriendlyBattleLiveBattleState(state: BattleState): FriendlyBattleLiveBattleState {
  return {
    host: buildLiveTeam(state.player),
    guest: buildLiveTeam(state.opponent),
  };
}

function buildLiveTeam(team: BattleTeam): FriendlyBattleLiveTeam {
  const active = team.pokemon[team.activeIndex];
  const moves: FriendlyBattleLiveActiveMove[] = active
    ? active.moves.map((m, i) => ({
        index: i + 1,
        moveId: m.data.id,
        nameKo: m.data.nameKo ?? m.data.name ?? `Move ${i + 1}`,
        pp: m.currentPp,
        maxPp: m.data.pp,
        disabled: m.currentPp <= 0,
      }))
    : [];
  return {
    active: {
      pokemonId: active?.id ?? 0,
      name: active?.displayName ?? active?.name ?? 'Unknown',
      level: active?.level ?? 1,
      hp: active?.currentHp ?? 0,
      maxHp: active?.maxHp ?? 0,
      fainted: active?.fainted ?? false,
      moves,
    },
    party: team.pokemon.map((p, i): FriendlyBattleLivePartyEntry => ({
      index: i + 1,
      pokemonId: p.id,
      name: p.displayName ?? p.name ?? `Pokemon ${i + 1}`,
      level: p.level,
      hp: p.currentHp,
      maxHp: p.maxHp,
      fainted: p.fainted,
    })),
  };
}
