import type { BattleCommand, BattleCommandPhase, BattleCommandRejectedPayload } from '../server/battle/index.js';
import type { PvpSessionClientState } from './session-client.js';
import { isCommandLocked, type PendingCommandState, type PvpPendingRequest, type PvpSessionState } from './session-store.js';

export type PvpCommandSubmissionState = 'none' | 'created' | 'accepted' | 'rejected_permanent';

export interface PvpCommandRejectionSummary {
  code: BattleCommandRejectedPayload['code'];
  message: string;
  retryable: boolean;
  statusLabel: string;
  summary: string;
}

export interface PvpCommandStatusView {
  source: 'session';
  turn: number | null;
  phase: BattleCommandPhase | null;
  requestKind: PvpPendingRequest['kind'] | null;
  hasPendingRequest: boolean;
  submissionState: PvpCommandSubmissionState;
  commandSummary: string | null;
  statusLabel: string;
  detailLabel: string | null;
  locked: boolean;
  canInteract: boolean;
  requestCommandSubmitted: boolean;
  pendingCommandStatus: PendingCommandState['status'] | null;
  pendingCommandLockedIn: boolean | null;
  relationSummary: string;
  rejection: PvpCommandRejectionSummary | null;
}

export interface CreatePvpCommandStatusViewOptions {
  canInteract?: boolean;
}

function summarizeCommand(command: BattleCommand | null | undefined): string | null {
  if (!command) {
    return null;
  }

  switch (command.type) {
    case 'choose_move':
      return `기술 ${command.moveSlot}번`;
    case 'choose_switch':
      return `교체 슬롯 ${command.targetSlot}`;
    case 'choose_replacement':
      return `replacement 슬롯 ${command.targetSlot}`;
    case 'forfeit':
      return '항복';
  }
}

function resolveSubmissionState(session: PvpSessionState): PvpCommandSubmissionState {
  const pendingStatus = session.pendingCommand?.status;

  if (pendingStatus === 'rejected_permanent') {
    return 'rejected_permanent';
  }

  if (pendingStatus === 'accepted' || session.pendingRequest?.commandSubmitted === true) {
    return 'accepted';
  }

  if (pendingStatus === 'created') {
    return 'created';
  }

  return 'none';
}

function createRejectionSummary(rejection: BattleCommandRejectedPayload | null): PvpCommandRejectionSummary | null {
  if (!rejection) {
    return null;
  }

  const statusLabel = rejection.retryable ? '재제출 가능' : '재제출 불가';

  return {
    code: rejection.code,
    message: rejection.message,
    retryable: rejection.retryable,
    statusLabel,
    summary: `${statusLabel} · ${rejection.code} · ${rejection.message}`,
  };
}

function resolveStatusLabel(view: {
  hasPendingRequest: boolean;
  submissionState: PvpCommandSubmissionState;
  requestCommandSubmitted: boolean;
  rejection: PvpCommandRejectionSummary | null;
  pendingCommandLockedIn: boolean | null;
}): string {
  if (!view.hasPendingRequest) {
    return '제출 대기 없음';
  }

  switch (view.submissionState) {
    case 'created':
      return '서버 접수 확인 대기';
    case 'accepted':
      return view.requestCommandSubmitted && view.pendingCommandLockedIn === null ? '이미 제출됨' : '명령 접수 완료';
    case 'rejected_permanent':
      return '명령 영구 거부';
    case 'none':
      return view.rejection?.retryable ? '다시 제출 필요' : '명령 선택 가능';
  }
}

function resolveDetailLabel(view: {
  hasPendingRequest: boolean;
  submissionState: PvpCommandSubmissionState;
  rejection: PvpCommandRejectionSummary | null;
  pendingCommandLockedIn: boolean | null;
}): string | null {
  if (!view.hasPendingRequest) {
    return '활성 요청 없음';
  }

  switch (view.submissionState) {
    case 'created':
      return 'battle.command_accepted 대기 중';
    case 'accepted':
      return view.pendingCommandLockedIn === null ? '스냅샷 기준 제출 완료' : (view.pendingCommandLockedIn ? '상대 입력/턴 해석 대기' : '서버 lock-in 대기');
    case 'rejected_permanent':
      return view.rejection?.summary ?? '재제출 없이 서버 진행을 기다려야 합니다.';
    case 'none':
      return view.rejection?.summary ?? '아직 제출한 명령 없음';
  }
}

