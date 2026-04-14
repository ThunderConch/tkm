import type { BaseStats, MoveData } from '../core/types.js';

export const FRIENDLY_BATTLE_NAMESPACE = 'friendly-battle' as const;
export const FRIENDLY_BATTLE_PROTOCOL_VERSION = 1 as const;
export const FRIENDLY_BATTLE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const FRIENDLY_BATTLE_LAYERS = ['progression', 'snapshot', 'session', 'battle'] as const;
export type FriendlyBattleLayer = (typeof FRIENDLY_BATTLE_LAYERS)[number];

export const FRIENDLY_BATTLE_ROLES = ['host', 'guest'] as const;
export type FriendlyBattleRole = (typeof FRIENDLY_BATTLE_ROLES)[number];

export const FRIENDLY_BATTLE_PARTY_SOURCES = ['current_party'] as const;
export type FriendlyBattlePartySource = (typeof FRIENDLY_BATTLE_PARTY_SOURCES)[number];

export const FRIENDLY_BATTLE_PARTICIPANT_CONNECTION_STATES = [
  'invited',
  'connected',
  'disconnected',
  'left',
] as const;
export type FriendlyBattleParticipantConnectionState =
  (typeof FRIENDLY_BATTLE_PARTICIPANT_CONNECTION_STATES)[number];

export const FRIENDLY_BATTLE_SESSION_PHASES = [
  'awaiting_guest',
  'awaiting_ready',
  'battle_starting',
  'in_battle',
  'completed',
  'cancelled',
] as const;
export type FriendlyBattleSessionPhase = (typeof FRIENDLY_BATTLE_SESSION_PHASES)[number];

export const FRIENDLY_BATTLE_TURN_PHASES = [
  'idle',
  'waiting_for_choices',
  'resolving_turn',
  'awaiting_fainted_switch',
  'completed',
] as const;
export type FriendlyBattleTurnPhase = (typeof FRIENDLY_BATTLE_TURN_PHASES)[number];

export const FRIENDLY_BATTLE_BATTLE_EVENT_TYPES = [
  'battle_initialized',
  'choices_requested',
  'turn_resolved',
  'battle_finished',
] as const;
export type FriendlyBattleBattleEventType = (typeof FRIENDLY_BATTLE_BATTLE_EVENT_TYPES)[number];

export const FRIENDLY_BATTLE_PEER_MESSAGE_TYPES = [
  'hello',
  'hello_ack',
  'hello_reject',
  'ready_state',
  'battle_started',
  'submit_choice',
  'battle_event',
  'peer_left',
  'peer_error',
] as const;
export type FriendlyBattlePeerMessageType = (typeof FRIENDLY_BATTLE_PEER_MESSAGE_TYPES)[number];

export type FriendlyBattleJoinRejectCode =
  | 'bad_session_code'
  | 'room_full'
  | 'generation_mismatch'
  | 'unsupported_protocol'
  | 'invalid_guest_snapshot';

export type FriendlyBattleCompletionReason = 'completed' | 'surrender' | 'cancelled' | 'disconnect';

export type FriendlyBattleChoice =
  | { type: 'move'; moveIndex: number }
  | { type: 'switch'; pokemonIndex: number }
  | { type: 'surrender' };

export interface FriendlyBattleReadyState {
  hostReady: boolean;
  guestReady: boolean;
  canStart: boolean;
}

export interface FriendlyBattleProgressionRef {
  layer: 'progression';
  generation: string;
  partySource: FriendlyBattlePartySource;
  partyPokemonIds: string[];
}

export interface FriendlyBattleSnapshotRef {
  layer: 'snapshot';
  snapshotId: string;
  generation: string;
  partySource: FriendlyBattlePartySource;
  partySize: number;
  createdAt: string;
}

export interface FriendlyBattleSnapshotPokemon {
  slot: number;
  progressionKey: string;
  speciesId: number;
  speciesDisplayName: string;
  displayName: string;
  nickname: string | null;
  shiny: boolean;
  level: number;
  types: string[];
  baseStats: BaseStats;
  moves: MoveData[];
  nativeGeneration: string;
}

export interface FriendlyBattlePartySnapshot {
  layer: 'snapshot';
  schemaVersion: number;
  snapshotId: string;
  generation: string;
  partySource: FriendlyBattlePartySource;
  partySize: number;
  createdAt: string;
  pokemon: FriendlyBattleSnapshotPokemon[];
}

export interface FriendlyBattleParticipant {
  role: FriendlyBattleRole;
  playerName: string;
  connectionState: FriendlyBattleParticipantConnectionState;
  ready: boolean;
}

