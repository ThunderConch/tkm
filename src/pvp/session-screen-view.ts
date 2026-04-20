import type { BattleSessionPhase, BattleServerEventEnvelope } from '../server/battle/index.js';
import type { PvpSessionClientReconnectState, PvpSessionClientState } from './session-client.js';
import {
  createPvpActionRequestView,
  type PvpActionRequestView,
} from './action-request-view.js';
import {
  createPvpCommandStatusView,
  type PvpCommandStatusView,
} from './command-status-view.js';
import {
  createPvpTurnResultView,
  type PvpTurnResolvedPayloadLike,
  type PvpTurnResultView,
} from './turn-result-view.js';

export type PvpSessionScreenStatus = 'idle' | 'awaiting_input' | 'command_locked' | 'reconnecting' | 'transport_wait' | 'terminal';

export interface PvpSessionScreenTransportSummary {
  transportStatus: PvpSessionClientState['transportStatus'];
  summaryLabel: string;
  detailLabel: string | null;
  reconnectLabel: string;
  live: boolean;
  recovering: boolean;
}

export interface PvpSessionScreenSessionSummary {
  roomId: string | null;
  battleId: string | null;
  turn: number | null;
  battleStatus: BattleSessionPhase | null;
  roomStatus: PvpSessionClientState['session']['roomStatus'];
  generation: PvpSessionClientState['session']['generation'];
  rulesetKey: PvpSessionClientState['session']['rulesetKey'];
  yourSeat: PvpSessionClientState['session']['yourSeat'];
  summaryLabel: string;
  detailLabel: string;
  lastEventType: BattleServerEventEnvelope['type'] | null;
  lastEventAt: string | null;
  lastEventLabel: string;
}

export interface PvpSessionScreenView {
  source: 'session';
  status: PvpSessionScreenStatus;
  statusLabel: string;
  detailLabel: string | null;
  emptyStateLabel: string | null;
  terminal: boolean;
  hasPendingRequest: boolean;
  hasTurnResult: boolean;
  hasRenderableContent: boolean;
  transport: PvpSessionScreenTransportSummary;
  session: PvpSessionScreenSessionSummary;
  actionRequest: PvpActionRequestView | null;
  commandStatus: PvpCommandStatusView | null;
  turnResult: PvpTurnResultView | null;
}

function createTransportSummary(state: PvpSessionClientState): PvpSessionScreenTransportSummary {
  return {
    transportStatus: state.transportStatus,
    summaryLabel: summarizeTransportStatus(state.transportStatus),
    detailLabel: summarizeReconnectDetail(state.reconnect),
    reconnectLabel: state.reconnect.autoReconnectEnabled ? '자동 재접속 켜짐' : '자동 재접속 꺼짐',
    live: state.transportStatus === 'connected',
    recovering: state.transportStatus === 'reconnecting' || state.reconnect.scheduled,
  };
}

function summarizeTransportStatus(status: PvpSessionClientState['transportStatus']): string {
  switch (status) {
    case 'idle':
      return '연결 대기';
    case 'connecting':
      return '서버 연결 중';
    case 'connected':
      return '실시간 연결됨';
    case 'reconnecting':
      return '재접속 시도 중';
    case 'closed':
      return '연결 종료';
    case 'error':
      return '연결 오류';
  }
}

function summarizeReconnectDetail(reconnect: PvpSessionClientReconnectState): string {
  if (reconnect.scheduled && reconnect.nextReconnectAt) {
    return `${reconnect.attempt}회차 재접속 예약 · ${reconnect.nextReconnectAt}`;
  }

  if (reconnect.scheduled && reconnect.delay !== null) {
    return `${reconnect.attempt}회차 재접속 예약 · ${reconnect.delay}ms 후`;
  }

  if (reconnect.autoReconnectEnabled) {
    return '자동 재접속 대기 없음';
  }

  return '자동 재접속 꺼짐';
}

