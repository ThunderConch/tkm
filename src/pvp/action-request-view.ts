import type { BattleCommand, VisibleBenchPokemon, VisibleMoveOption } from '../server/battle/index.js';
import type { PvpSessionClientState } from './session-client.js';
import type { PendingActionRequest, PendingReplacementRequest, PvpPendingRequest } from './session-store.js';

export interface PvpActionRequestMenuEntry {
  key: string;
  kind: 'move' | 'switch' | 'replacement' | 'forfeit';
  label: string;
  detail: string | null;
  inputToken: string;
  enabled: boolean;
  disabledReason: string | null;
  command: BattleCommand;
}

export interface PvpActionRequestMenuSection {
  id: 'moves' | 'switches' | 'replacements' | 'system';
  title: string;
  entries: PvpActionRequestMenuEntry[];
}

export interface PvpActionRequestView {
  requestKind: PvpPendingRequest['kind'];
  turn: number;
  phase: PvpPendingRequest['phase'];
  requestId: string | null;
  title: string;
  prompt: string;
  statusLabel: string;
  activePokemonLabel: string | null;
  commandSubmitted: boolean;
  locked: boolean;
  canInteract: boolean;
  sections: PvpActionRequestMenuSection[];
}

export interface CreatePvpActionRequestViewOptions {
  canInteract?: boolean;
  commandSubmitted?: boolean;
  pendingCommand?: boolean;
}

function formatPokemonName(pokemon: { speciesId: string; nickname?: string }): string {
  return pokemon.nickname ? `${pokemon.nickname} (${pokemon.speciesId})` : pokemon.speciesId;
}

function formatActivePokemonLabel(request: PendingActionRequest): string | null {
  const activePokemon = request.activePokemon;
  if (!activePokemon) {
    return null;
  }

  const parts = [
    formatPokemonName(activePokemon),
    `Lv.${activePokemon.levelEffective} (actual ${activePokemon.levelActual})`,
    `HP ${activePokemon.hp}/${activePokemon.hpMax}`,
  ];

  if (activePokemon.status) {
    parts.push(`status: ${activePokemon.status}`);
  }

  return parts.join(' · ');
}

function formatMoveDetail(move: VisibleMoveOption): string | null {
  if (typeof move.currentPp === 'number') {
    return `PP ${move.currentPp}`;
  }

  return null;
}

function formatBenchDetail(slot: VisibleBenchPokemon): string {
  return slot.fainted ? '기절' : `슬롯 ${slot.slot}`;
}

function resolveDisabledReason(options: { canInteract: boolean; unavailableReason?: string | null; intrinsicDisabled?: string | null }): string | null {
  if (!options.canInteract) {
    return options.unavailableReason ?? '현재 선택 불가';
  }

  return options.intrinsicDisabled ?? null;
}

function buildMoveEntries(request: PendingActionRequest, canInteract: boolean, unavailableReason: string | null): PvpActionRequestMenuEntry[] {
  return [...(request.availableMoves ?? [])]
    .sort((left, right) => left.slot - right.slot)
    .map((move) => {
      const intrinsicDisabled = move.disabled ? '사용할 수 없는 기술' : null;
      const enabled = canInteract && intrinsicDisabled === null;

      return {
        key: `move:${move.slot}`,
        kind: 'move',
        label: `${move.slot}. ${move.id}`,
        detail: formatMoveDetail(move),
        inputToken: String(move.slot),
        enabled,
        disabledReason: resolveDisabledReason({ canInteract, unavailableReason, intrinsicDisabled }),
        command: {
          type: 'choose_move',
          moveSlot: move.slot,
        },
      };
    });
}

function buildSwitchEntries(
  request: PendingActionRequest,
  canInteract: boolean,
  unavailableReason: string | null,
): PvpActionRequestMenuEntry[] {
  return [...(request.availableSwitches ?? [])]
    .sort((left, right) => left.slot - right.slot)
    .map((slot) => {
      const intrinsicDisabled = slot.fainted ? '기절한 포켓몬은 교체할 수 없음' : null;
      const enabled = canInteract && intrinsicDisabled === null;

      return {
        key: `switch:${slot.slot}`,
        kind: 'switch',
        label: formatPokemonName(slot),
        detail: formatBenchDetail(slot),
        inputToken: `switch:${slot.slot}`,
        enabled,
        disabledReason: resolveDisabledReason({ canInteract, unavailableReason, intrinsicDisabled }),
        command: {
          type: 'choose_switch',
          targetSlot: slot.slot,
        },
      };
    });
}

function buildReplacementEntries(
  request: PendingReplacementRequest,
  canInteract: boolean,
  unavailableReason: string | null,
): PvpActionRequestMenuEntry[] {
  return [...(request.availableReplacements ?? [])]
    .sort((left, right) => left.slot - right.slot)
    .map((slot) => {
      const intrinsicDisabled = slot.fainted ? '기절한 포켓몬은 교체할 수 없음' : null;
      const enabled = canInteract && intrinsicDisabled === null;

      return {
        key: `replacement:${slot.slot}`,
        kind: 'replacement',
        label: formatPokemonName(slot),
        detail: formatBenchDetail(slot),
        inputToken: `replace:${slot.slot}`,
        enabled,
        disabledReason: resolveDisabledReason({ canInteract, unavailableReason, intrinsicDisabled }),
        command: {
          type: 'choose_replacement',
          targetSlot: slot.slot,
        },
      };
    });
}

