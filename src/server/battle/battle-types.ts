import type { BattleState, MoveData, PokemonData } from '../../core/types.js';
import type { ActivePartySnapshot } from '../parties/index.js';
import type { BattleRoomRecord, BattleRoomStatus, RoomSeat } from '../rooms/index.js';
import type { PvpGeneration, RulesetKey, RulesetSummary } from '../rules/index.js';

export const BATTLE_COMMAND_REJECTION_CODES = {
  PVP_COMMAND_PHASE_MISMATCH: 'PVP_COMMAND_PHASE_MISMATCH',
  PVP_COMMAND_TURN_MISMATCH: 'PVP_COMMAND_TURN_MISMATCH',
  PVP_COMMAND_DUPLICATE: 'PVP_COMMAND_DUPLICATE',
  PVP_COMMAND_MOVE_INVALID: 'PVP_COMMAND_MOVE_INVALID',
  PVP_COMMAND_SWITCH_INVALID: 'PVP_COMMAND_SWITCH_INVALID',
  PVP_COMMAND_REPLACEMENT_INVALID: 'PVP_COMMAND_REPLACEMENT_INVALID',
  PVP_COMMAND_TIMEOUT: 'PVP_COMMAND_TIMEOUT',
  PVP_COMMAND_CLIENT_ID_REQUIRED: 'PVP_COMMAND_CLIENT_ID_REQUIRED',
  PVP_COMMAND_BATTLE_MISMATCH: 'PVP_COMMAND_BATTLE_MISMATCH',
  PVP_BATTLE_ALREADY_FINISHED: 'PVP_BATTLE_ALREADY_FINISHED',
} as const;

export type BattleCommandRejectionCode =
  (typeof BATTLE_COMMAND_REJECTION_CODES)[keyof typeof BATTLE_COMMAND_REJECTION_CODES];

export type BattleSessionPhase = 'awaiting_actions' | 'awaiting_replacement' | 'finished' | 'abandoned';
export type BattleCommandPhase = Extract<BattleSessionPhase, 'awaiting_actions' | 'awaiting_replacement'>;
export type BattleRequestKind = 'choose_move_or_switch' | 'choose_replacement';
export type BattleFinishReason = 'all_opponent_pokemon_fainted' | 'forfeit' | 'timeout_forfeit' | 'abandoned';
export type BattleCommandSource = 'client' | 'timeout_auto';

export interface ChooseMoveCommand {
  type: 'choose_move';
  moveSlot: number;
}

export interface ChooseSwitchCommand {
  type: 'choose_switch';
  targetSlot: number;
}

export interface ChooseReplacementCommand {
  type: 'choose_replacement';
  targetSlot: number;
}

export interface ForfeitCommand {
  type: 'forfeit';
}

export type BattleCommand =
  | ChooseMoveCommand
  | ChooseSwitchCommand
  | ChooseReplacementCommand
  | ForfeitCommand;

export interface BattlePokemonRuntimeMetadata {
  slot: number;
  pokemonInstanceId: string;
  speciesId: string;
  nickname?: string;
  levelActual: number;
  levelEffective: number;
  moveIds: string[];
}

export interface BattleSeatRuntimeState {
  userId: string;
  partySnapshotId: string;
  partySnapshotVersion: number;
  members: BattlePokemonRuntimeMetadata[];
}

export interface VisibleMoveOption {
  slot: number;
  id: string;
  disabled: boolean;
  currentPp?: number;
}

export interface VisibleBenchPokemon {
  slot: number;
  speciesId: string;
  nickname?: string;
  fainted: boolean;
}

export interface VisibleActivePokemon {
  slot: number;
  speciesId: string;
  nickname?: string;
  levelActual: number;
  levelEffective: number;
  hp: number;
  hpMax: number;
  status: string | null;
  fainted: boolean;
  moves?: VisibleMoveOption[];
}

export interface ViewerVisibleState {
  self: {
    active: VisibleActivePokemon;
    bench: VisibleBenchPokemon[];
  };
  opponent: {
    active: VisibleActivePokemon;
    benchCount: number;
  };
}

export interface BattleActionRequestPayload {
  turn: number;
  phase: 'awaiting_actions';
  requestId: string;
  deadlineMs: number;
  request: {
    kind: 'choose_move_or_switch';
    activePokemon: VisibleActivePokemon;
    availableMoves: VisibleMoveOption[];
    availableSwitches: VisibleBenchPokemon[];
  };
}

