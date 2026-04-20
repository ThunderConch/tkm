import {
  createPvpSessionScreenView,
  type PvpSessionScreenView,
} from './session-screen-view.js';
import type { PvpSessionClientState } from './session-client.js';
import type { PvpTurnResolvedPayloadLike } from './turn-result-view.js';
import type {
  PvpActionRequestMenuEntry,
  PvpActionRequestMenuSection,
  PvpActionRequestView,
} from './action-request-view.js';
import type { PvpCommandStatusView } from './command-status-view.js';
import type { PvpTurnResultLogEntry, PvpTurnResultView } from './turn-result-view.js';

function renderHeader(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '=== PvP Session Screen ===',
      '상태: 세션 없음',
    ];
  }

  const lines = [
    '=== PvP Session Screen ===',
    `상태: ${view.statusLabel}`,
  ];

  if (view.detailLabel) {
    lines.push(`- 상세: ${view.detailLabel}`);
  }

  return lines;
}

function renderTransportSection(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '[transport]',
      '- 상태: 세션 없음',
      '- 상세: 세션 스냅샷이 아직 없습니다.',
    ];
  }

  return [
    '[transport]',
    `- 상태: ${view.transport.summaryLabel}`,
    `- 상세: ${view.transport.detailLabel ?? '추가 상세 없음'}`,
    `- 재접속: ${view.transport.reconnectLabel}`,
  ];
}

function renderSessionSection(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '[session]',
      '- 요약: 세션 스냅샷이 아직 없습니다.',
    ];
  }

  return [
    '[session]',
    `- 요약: ${view.session.summaryLabel}`,
    `- 상세: ${view.session.detailLabel}`,
    `- 마지막 이벤트: ${view.session.lastEventLabel}`,
  ];
}

function renderActionRequestSection(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '[action-request]',
      '- 대기 중인 행동 요청이 없습니다.',
    ];
  }

  if (!view.actionRequest) {
    return [
      '[action-request]',
      `- ${view.emptyStateLabel ?? '대기 중인 행동 요청이 없습니다.'}`,
    ];
  }

  return [
    '[action-request]',
    ...renderActionRequest(view.actionRequest),
  ];
}

function renderActionRequest(actionRequest: PvpActionRequestView): string[] {
  const lines = [
    `- 제목: ${actionRequest.title}`,
    `- 프롬프트: ${actionRequest.prompt}`,
    `- 상태: ${actionRequest.statusLabel}`,
    `- 입력 가능: ${actionRequest.canInteract ? '예' : '아니오'}`,
  ];

  if (actionRequest.activePokemonLabel) {
    lines.push(`- 활성 포켓몬: ${actionRequest.activePokemonLabel}`);
  }

  for (const section of actionRequest.sections) {
    lines.push(...renderActionRequestSectionEntries(section));
  }

  return lines;
}

function renderActionRequestSectionEntries(section: PvpActionRequestMenuSection): string[] {
  const lines = [`- 섹션: ${section.title}`];

  for (const entry of section.entries) {
    lines.push(renderActionRequestEntry(entry));
  }

  return lines;
}

function renderActionRequestEntry(entry: PvpActionRequestMenuEntry): string {
  const parts = [
    `  * [${entry.enabled ? '가능' : '잠김'}] ${entry.label}`,
    `token=${entry.inputToken}`,
  ];

  if (entry.detail) {
    parts.push(entry.detail);
  }

  if (!entry.enabled && entry.disabledReason) {
    parts.push(`사유 ${entry.disabledReason}`);
  }

  return parts.join(' | ');
}

function renderCommandStatusSection(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '[command-status]',
      '- 제출 상태를 표시할 세션이 없습니다.',
    ];
  }

  if (!view.commandStatus) {
    return [
      '[command-status]',
      '- 제출 상태를 계산할 수 없습니다.',
    ];
  }

  return [
    '[command-status]',
    ...renderCommandStatus(view.commandStatus),
  ];
}

function renderCommandStatus(commandStatus: PvpCommandStatusView): string[] {
  const lines = [
    `- 상태: ${commandStatus.statusLabel}`,
    `- 상세: ${commandStatus.detailLabel ?? '추가 상세 없음'}`,
    `- 제출 상태: ${commandStatus.submissionState}`,
    `- 상호작용: ${commandStatus.canInteract ? '가능' : '잠김'}`,
    `- 관계 요약: ${commandStatus.relationSummary}`,
  ];

  if (commandStatus.commandSummary) {
    lines.push(`- 명령: ${commandStatus.commandSummary}`);
  }

  if (commandStatus.rejection) {
    lines.push(`- 거부: ${commandStatus.rejection.summary}`);
  }

  return lines;
}

function renderTurnResultSection(view: PvpSessionScreenView | null): string[] {
  if (!view) {
    return [
      '[turn-result]',
      '- 표시할 턴 결과가 없습니다.',
    ];
  }

  if (!view.turnResult) {
    return [
      '[turn-result]',
      `- ${view.emptyStateLabel ?? '표시할 턴 결과가 없습니다.'}`,
    ];
  }

  return [
    '[turn-result]',
    ...renderTurnResult(view.turnResult),
  ];
}

function renderTurnResult(turnResult: PvpTurnResultView): string[] {
  const lines = [
    `- 제목: ${turnResult.title}`,
    `- 상태: ${turnResult.summary.statusLabel}`,
    `- 다음 단계: ${turnResult.summary.nextPhaseLabel}`,
    `- 내 포켓몬: ${turnResult.summary.self.activeLabel ?? '공개된 활성 포켓몬 없음'}`,
    `- 내 벤치: ${turnResult.summary.self.benchLabel}`,
    `- 상대 포켓몬: ${turnResult.summary.opponent.activeLabel ?? '공개된 활성 포켓몬 없음'}`,
    `- 상대 벤치: ${turnResult.summary.opponent.benchLabel}`,
  ];

  if (turnResult.summary.terminalResultLabel) {
    lines.push(`- 종료: ${turnResult.summary.terminalResultLabel}`);
  }

  if (turnResult.logs.length === 0) {
    lines.push('- 로그: 표시할 턴 이벤트가 없습니다.');
    return lines;
  }

  for (const log of turnResult.logs) {
    lines.push(renderTurnResultLog(log));
  }

  return lines;
}

function renderTurnResultLog(log: PvpTurnResultLogEntry): string {
  return `  * ${log.title}: ${log.message}`;
}

export function renderPvpSessionScreen(view: PvpSessionScreenView | null): string {
  return [
    ...renderHeader(view),
    '',
    ...renderTransportSection(view),
    '',
    ...renderSessionSection(view),
    '',
    ...renderActionRequestSection(view),
    '',
    ...renderCommandStatusSection(view),
    '',
    ...renderTurnResultSection(view),
  ].join('\n');
}

export function renderPvpSessionClientScreen(
  state: PvpSessionClientState | null,
  payloadOverride: PvpTurnResolvedPayloadLike | null = null,
): string {
  return renderPvpSessionScreen(createPvpSessionScreenView(state, payloadOverride));
}