function createSessionSummary(state: PvpSessionClientState): PvpSessionScreenSessionSummary {
  const session = state.session;
  const summaryParts = [
    session.generation,
    session.rulesetKey ? `룰 ${session.rulesetKey}` : null,
    typeof session.turn === 'number' ? `${session.turn}턴` : null,
    session.yourSeat,
  ].filter((part): part is string => Boolean(part));

  return {
    roomId: session.roomId,
    battleId: session.battleId,
    turn: session.turn,
    battleStatus: session.battleStatus,
    roomStatus: session.roomStatus,
    generation: session.generation,
    rulesetKey: session.rulesetKey,
    yourSeat: session.yourSeat,
    summaryLabel: summaryParts.length > 0 ? summaryParts.join(' · ') : '세션 메타 대기 중',
    detailLabel: [
      `room ${session.roomId ?? '없음'}`,
      `battle ${session.battleId ?? '없음'}`,
      `room ${session.roomStatus ?? '없음'}`,
      `battle ${session.battleStatus ?? '없음'}`,
    ].join(' · '),
    lastEventType: session.lastEventType,
    lastEventAt: session.lastEventAt,
    lastEventLabel: session.lastEventType
      ? `마지막 이벤트 ${session.lastEventType} · ${session.lastEventAt ?? '시각 없음'}`
      : '마지막 이벤트 없음',
  };
}

function resolveScreenStatus(view: {
  state: PvpSessionClientState;
  transport: PvpSessionScreenTransportSummary;
  actionRequest: PvpActionRequestView | null;
  commandStatus: PvpCommandStatusView | null;
  turnResult: PvpTurnResultView | null;
}): { status: PvpSessionScreenStatus; statusLabel: string; detailLabel: string | null; terminal: boolean } {
  const battleStatus = view.state.session.battleStatus;

  if (battleStatus === 'finished' || battleStatus === 'abandoned' || view.state.session.terminalResult) {
    return {
      status: 'terminal',
      statusLabel: '전투 종료',
      detailLabel: view.turnResult?.summary.terminalResultLabel ?? '최종 결과가 확정되었습니다.',
      terminal: true,
    };
  }

  if (view.state.transportStatus === 'reconnecting') {
    return {
      status: 'reconnecting',
      statusLabel: '재접속 중',
      detailLabel: view.transport.detailLabel,
      terminal: false,
    };
  }

  if (view.actionRequest?.canInteract) {
    return {
      status: 'awaiting_input',
      statusLabel: '행동 선택 가능',
      detailLabel: view.actionRequest.prompt,
      terminal: false,
    };
  }

  if (view.commandStatus?.submissionState === 'accepted') {
    return {
      status: 'command_locked',
      statusLabel: '명령 제출 완료',
      detailLabel: view.commandStatus.detailLabel,
      terminal: false,
    };
  }

  if (view.commandStatus?.submissionState === 'created') {
    return {
      status: 'command_locked',
      statusLabel: '명령 전송 중',
      detailLabel: view.commandStatus.detailLabel,
      terminal: false,
    };
  }

  if (view.state.transportStatus === 'idle' || view.state.transportStatus === 'connecting' || view.state.transportStatus === 'closed' || view.state.transportStatus === 'error') {
    return {
      status: 'transport_wait',
      statusLabel: summarizeTransportStatus(view.state.transportStatus),
      detailLabel: view.transport.detailLabel,
      terminal: false,
    };
  }

  return {
    status: 'idle',
    statusLabel: '세션 대기 중',
    detailLabel: null,
    terminal: false,
  };
}

export function createPvpSessionScreenView(
  state: PvpSessionClientState | null,
  payload: PvpTurnResolvedPayloadLike | null = null,
): PvpSessionScreenView | null {
  if (!state) {
    return null;
  }

  const transport = createTransportSummary(state);
  const session = createSessionSummary(state);
  const actionRequest = createPvpActionRequestView(state);
  const commandStatus = createPvpCommandStatusView(state);
  const turnResult = createPvpTurnResultView(state, payload);
  const hasRenderableContent = actionRequest !== null || turnResult !== null;
  const status = resolveScreenStatus({
    state,
    transport,
    actionRequest,
    commandStatus,
    turnResult,
  });

  return {
    source: 'session',
    status: status.status,
    statusLabel: status.statusLabel,
    detailLabel: status.detailLabel,
    emptyStateLabel: hasRenderableContent ? null : '아직 표시할 배틀 요청이나 결과가 없습니다.',
    terminal: status.terminal,
    hasPendingRequest: state.hasPendingRequest,
    hasTurnResult: turnResult !== null,
    hasRenderableContent,
    transport,
    session,
    actionRequest,
    commandStatus,
    turnResult,
  };
}