export interface BattleReplacementRequestPayload {
  turn: number;
  phase: 'awaiting_replacement';
  requestId: string;
  deadlineMs: number;
  faintedSlot: number | null;
  availableReplacements: VisibleBenchPokemon[];
}

export interface BattleCommandAcceptedPayload {
  clientCommandId: string;
  turn: number;
  phase: BattleCommandPhase;
  lockedIn: boolean;
}

export interface BattleCommandRejectedPayload {
  clientCommandId: string;
  code: BattleCommandRejectionCode;
  message: string;
  retryable: boolean;
}

export interface BattleSessionResult {
  winnerSeat: RoomSeat;
  loserSeat: RoomSeat;
  reason: BattleFinishReason;
  recordedAt: string;
}

export interface BattleMoveUsedEvent {
  eventType: 'move_used';
  actorSeat: RoomSeat;
  actorSlot: number;
  actorSpeciesId: string;
  moveSlot: number;
  moveId: string;
}

export interface BattleSwitchUsedEvent {
  eventType: 'switch_used';
  actorSeat: RoomSeat;
  fromSlot: number | null;
  toSlot: number;
  speciesId: string;
}

export interface BattleDamageAppliedEvent {
  eventType: 'damage_applied';
  targetSeat: RoomSeat;
  targetSlot: number;
  targetSpeciesId: string;
  hp: number;
  hpMax: number;
  damage: number;
  fainted: boolean;
}

export interface BattleStatusAppliedEvent {
  eventType: 'status_applied';
  targetSeat: RoomSeat;
  targetSlot: number;
  targetSpeciesId: string;
  status: string;
}

export interface BattlePokemonFaintedEvent {
  eventType: 'pokemon_fainted';
  targetSeat: RoomSeat;
  targetSlot: number;
  targetSpeciesId: string;
}

export interface BattleReplacementSelectedEvent {
  eventType: 'replacement_selected';
  actorSeat: RoomSeat;
  slot: number;
  speciesId: string;
}

export interface BattleForfeitEvent {
  eventType: 'forfeit';
  actorSeat: RoomSeat;
}

export type BattleLoggedEvent =
  | BattleMoveUsedEvent
  | BattleSwitchUsedEvent
  | BattleDamageAppliedEvent
  | BattleStatusAppliedEvent
  | BattlePokemonFaintedEvent
  | BattleReplacementSelectedEvent
  | BattleForfeitEvent;

export type ViewerRelativeSide = 'self' | 'opponent';

export type ProjectedBattleEvent =
  | {
      eventType: 'move_used';
      actor: ViewerRelativeSide;
      actorSlot: number;
      actorSpeciesId: string;
      moveSlot: number;
      moveId: string;
    }
  | {
      eventType: 'switch_used';
      actor: ViewerRelativeSide;
      fromSlot: number | null;
      toSlot: number;
      speciesId: string;
    }
  | {
      eventType: 'damage_applied';
      target: ViewerRelativeSide;
      targetSlot: number;
      targetSpeciesId: string;
      hp: number;
      hpMax: number;
      damage: number;
      fainted: boolean;
    }
  | {
      eventType: 'status_applied';
      target: ViewerRelativeSide;
      targetSlot: number;
      targetSpeciesId: string;
      status: string;
    }
  | {
      eventType: 'pokemon_fainted';
      target: ViewerRelativeSide;
      targetSlot: number;
      targetSpeciesId: string;
    }
  | {
      eventType: 'replacement_selected';
      actor: ViewerRelativeSide;
      slot: number;
      speciesId: string;
    }
  | {
      eventType: 'forfeit';
      actor: ViewerRelativeSide;
    };

export interface BattleTurnResolvedPayload {
  turn: number;
  events: ProjectedBattleEvent[];
  postTurnVisibleState: ViewerVisibleState;
  nextPhase: Extract<BattleSessionPhase, 'awaiting_actions' | 'awaiting_replacement' | 'finished'>;
}

export interface BattleEndedPayload {
  result: 'win' | 'loss';
  reason: BattleFinishReason;
  finalVisibleState: {
    self: { remainingCount: number };
    opponent: { remainingCount: number };
  };
}

export interface BattleCommandEnvelope {
  type: 'battle.command';
  roomId: string;
  battleId: string;
  seq: number;
  sentAt: string;
  payload: {
    clientCommandId: string;
    turn: number;
    phase: BattleCommandPhase;
    command: BattleCommand;
  };
}

