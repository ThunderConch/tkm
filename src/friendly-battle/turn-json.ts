import type { FriendlyBattleSessionRecord } from './session-store.js';

export interface FriendlyBattleTurnMoveOption {
  index: number;
  nameKo: string;
  pp: number;
  maxPp: number;
  disabled: boolean;
}

export interface FriendlyBattleTurnPartyOption {
  index: number;
  name: string;
  hp: number;
  maxHp: number;
  fainted: boolean;
}

export interface FriendlyBattleTurnAnimationFrame {
  kind: string;
  durationMs: number;
  [k: string]: unknown;
}

export interface FriendlyBattleTurnJson {
  sessionId: string;
  role: 'host' | 'guest';
  phase: string;
  status: string;
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
}

export interface FormatFriendlyBattleTurnJsonInput {
  record: FriendlyBattleSessionRecord;
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
}

export function formatFriendlyBattleTurnJson(
  input: FormatFriendlyBattleTurnJsonInput,
): FriendlyBattleTurnJson {
  return {
    sessionId: input.record.sessionId,
    role: input.record.role,
    phase: input.record.phase,
    status: input.record.status,
    questionContext: input.questionContext,
    moveOptions: input.moveOptions,
    partyOptions: input.partyOptions,
    animationFrames: input.animationFrames,
    currentFrameIndex: input.currentFrameIndex,
  };
}
