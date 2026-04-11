import type {
  BattleEndedPayload,
  BattleSessionPhase,
  BattleTurnResolvedPayload,
  ProjectedBattleEvent,
  ViewerVisibleState,
  VisibleBenchPokemon,
} from '../server/battle/index.js';
import type { PvpSessionClientState } from './session-client.js';

export interface PvpHealAppliedEvent {
  eventType: 'heal_applied';
  target: 'self' | 'opponent';
  targetSlot: number;
  targetSpeciesId: string;
  hp: number;
  hpMax: number;
  heal: number;
}

export type PvpTurnResultEvent = ProjectedBattleEvent | PvpHealAppliedEvent;

export interface PvpTurnResolvedPayloadLike
  extends Omit<BattleTurnResolvedPayload, 'events'> {
  events: PvpTurnResultEvent[];
}

export interface PvpTurnResultLogEntry {
  key: string;
  eventType: PvpTurnResultEvent['eventType'];
  title: string;
  message: string;
  emphasis: 'neutral' | 'positive' | 'negative' | 'terminal';
}

export interface PvpTurnResultBenchEntry {
  slot: number;
  label: string;
  fainted: boolean;
}

export interface PvpTurnResultSideSummary {
  activeLabel: string | null;
  benchLabel: string;
  remainingBenchCount: number;
  faintedBenchCount: number | null;
  benchEntries: PvpTurnResultBenchEntry[];
}

export interface PvpTurnResultSummary {
  self: PvpTurnResultSideSummary;
  opponent: PvpTurnResultSideSummary;
  nextPhase: BattleTurnResolvedPayload['nextPhase'];
  nextPhaseLabel: string;
  statusLabel: string;
  terminalResultLabel: string | null;
}

export interface PvpTurnResultView {
  source: 'payload' | 'session';
  turn: number;
  title: string;
  eventCount: number;
  hasEventLog: boolean;
  logs: PvpTurnResultLogEntry[];
  summary: PvpTurnResultSummary;
}

type PvpTurnResultSessionSlice = Pick<PvpSessionClientState, 'session'>;

function formatPokemonName(pokemon: { speciesId: string; nickname?: string }): string {
  return pokemon.nickname ? `${pokemon.nickname} (${pokemon.speciesId})` : pokemon.speciesId;
}

function localizeStatus(status: string | null): string | null {
  switch (status) {
    case 'poison':
      return '독';
    case 'badly_poisoned':
    case 'toxic':
      return '맹독';
    case 'burn':
      return '화상';
    case 'paralysis':
      return '마비';
    case 'sleep':
      return '잠듦';
    case 'freeze':
      return '얼음';
    default:
      return status;
  }
}

function formatStatusLabel(status: string | null): string | null {
  const localizedStatus = localizeStatus(status);
  return localizedStatus ? `상태 ${localizedStatus}` : null;
}

function formatActiveLabel(pokemon: ViewerVisibleState['self']['active'] | null | undefined): string | null {
  if (!pokemon) {
    return null;
  }

  const parts = [
    formatPokemonName(pokemon),
    `슬롯 ${pokemon.slot}`,
    `Lv.${pokemon.levelEffective} (실레벨 ${pokemon.levelActual})`,
    `HP ${pokemon.hp}/${pokemon.hpMax}`,
  ];

  const statusLabel = formatStatusLabel(pokemon.status);
  if (statusLabel) {
    parts.push(statusLabel);
  }

  if (pokemon.fainted) {
    parts.push('기절');
  }

  return parts.join(' · ');
}

function formatBenchEntryLabel(pokemon: VisibleBenchPokemon): string {
  return `${formatPokemonName(pokemon)} · 슬롯 ${pokemon.slot} · ${pokemon.fainted ? '기절' : '대기'}`;
}

function formatSelfBenchLabel(bench: VisibleBenchPokemon[]): string {
  const remaining = bench.filter((pokemon) => !pokemon.fainted).length;
  const fainted = bench.length - remaining;

  if (bench.length === 0) {
    return '벤치 없음';
  }

  return `벤치 ${bench.length}마리 · 출전 가능 ${remaining} · 기절 ${fainted}`;
}

function formatOpponentBenchLabel(benchCount: number): string {
  if (benchCount === 0) {
    return '상대 벤치 없음';
  }

  return `상대 벤치 ${benchCount}칸 비공개`;
}

function sideLabel(side: 'self' | 'opponent'): string {
  return side === 'self' ? '내' : '상대';
}

function resolveNextPhaseLabel(nextPhase: BattleTurnResolvedPayload['nextPhase']): string {
  switch (nextPhase) {
    case 'awaiting_actions':
      return '다음 행동 선택';
    case 'awaiting_replacement':
      return '교체 포켓몬 선택';
    case 'finished':
      return '배틀 종료';
  }
}