function resolveRelationSummary(view: {
  hasPendingRequest: boolean;
  submissionState: PvpCommandSubmissionState;
  requestCommandSubmitted: boolean;
  pendingCommandStatus: PendingCommandState['status'] | null;
  rejection: PvpCommandRejectionSummary | null;
}): string {
  if (!view.hasPendingRequest) {
    return '활성 요청이 없어 commandSubmitted / pendingCommand 관계를 추적하지 않습니다.';
  }

  switch (view.submissionState) {
    case 'created':
      return '로컬 pendingCommand는 created 상태이지만 서버의 battle.command_accepted를 아직 받지 않아 request.commandSubmitted=false 입니다.';
    case 'accepted':
      return view.pendingCommandStatus === 'accepted'
        ? '서버가 명령을 접수해 pendingCommand.status=accepted, request.commandSubmitted=true 로 일치합니다.'
        : '서버 스냅샷 기준으로 request.commandSubmitted=true 이지만 로컬 pendingCommand 세부 정보는 없습니다.';
    case 'rejected_permanent':
      return '마지막 제출이 영구 거부되어 pendingCommand.status=rejected_permanent 입니다. 현재 요청은 잠긴 상태로 간주합니다.';
    case 'none':
      return view.rejection?.retryable
        ? '이전 명령이 거부되어 pendingCommand는 비워졌고 request.commandSubmitted=false 로 되돌아갔습니다. 다시 제출할 수 있습니다.'
        : '아직 제출된 명령이 없어 pendingCommand=null, request.commandSubmitted=false 상태입니다.';
  }
}

export function createPvpCommandStatusViewFromSession(
  session: PvpSessionState | null,
  options: CreatePvpCommandStatusViewOptions = {},
): PvpCommandStatusView | null {
  if (!session) {
    return null;
  }

  const hasPendingRequest = session.pendingRequest !== null;
  const submissionState = resolveSubmissionState(session);
  const requestCommandSubmitted = session.pendingRequest?.commandSubmitted ?? false;
  const rejection = createRejectionSummary(session.lastRejectedCommand);
  const locked = isCommandLocked(session);
  const defaultCanInteract = hasPendingRequest && !locked;
  const canInteract = options.canInteract ?? defaultCanInteract;
  const pendingCommandStatus = session.pendingCommand?.status ?? null;
  const pendingCommandLockedIn = session.pendingCommand?.lockedIn ?? null;
  const turn = session.pendingCommand?.turn ?? session.pendingRequest?.turn ?? session.turn;
  const phase = session.pendingCommand?.phase ?? session.pendingRequest?.phase ?? null;

  return {
    source: 'session',
    turn,
    phase,
    requestKind: session.pendingRequest?.kind ?? null,
    hasPendingRequest,
    submissionState,
    commandSummary: summarizeCommand(session.pendingCommand?.command),
    statusLabel: resolveStatusLabel({
      hasPendingRequest,
      submissionState,
      requestCommandSubmitted,
      rejection,
      pendingCommandLockedIn,
    }),
    detailLabel: resolveDetailLabel({
      hasPendingRequest,
      submissionState,
      rejection,
      pendingCommandLockedIn,
    }),
    locked,
    canInteract,
    requestCommandSubmitted,
    pendingCommandStatus,
    pendingCommandLockedIn,
    relationSummary: resolveRelationSummary({
      hasPendingRequest,
      submissionState,
      requestCommandSubmitted,
      pendingCommandStatus,
      rejection,
    }),
    rejection,
  };
}

export function createPvpCommandStatusView(state: PvpSessionClientState | null): PvpCommandStatusView | null {
  if (!state) {
    return null;
  }

  return createPvpCommandStatusViewFromSession(state.session, {
    canInteract: state.hasPendingRequest && state.canSendCommand && !isCommandLocked(state.session),
  });
}