export interface FriendlyBattleChoiceEnvelope {
  actor: FriendlyBattleRole;
  submittedAt: string;
  choice: FriendlyBattleChoice;
}

export interface FriendlyBattleBattleRef {
  layer: 'battle';
  battleId: string | null;
  turn: number;
  phase: FriendlyBattleTurnPhase;
  startedAt: string | null;
  endedAt: string | null;
}

export interface FriendlyBattleBattleInitializedEvent {
  type: 'battle_initialized';
  battleId: string;
  turn: number;
  /**
   * Optional authoritative live state. Populated by the host's battle-adapter
   * runtime so the guest daemon can render real HP / species names on the
   * initial battle-started screen without falling back to its own species-base
   * snapshot (which would show 100/100 for Dialga etc).
   */
  liveState?: FriendlyBattleLiveBattleState;
}

export interface FriendlyBattleLiveActiveMove {
  index: number;       // 1-based slot index for SKILL.md / CLI
  moveId: number;      // canonical move id; each daemon localizes locally
  nameKo: string;      // host-locale fallback for legacy clients without ID lookup
  pp: number;
  maxPp: number;
  disabled: boolean;
}

export interface FriendlyBattleLivePartyEntry {
  index: number;       // 1-based slot index for SKILL.md / CLI
  pokemonId: number;   // canonical species id; each daemon localizes locally
  name: string;        // host-locale fallback
  level: number;
  hp: number;
  maxHp: number;
  fainted: boolean;
}

export interface FriendlyBattleLiveTeam {
  active: {
    pokemonId: number; // canonical species id; each daemon localizes locally
    name: string;      // host-locale fallback
    level: number;
    hp: number;
    maxHp: number;
    fainted: boolean;
    moves: FriendlyBattleLiveActiveMove[];
  };
  party: FriendlyBattleLivePartyEntry[];
}

/**
 * Authoritative battle state snapshot built by the host's battle-adapter
 * runtime and embedded into choices_requested events. Guests do NOT compute
 * their own state — they render whatever the host published in the event.
 */
export interface FriendlyBattleLiveBattleState {
  host: FriendlyBattleLiveTeam;
  guest: FriendlyBattleLiveTeam;
}

export interface FriendlyBattleChoicesRequestedEvent {
  type: 'choices_requested';
  turn: number;
  waitingFor: FriendlyBattleRole[];
  phase: Extract<FriendlyBattleTurnPhase, 'waiting_for_choices' | 'awaiting_fainted_switch'>;
  /**
   * Optional authoritative live state. Populated by the host's battle-adapter
   * runtime so the guest daemon can render real HP / PP / fainted info without
   * maintaining its own runtime. Older event producers (existing tests, legacy
   * code) may omit this field — daemons fall back to local snapshot in that
   * case.
   */
  liveState?: FriendlyBattleLiveBattleState;
}

export interface FriendlyBattleTurnResolvedEvent {
  type: 'turn_resolved';
  turn: number;
  messages: string[];
  waitingFor: FriendlyBattleRole[];
  nextPhase: FriendlyBattleTurnPhase;
  winner: FriendlyBattleRole | null;
  /**
   * Optional authoritative live state at the END of this turn (post-damage,
   * post-switch). Guest daemons use this to render the post-turn HP without
   * relying on their own runtime.
   */
  liveState?: FriendlyBattleLiveBattleState;
}

export interface FriendlyBattleFinishedEvent {
  type: 'battle_finished';
  winner: FriendlyBattleRole | null;
  reason: FriendlyBattleCompletionReason;
}

export type FriendlyBattleBattleEvent =
  | FriendlyBattleBattleInitializedEvent
  | FriendlyBattleChoicesRequestedEvent
  | FriendlyBattleTurnResolvedEvent
  | FriendlyBattleFinishedEvent;

export interface FriendlyBattleSessionState {
  layer: 'session';
  protocolVersion: number;
  sessionId: string;
  sessionCode: string;
  generation: string;
  phase: FriendlyBattleSessionPhase;
  createdAt: string;
  updatedAt: string;
  host: FriendlyBattleParticipant;
  guest: FriendlyBattleParticipant;
  readyState: FriendlyBattleReadyState;
  hostProgression: FriendlyBattleProgressionRef;
  guestProgression: FriendlyBattleProgressionRef | null;
  hostSnapshot: FriendlyBattleSnapshotRef | null;
  guestSnapshot: FriendlyBattleSnapshotRef | null;
  pendingChoices: Partial<Record<FriendlyBattleRole, FriendlyBattleChoiceEnvelope>>;
  battle: FriendlyBattleBattleRef;
}