interface BattleServerEventBase<TType extends string, TPayload> {
  type: TType;
  roomId: string;
  battleId: string;
  seq: number;
  sentAt: string;
  payload: TPayload;
}

export type RoomSnapshotPayload = {
  roomStatus: BattleRoomStatus;
  battleStatus: BattleSessionPhase;
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  yourSeat: RoomSeat;
  turn: number;
  visibleState: ViewerVisibleState;
  pendingRequest:
    | {
        kind: 'choose_move_or_switch';
        deadlineMs: number;
        commandSubmitted: boolean;
      }
    | {
        kind: 'choose_replacement';
        deadlineMs: number;
        commandSubmitted: boolean;
      }
    | null;
};

export type BattleServerEventEnvelope =
  | BattleServerEventBase<'room.snapshot', RoomSnapshotPayload>
  | BattleServerEventBase<'battle.request_action', BattleActionRequestPayload>
  | BattleServerEventBase<'battle.command_accepted', BattleCommandAcceptedPayload>
  | BattleServerEventBase<'battle.command_rejected', BattleCommandRejectedPayload>
  | BattleServerEventBase<'battle.turn_resolved', BattleTurnResolvedPayload>
  | BattleServerEventBase<'battle.force_replacement', BattleReplacementRequestPayload>
  | BattleServerEventBase<'battle.ended', BattleEndedPayload>;

export interface BattleDataResolver {
  resolveSpecies(generation: PvpGeneration, speciesId: string): PokemonData | undefined;
  resolveMove(generation: PvpGeneration, moveId: string): MoveData | undefined;
}

export interface BattleSessionRecord {
  roomId: string;
  battleId: string;
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  phase: BattleSessionPhase;
  turn: number;
  roomStatus: BattleRoomStatus;
  rulesetSnapshot: RulesetSummary;
  roomSnapshot: BattleRoomRecord;
  battleState: BattleState;
  seatState: Record<RoomSeat, BattleSeatRuntimeState>;
  pendingCommands: Partial<Record<RoomSeat, BattleCommandEnvelope['payload']>>;
  pendingReplacementSeats: RoomSeat[];
  pendingReplacementCommands: Partial<Record<RoomSeat, BattleCommandEnvelope['payload']>>;
  requestState: BattleRequestState | null;
  timeoutState: Record<RoomSeat, BattleSeatTimeoutState>;
  commandLog: BattleCommandLogEntry[];
  eventLog: BattleDebugEventEntry[];
  seenClientCommandIds: string[];
  nextSeq: number;
  result: BattleSessionResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface BattleSessionCreateInput {
  room: BattleRoomRecord;
  hostParty: ActivePartySnapshot;
  guestParty: ActivePartySnapshot;
}

export interface BattleSessionSubmitInput {
  session: BattleSessionRecord;
  seat: RoomSeat;
  envelope: BattleCommandEnvelope;
  source?: BattleCommandSource;
}

export interface BattleSessionMutationResult {
  session: BattleSessionRecord;
  eventsBySeat: Record<RoomSeat, BattleServerEventEnvelope[]>;
}


export interface BattleRequestState {
  kind: BattleRequestKind;
  phase: BattleCommandPhase;
  turn: number;
  issuedAt: string;
  deadlineAt: string;
  requiredSeats: RoomSeat[];
}

export interface BattleSeatTimeoutState {
  consecutive: number;
  total: number;
  lastTimeoutAt: string | null;
}

export interface BattleCommandLogEntry {
  clientCommandId: string;
  seat: RoomSeat;
  turn: number;
  phase: BattleCommandPhase;
  command: BattleCommand;
  source: BattleCommandSource;
  accepted: boolean;
  code: BattleCommandRejectionCode | null;
  recordedAt: string;
}

export interface BattleDebugEventEntry {
  seat: RoomSeat;
  type: BattleServerEventEnvelope['type'];
  seq: number;
  sentAt: string;
}

export interface BattleDebugView {
  roomId: string;
  battleId: string;
  phase: BattleSessionPhase;
  turn: number;
  requestState: BattleRequestState | null;
  commands: BattleCommandLogEntry[];
  events: BattleDebugEventEntry[];
  timeouts: Record<RoomSeat, BattleSeatTimeoutState>;
  result: BattleSessionResult | null;
}