function buildSystemEntries(canInteract: boolean, unavailableReason: string | null): PvpActionRequestMenuEntry[] {
  return [
    {
      key: 'forfeit',
      kind: 'forfeit',
      label: '항복',
      detail: '즉시 패배 처리',
      inputToken: 'forfeit',
      enabled: canInteract,
      disabledReason: canInteract ? null : (unavailableReason ?? '현재 선택 불가'),
      command: {
        type: 'forfeit',
      },
    },
  ];
}

function pushSection(
  sections: PvpActionRequestMenuSection[],
  id: PvpActionRequestMenuSection['id'],
  title: string,
  entries: PvpActionRequestMenuEntry[],
): void {
  if (entries.length === 0) {
    return;
  }

  sections.push({ id, title, entries });
}

function resolveViewAvailability(options: Required<CreatePvpActionRequestViewOptions>): {
  commandSubmitted: boolean;
  locked: boolean;
  canInteract: boolean;
  statusLabel: string;
  unavailableReason: string | null;
} {
  const commandSubmitted = options.commandSubmitted;
  const locked = commandSubmitted || options.pendingCommand;
  const canInteract = options.canInteract && !locked;

  if (commandSubmitted) {
    return {
      commandSubmitted,
      locked,
      canInteract,
      statusLabel: '이미 제출됨',
      unavailableReason: '이미 제출됨',
    };
  }

  if (options.pendingCommand) {
    return {
      commandSubmitted,
      locked,
      canInteract,
      statusLabel: '서버 확인 대기 중',
      unavailableReason: '서버 확인 대기 중',
    };
  }

  if (canInteract) {
    return {
      commandSubmitted,
      locked,
      canInteract,
      statusLabel: '선택 가능',
      unavailableReason: null,
    };
  }

  return {
    commandSubmitted,
    locked,
    canInteract,
    statusLabel: '현재 선택 불가',
    unavailableReason: '현재 선택 불가',
  };
}

export function createPvpActionRequestViewFromPendingRequest(
  request: PvpPendingRequest | null,
  options: CreatePvpActionRequestViewOptions = {},
): PvpActionRequestView | null {
  if (!request) {
    return null;
  }

  const availability = resolveViewAvailability({
    canInteract: options.canInteract ?? true,
    commandSubmitted: options.commandSubmitted ?? request.commandSubmitted,
    pendingCommand: options.pendingCommand ?? false,
  });

  const sections: PvpActionRequestMenuSection[] = [];

  if (request.kind === 'choose_move_or_switch') {
    pushSection(sections, 'moves', '기술', buildMoveEntries(request, availability.canInteract, availability.unavailableReason));
    pushSection(sections, 'switches', '교체', buildSwitchEntries(request, availability.canInteract, availability.unavailableReason));
    pushSection(sections, 'system', '시스템', buildSystemEntries(availability.canInteract, availability.unavailableReason));

    return {
      requestKind: request.kind,
      turn: request.turn,
      phase: request.phase,
      requestId: request.requestId,
      title: `${formatPokemonName(request.activePokemon ?? { speciesId: 'UNKNOWN' })} 행동 선택`,
      prompt: '기술을 쓰거나 교체할 포켓몬을 선택하세요.',
      statusLabel: availability.statusLabel,
      activePokemonLabel: formatActivePokemonLabel(request),
      commandSubmitted: availability.commandSubmitted,
      locked: availability.locked,
      canInteract: availability.canInteract,
      sections,
    };
  }

  pushSection(
    sections,
    'replacements',
    '교체 후보',
    buildReplacementEntries(request, availability.canInteract, availability.unavailableReason),
  );
  pushSection(sections, 'system', '시스템', buildSystemEntries(availability.canInteract, availability.unavailableReason));

  return {
    requestKind: request.kind,
    turn: request.turn,
    phase: request.phase,
    requestId: request.requestId,
    title: '교체 포켓몬 선택',
    prompt: request.faintedSlot === null
      ? '교체 포켓몬을 선택하세요.'
      : `${request.faintedSlot}번 슬롯이 기절했습니다. 교체 포켓몬을 선택하세요.`,
    statusLabel: availability.statusLabel,
    activePokemonLabel: null,
    commandSubmitted: availability.commandSubmitted,
    locked: availability.locked,
    canInteract: availability.canInteract,
    sections,
  };
}

export function createPvpActionRequestView(
  state: Pick<PvpSessionClientState, 'session' | 'canSendCommand'>,
): PvpActionRequestView | null {
  return createPvpActionRequestViewFromPendingRequest(state.session.pendingRequest, {
    canInteract: state.canSendCommand,
    commandSubmitted: state.session.pendingRequest?.commandSubmitted ?? false,
    pendingCommand: state.session.pendingCommand !== null,
  });
}
