import type { ActivePartySnapshot } from '../parties/index.js';
import type { PvpGeneration, RulesetKey, RulesetSummary } from '../rules/index.js';

export type BattleRoomMode = 'friendly_private';
export type BattleRoomVisibility = 'private_friend';
export type BattleRoomStatus =
  | 'waiting_for_opponent'
  | 'awaiting_presence'
  | 'starting'
  | 'in_progress'
  | 'finished'
  | 'cancelled';
export type RoomSeat = 'host' | 'guest';
export type RoomPresence = 'offline' | 'connected' | 'disconnected';
export type BattleFreezeStatus = 'waiting_for_opponent' | 'pending_presence';

export interface RoomSummary {
  roomId: string;
  roomCode: string;
  mode: BattleRoomMode;
  visibility: BattleRoomVisibility;
  status: BattleRoomStatus;
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
}

export interface RoomPlayerBinding {
  seat: RoomSeat;
  userId: string;
  partySnapshotId: string;
  partySnapshotVersion: number;
  partyValidationStatus: ActivePartySnapshot['validationStatus'];
  presence: RoomPresence;
  joinedAt: string;
  battleReady: boolean;
}

export interface BattleFreezeSnapshot {
  freezeStatus: Extract<BattleFreezeStatus, 'pending_presence'>;
  preparedAt: string;
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  rulesetHash: string;
  rulesetSnapshot: RulesetSummary;
  hostPartySnapshotId: string;
  hostPartySnapshotVersion: number;
  guestPartySnapshotId: string;
  guestPartySnapshotVersion: number;
  battleSeed: string;
}

export interface BattleRoomRecord {
  room: RoomSummary;
  host: RoomPlayerBinding;
  guest: RoomPlayerBinding | null;
  rulesetSnapshot: RulesetSummary;
  battleFreeze: BattleFreezeSnapshot | null;
}

export interface CreateRoomInput {
  playerId: string;
  generation: string;
  visibility: string;
  rulesetKey?: string;
}

export interface JoinRoomInput {
  playerId: string;
  roomId: string;
  roomCode: string;
  generation: string;
}
