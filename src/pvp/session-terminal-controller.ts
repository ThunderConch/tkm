import type { BattleCommand } from '../server/battle/index.js';
import {
  createPvpActionRequestView,
  type PvpActionRequestMenuEntry,
  type PvpActionRequestMenuSection,
  type PvpActionRequestView,
} from './action-request-view.js';
import {
  renderPvpSessionClientScreen,
} from './session-screen-renderer.js';
import type {
  PvpSessionClient,
  PvpSessionClientState,
  SendPvpSessionBattleCommandResult,
} from './session-client.js';
import type { CreateBattleCommandEnvelopeOptions } from './session-store.js';
import type { PvpTurnResolvedPayloadLike } from './turn-result-view.js';

export interface PvpSessionTerminalInputEntry {
  section: Pick<PvpActionRequestMenuSection, 'id' | 'title'>;
  key: string;
  kind: PvpActionRequestMenuEntry['kind'];
  label: string;
  detail: string | null;
  inputToken: string;
  enabled: boolean;
  disabledReason: string | null;
  command: BattleCommand;
}

export interface PvpSessionTerminalSnapshot {
  state: PvpSessionClientState | null;
  screen: string;
  actionRequest: PvpActionRequestView | null;
  inputEntries: PvpSessionTerminalInputEntry[];
  availableInputTokens: string[];
}

export interface PvpSessionTerminalResolvedInputTokenResult {
  status: 'resolved';
  token: string;
  command: BattleCommand;
  entry: PvpSessionTerminalInputEntry;
  snapshot: PvpSessionTerminalSnapshot;
}

export interface PvpSessionTerminalInputTokenFailureResult {
  status: 'invalid_token' | 'no_request' | 'locked' | 'transport_not_ready';
  token: string;
  message: string;
  snapshot: PvpSessionTerminalSnapshot;
}

export type PvpSessionTerminalInputTokenResult =
  | PvpSessionTerminalResolvedInputTokenResult
  | PvpSessionTerminalInputTokenFailureResult;

export interface PvpSessionTerminalSubmitSuccessResult {
  status: 'submitted';
  token: string;
  command: BattleCommand;
  entry: PvpSessionTerminalInputEntry;
  snapshot: PvpSessionTerminalSnapshot;
  sendOptions: CreateBattleCommandEnvelopeOptions;
  sendResult: SendPvpSessionBattleCommandResult;
}

export interface PvpSessionTerminalSubmitFailureResult {
  status: PvpSessionTerminalInputTokenFailureResult['status'] | 'unavailable';
  token: string;
  message: string;
  snapshot: PvpSessionTerminalSnapshot;
  cause?: unknown;
}

export type PvpSessionTerminalSubmitResult =
  | PvpSessionTerminalSubmitSuccessResult
  | PvpSessionTerminalSubmitFailureResult;

export interface PvpSessionTerminalClient {
  getState(): PvpSessionClientState;
  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendPvpSessionBattleCommandResult;
}

export interface CreatePvpSessionTerminalControllerOptions {
  sessionClient: PvpSessionTerminalClientLike;
  now?: () => Date;
  createClientCommandId?: (state: PvpSessionClientState, command: BattleCommand) => string;
}

function toTerminalInputEntry(
  section: PvpActionRequestMenuSection,
  entry: PvpActionRequestMenuEntry,
): PvpSessionTerminalInputEntry {
  return {
    section: {
      id: section.id,
      title: section.title,
    },
    key: entry.key,
    kind: entry.kind,
    label: entry.label,
    detail: entry.detail,
    inputToken: entry.inputToken,
    enabled: entry.enabled,
    disabledReason: entry.disabledReason,
    command: structuredClone(entry.command),
  };
}

function createInputEntries(actionRequest: PvpActionRequestView | null): PvpSessionTerminalInputEntry[] {
  if (!actionRequest) {
    return [];
  }

  return actionRequest.sections.flatMap((section) => section.entries.map((entry) => toTerminalInputEntry(section, entry)));
}

function createAvailableInputTokens(entries: PvpSessionTerminalInputEntry[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const entry of entries) {
    if (!entry.enabled || seen.has(entry.inputToken)) {
      continue;
    }

    seen.add(entry.inputToken);
    tokens.push(entry.inputToken);
  }

  return tokens;
}

function normalizeInputToken(token: string): string {
  return token.trim();
}

function defaultClientCommandId(state: PvpSessionClientState, command: BattleCommand): string {
  const battleId = state.session.battleId ?? 'battle';
  const request = state.session.pendingRequest;
  const requestKey = request?.requestId ?? request?.kind ?? 'request';
  const commandKey = command.type === 'forfeit'
    ? 'forfeit'
    : command.type === 'choose_move'
      ? `move-${command.moveSlot}`
      : `slot-${command.targetSlot}`;

  return `terminal-${battleId}-${requestKey}-${state.session.nextClientSeq}-${commandKey}`;
}