export interface FriendlyBattleHelloMessage {
  type: 'hello';
  protocolVersion: number;
  sessionCode: string;
  generation: string;
  guestPlayerName: string;
  guestSnapshot: FriendlyBattlePartySnapshot;
}

export interface FriendlyBattleHelloAckMessage {
  type: 'hello_ack';
  protocolVersion: number;
  generation: string;
  hostPlayerName: string;
  readyState: FriendlyBattleReadyState;
}

export interface FriendlyBattleHelloRejectMessage {
  type: 'hello_reject';
  code: FriendlyBattleJoinRejectCode;
  message: string;
}

export interface FriendlyBattleReadyStateMessage {
  type: 'ready_state';
  readyState: FriendlyBattleReadyState;
}

export interface FriendlyBattleStartedMessage {
  type: 'battle_started';
  battleId: string;
}

export interface FriendlyBattleSubmitChoiceMessage {
  type: 'submit_choice';
  envelope: FriendlyBattleChoiceEnvelope;
}

export interface FriendlyBattleBattleEventMessage {
  type: 'battle_event';
  event: FriendlyBattleBattleEvent;
}

export interface FriendlyBattlePeerLeftMessage {
  type: 'peer_left';
  actor: FriendlyBattleRole;
  reason: FriendlyBattleCompletionReason;
}

export interface FriendlyBattlePeerErrorMessage {
  type: 'peer_error';
  code: string;
  message: string;
}

export type FriendlyBattlePeerMessage =
  | FriendlyBattleHelloMessage
  | FriendlyBattleHelloAckMessage
  | FriendlyBattleHelloRejectMessage
  | FriendlyBattleReadyStateMessage
  | FriendlyBattleStartedMessage
  | FriendlyBattleSubmitChoiceMessage
  | FriendlyBattleBattleEventMessage
  | FriendlyBattlePeerLeftMessage
  | FriendlyBattlePeerErrorMessage;

export interface CreateFriendlyBattleSessionStateInput {
  sessionId: string;
  sessionCode: string;
  generation: string;
  hostPlayerName: string;
  hostProgression: FriendlyBattleProgressionRef;
  createdAt?: string;
  protocolVersion?: number;
}

export function createFriendlyBattleReadyState(
  hostReady: boolean,
  guestReady: boolean,
): FriendlyBattleReadyState {
  return {
    hostReady,
    guestReady,
    canStart: hostReady && guestReady,
  };
}

export function createFriendlyBattleParticipant(
  role: FriendlyBattleRole,
  playerName: string,
  options?: {
    connectionState?: FriendlyBattleParticipantConnectionState;
    ready?: boolean;
  },
): FriendlyBattleParticipant {
  return {
    role,
    playerName,
    connectionState: options?.connectionState ?? (role === 'host' ? 'connected' : 'invited'),
    ready: options?.ready ?? false,
  };
}

export function createFriendlyBattleBattleRef(): FriendlyBattleBattleRef {
  return {
    layer: 'battle',
    battleId: null,
    turn: 0,
    phase: 'idle',
    startedAt: null,
    endedAt: null,
  };
}

export function createFriendlyBattleSessionState(
  input: CreateFriendlyBattleSessionStateInput,
): FriendlyBattleSessionState {
  if (input.generation !== input.hostProgression.generation) {
    throw new Error('Friendly battle session generation must match host progression generation');
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    layer: 'session',
    protocolVersion: input.protocolVersion ?? FRIENDLY_BATTLE_PROTOCOL_VERSION,
    sessionId: input.sessionId,
    sessionCode: input.sessionCode,
    generation: input.generation,
    phase: 'awaiting_guest',
    createdAt,
    updatedAt: createdAt,
    host: createFriendlyBattleParticipant('host', input.hostPlayerName),
    guest: createFriendlyBattleParticipant('guest', 'Guest'),
    readyState: createFriendlyBattleReadyState(false, false),
    hostProgression: input.hostProgression,
    guestProgression: null,
    hostSnapshot: null,
    guestSnapshot: null,
    pendingChoices: {},
    battle: createFriendlyBattleBattleRef(),
  };
}

export function isFriendlyBattlePeerMessageType(value: string): value is FriendlyBattlePeerMessageType {
  return (FRIENDLY_BATTLE_PEER_MESSAGE_TYPES as readonly string[]).includes(value);
}

export function canFriendlyBattleStart(source: FriendlyBattleReadyState | FriendlyBattleSessionState): boolean {
  if ('layer' in source) {
    return source.readyState.canStart;
  }
  return source.canStart;
}