function resolveStatusLabel(nextPhase: BattleTurnResolvedPayload['nextPhase']): string {
  switch (nextPhase) {
    case 'awaiting_actions':
      return '다음 턴 진행 가능';
    case 'awaiting_replacement':
      return '교체 필요';
    case 'finished':
      return '전투 종료';
  }
}

function resolveTerminalResultLabel(terminalResult: BattleEndedPayload | null | undefined): string | null {
  if (!terminalResult) {
    return null;
  }

  const resultLabel = terminalResult.result === 'win' ? '승리' : '패배';
  return `${resultLabel} · 종료 사유 ${terminalResult.reason}`;
}

function createSummary(
  visibleState: ViewerVisibleState,
  nextPhase: BattleTurnResolvedPayload['nextPhase'],
  terminalResult: BattleEndedPayload | null | undefined,
): PvpTurnResultSummary {
  const selfBenchEntries = visibleState.self.bench.map((pokemon) => ({
    slot: pokemon.slot,
    label: formatBenchEntryLabel(pokemon),
    fainted: pokemon.fainted,
  }));
  const remainingSelfBenchCount = visibleState.self.bench.filter((pokemon) => !pokemon.fainted).length;
  const faintedSelfBenchCount = visibleState.self.bench.length - remainingSelfBenchCount;

  return {
    self: {
      activeLabel: formatActiveLabel(visibleState.self.active),
      benchLabel: formatSelfBenchLabel(visibleState.self.bench),
      remainingBenchCount: remainingSelfBenchCount,
      faintedBenchCount: faintedSelfBenchCount,
      benchEntries: selfBenchEntries,
    },
    opponent: {
      activeLabel: formatActiveLabel(visibleState.opponent.active),
      benchLabel: formatOpponentBenchLabel(visibleState.opponent.benchCount),
      remainingBenchCount: visibleState.opponent.benchCount,
      faintedBenchCount: null,
      benchEntries: [],
    },
    nextPhase,
    nextPhaseLabel: resolveNextPhaseLabel(nextPhase),
    statusLabel: resolveStatusLabel(nextPhase),
    terminalResultLabel: resolveTerminalResultLabel(terminalResult),
  };
}

function createMoveMessage(event: Extract<PvpTurnResultEvent, { eventType: 'move_used' }>): PvpTurnResultLogEntry {
  return {
    key: `move:${event.actor}:${event.actorSlot}:${event.moveSlot}:${event.moveId}`,
    eventType: event.eventType,
    title: '기술 사용',
    message: `${sideLabel(event.actor)} ${event.actorSpeciesId} (슬롯 ${event.actorSlot})이(가) ${event.moveId} 사용`,
    emphasis: 'neutral',
  };
}

function createSwitchMessage(event: Extract<PvpTurnResultEvent, { eventType: 'switch_used' }>): PvpTurnResultLogEntry {
  const movement = event.fromSlot === null ? `슬롯 ${event.toSlot} 출전` : `슬롯 ${event.fromSlot} → ${event.toSlot} 교체`;

  return {
    key: `switch:${event.actor}:${event.fromSlot ?? 'none'}:${event.toSlot}`,
    eventType: event.eventType,
    title: '교체',
    message: `${sideLabel(event.actor)} ${event.speciesId} · ${movement}`,
    emphasis: 'neutral',
  };
}

function createDamageMessage(event: Extract<PvpTurnResultEvent, { eventType: 'damage_applied' }>): PvpTurnResultLogEntry {
  return {
    key: `damage:${event.target}:${event.targetSlot}:${event.damage}:${event.hp}`,
    eventType: event.eventType,
    title: '피해',
    message: `${sideLabel(event.target)} ${event.targetSpeciesId} (슬롯 ${event.targetSlot}) HP ${event.hp}/${event.hpMax} (-${event.damage})${event.fainted ? ' · 기절' : ''}`,
    emphasis: event.target === 'opponent' ? 'positive' : 'negative',
  };
}

function createHealMessage(event: Extract<PvpTurnResultEvent, { eventType: 'heal_applied' }>): PvpTurnResultLogEntry {
  return {
    key: `heal:${event.target}:${event.targetSlot}:${event.heal}:${event.hp}`,
    eventType: event.eventType,
    title: '회복',
    message: `${sideLabel(event.target)} ${event.targetSpeciesId} (슬롯 ${event.targetSlot}) HP ${event.hp}/${event.hpMax} (+${event.heal})`,
    emphasis: event.target === 'self' ? 'positive' : 'negative',
  };
}