function createFailureResult(
  status: PvpSessionTerminalInputTokenFailureResult['status'],
  token: string,
  message: string,
  snapshot: PvpSessionTerminalSnapshot,
): PvpSessionTerminalInputTokenFailureResult {
  return {
    status,
    token,
    message,
    snapshot,
  };
}

export function createPvpSessionTerminalSnapshot(
  state: PvpSessionClientState | null,
  payloadOverride: PvpTurnResolvedPayloadLike | null = null,
): PvpSessionTerminalSnapshot {
  const actionRequest = state ? createPvpActionRequestView(state) : null;
  const inputEntries = createInputEntries(actionRequest);

  return {
    state: state ? structuredClone(state) : null,
    screen: renderPvpSessionClientScreen(state, payloadOverride),
    actionRequest,
    inputEntries,
    availableInputTokens: createAvailableInputTokens(inputEntries),
  };
}

export function resolvePvpSessionTerminalInputToken(
  state: PvpSessionClientState | null,
  token: string,
  payloadOverride: PvpTurnResolvedPayloadLike | null = null,
): PvpSessionTerminalInputTokenResult {
  const normalizedToken = normalizeInputToken(token);
  const snapshot = createPvpSessionTerminalSnapshot(state, payloadOverride);

  if (!snapshot.actionRequest) {
    return createFailureResult('no_request', normalizedToken, '현재 처리할 배틀 요청이 없습니다.', snapshot);
  }

  if (state?.transportStatus !== 'connected') {
    return createFailureResult('transport_not_ready', normalizedToken, '실시간 전송 연결이 아직 준비되지 않았습니다.', snapshot);
  }

  if (!snapshot.actionRequest.canInteract || snapshot.actionRequest.locked) {
    return createFailureResult('locked', normalizedToken, '현재 요청은 잠겨 있어 명령을 제출할 수 없습니다.', snapshot);
  }

  const entry = snapshot.inputEntries.find((candidate) => candidate.enabled && candidate.inputToken === normalizedToken);
  if (!entry) {
    return createFailureResult('invalid_token', normalizedToken, '현재 요청에서 사용할 수 없는 입력 토큰입니다.', snapshot);
  }

  return {
    status: 'resolved',
    token: normalizedToken,
    command: structuredClone(entry.command),
    entry,
    snapshot,
  };
}

export class PvpSessionTerminalController {
  private readonly sessionClient: PvpSessionTerminalClient;

  private readonly now: () => Date;

  private readonly createClientCommandId: (state: PvpSessionClientState, command: BattleCommand) => string;

  constructor(options: CreatePvpSessionTerminalControllerOptions) {
    this.sessionClient = options.sessionClient;
    this.now = options.now ?? (() => new Date());
    this.createClientCommandId = options.createClientCommandId ?? defaultClientCommandId;
  }

  getSnapshot(payloadOverride: PvpTurnResolvedPayloadLike | null = null): PvpSessionTerminalSnapshot {
    return createPvpSessionTerminalSnapshot(this.sessionClient.getState(), payloadOverride);
  }

  resolveInputToken(token: string, payloadOverride: PvpTurnResolvedPayloadLike | null = null): PvpSessionTerminalInputTokenResult {
    return resolvePvpSessionTerminalInputToken(this.sessionClient.getState(), token, payloadOverride);
  }

  submitInputToken(token: string): PvpSessionTerminalSubmitResult {
    const state = this.sessionClient.getState();
    const resolved = resolvePvpSessionTerminalInputToken(state, token);
    if (resolved.status !== 'resolved') {
      return resolved;
    }

    const sendOptions: CreateBattleCommandEnvelopeOptions = {
      clientCommandId: this.createClientCommandId(state, resolved.command),
      sentAt: this.now().toISOString(),
      command: structuredClone(resolved.command),
    };

    try {
      const sendResult = this.sessionClient.sendBattleCommand(sendOptions);
      return {
        status: 'submitted',
        token: resolved.token,
        command: structuredClone(resolved.command),
        entry: resolved.entry,
        snapshot: resolved.snapshot,
        sendOptions,
        sendResult,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        token: resolved.token,
        message: error instanceof Error ? error.message : '명령 전송 중 알 수 없는 오류가 발생했습니다.',
        snapshot: resolved.snapshot,
        cause: error,
      };
    }
  }
}

export function createPvpSessionTerminalController(
  options: CreatePvpSessionTerminalControllerOptions,
): PvpSessionTerminalController {
  return new PvpSessionTerminalController(options);
}

export type PvpSessionTerminalClientLike = Pick<PvpSessionClient, 'getState' | 'sendBattleCommand'>;
export type PvpSessionTerminalControllerLike = Pick<PvpSessionTerminalController, 'getSnapshot' | 'resolveInputToken' | 'submitInputToken'>;