function createStatusMessage(event: Extract<PvpTurnResultEvent, { eventType: 'status_applied' }>): PvpTurnResultLogEntry {
  const localizedStatus = localizeStatus(event.status) ?? event.status;

  return {
    key: `status:${event.target}:${event.targetSlot}:${event.status}`,
    eventType: event.eventType,
    title: '상태이상',
    message: `${sideLabel(event.target)} ${event.targetSpeciesId} (슬롯 ${event.targetSlot}) 상태이상 ${localizedStatus}`,
    emphasis: event.target === 'opponent' ? 'positive' : 'negative',
  };
}

function createFaintedMessage(event: Extract<PvpTurnResultEvent, { eventType: 'pokemon_fainted' }>): PvpTurnResultLogEntry {
  return {
    key: `fainted:${event.target}:${event.targetSlot}`,
    eventType: event.eventType,
    title: '기절',
    message: `${sideLabel(event.target)} ${event.targetSpeciesId} (슬롯 ${event.targetSlot}) 기절`,
    emphasis: event.target === 'opponent' ? 'positive' : 'negative',
  };
}

function createReplacementMessage(
  event: Extract<PvpTurnResultEvent, { eventType: 'replacement_selected' }>,
): PvpTurnResultLogEntry {
  return {
    key: `replacement:${event.actor}:${event.slot}`,
    eventType: event.eventType,
    title: '교체 선택',
    message: `${sideLabel(event.actor)} ${event.speciesId} · 슬롯 ${event.slot} 선택`,
    emphasis: 'neutral',
  };
}

function createForfeitMessage(event: Extract<PvpTurnResultEvent, { eventType: 'forfeit' }>): PvpTurnResultLogEntry {
  return {
    key: `forfeit:${event.actor}`,
    eventType: event.eventType,
    title: '항복',
    message: `${sideLabel(event.actor)} 플레이어가 항복`,
    emphasis: event.actor === 'opponent' ? 'positive' : 'terminal',
  };
}

function createLogEntry(event: PvpTurnResultEvent): PvpTurnResultLogEntry {
  switch (event.eventType) {
    case 'move_used':
      return createMoveMessage(event);
    case 'switch_used':
      return createSwitchMessage(event);
    case 'damage_applied':
      return createDamageMessage(event);
    case 'heal_applied':
      return createHealMessage(event);
    case 'status_applied':
      return createStatusMessage(event);
    case 'pokemon_fainted':
      return createFaintedMessage(event);
    case 'replacement_selected':
      return createReplacementMessage(event);
    case 'forfeit':
      return createForfeitMessage(event);
  }
}

function createView(
  source: PvpTurnResultView['source'],
  turn: number,
  visibleState: ViewerVisibleState,
  nextPhase: BattleTurnResolvedPayload['nextPhase'],
  terminalResult: BattleEndedPayload | null | undefined,
  events: PvpTurnResultEvent[],
): PvpTurnResultView {
  const logs = events.map((event) => createLogEntry(event));

  return {
    source,
    turn,
    title: `턴 ${turn} 결과`,
    eventCount: logs.length,
    hasEventLog: logs.length > 0,
    logs,
    summary: createSummary(visibleState, nextPhase, terminalResult),
  };
}

export function createPvpTurnResultViewFromPayload(payload: PvpTurnResolvedPayloadLike | null): PvpTurnResultView | null {
  if (!payload) {
    return null;
  }

  return createView(
    'payload',
    payload.turn,
    payload.postTurnVisibleState,
    payload.nextPhase,
    null,
    payload.events,
  );
}

function resolveNextPhaseFromSession(phase: BattleSessionPhase | null): BattleTurnResolvedPayload['nextPhase'] | null {
  if (phase === 'awaiting_actions' || phase === 'awaiting_replacement' || phase === 'finished') {
    return phase;
  }

  return null;
}

export function createPvpTurnResultView(
  state: PvpTurnResultSessionSlice | null,
  payload: PvpTurnResolvedPayloadLike | null = null,
): PvpTurnResultView | null {
  if (!state) {
    return null;
  }

  if (payload) {
    const view = createPvpTurnResultViewFromPayload(payload);
    if (!view) {
      return null;
    }

    return {
      ...view,
      summary: createSummary(payload.postTurnVisibleState, payload.nextPhase, state.session.terminalResult),
    };
  }

  const nextPhase = resolveNextPhaseFromSession(state.session.battleStatus);
  if (state.session.lastResolvedTurn === null || !state.session.visibleState || !nextPhase) {
    return null;
  }

  return createView(
    'session',
    state.session.lastResolvedTurn,
    state.session.visibleState,
    nextPhase,
    state.session.terminalResult,
    [],
  );
}
