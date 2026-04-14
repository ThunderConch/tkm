import type {
  FogState,
  FriendlyBattleLiveBattleState,
  FriendlyBattleRole,
} from './contracts.js';
import type {
  FriendlyBattleTurnMoveOption,
  FriendlyBattleTurnPartyOption,
} from './turn-json.js';

interface RenderAiActionPromptInput {
  role: FriendlyBattleRole;
  liveState: FriendlyBattleLiveBattleState;
  fogState: FogState;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
}

interface ParseAiActionChoiceInput {
  moveCount: number;
  partyCount: number;
}

function statusLabel(fainted: boolean): string {
  return fainted ? 'fainted' : 'ok';
}

export function renderAiActionPrompt(input: RenderAiActionPromptInput): string {
  const self = input.role === 'host' ? input.liveState.host : input.liveState.guest;
  const moveLine = input.moveOptions.length > 0
    ? input.moveOptions.map((move) => `${move.index}. ${move.nameKo} (PP ${move.pp}/${move.maxPp})`).join(', ')
    : 'none';
  const benchLine = input.partyOptions.length > 0
    ? input.partyOptions.map((party) => {
        const selfParty = self.party.find((entry) => entry.index === party.index);
        const level = selfParty?.level ?? self.active.level;
        return `${party.index}. ${party.name} Lv.${level} HP:${party.hp}/${party.maxHp} ${statusLabel(party.fainted)}`;
      }).join('; ')
    : 'none';
  const seenMoves = input.fogState.opponentActive.revealedMoves.length > 0
    ? input.fogState.opponentActive.revealedMoves.join(', ')
    : 'none';
  const revealedBench = input.fogState.opponentBenchRevealed.length > 0
    ? input.fogState.opponentBenchRevealed
      .map((entry) => `${entry.species} Lv.${entry.level} HP~${entry.hpPercent}%`)
      .join(', ')
    : 'none';
  const actionLines = [
    ...input.moveOptions.map((move) => `move:${move.index} - ${move.nameKo} (PP ${move.pp}/${move.maxPp})`),
    ...input.partyOptions.map((party) => {
      const selfParty = self.party.find((entry) => entry.index === party.index);
      const level = selfParty?.level ?? self.active.level;
      return `switch:${party.index} - ${party.name} Lv.${level} HP:${party.hp}/${party.maxHp}${party.fainted ? ' fainted' : ''}`;
    }),
    'surrender',
  ];

  return [
    'You are playing a Pokemon battle in AI mode. Based ONLY on the info below,',
    'pick the best action: a move (1-4), a switch to a party member, or surrender.',
    '',
    `Your active: ${self.active.name} Lv.${self.active.level} HP:${self.active.hp}/${self.active.maxHp} ${statusLabel(self.active.fainted)}`,
    `Your moves: ${moveLine}`,
    `Your bench: ${benchLine}`,
    '',
    `Opponent active: ${input.fogState.opponentActive.species} Lv.${input.fogState.opponentActive.level} HP~${input.fogState.opponentActive.hpPercent}% ${input.fogState.opponentActive.visibleStatus ?? 'none'}`,
    `Opponent moves seen so far: ${seenMoves}`,
    `Opponent bench revealed: ${revealedBench} | hidden: ${input.fogState.opponentBenchHidden} slots`,
    '',
    'Available actions:',
    ...actionLines,
    '',
    'Reply with EXACTLY ONE line in one of these formats:',
    '  move:N    (N = 1-4)',
    '  switch:N  (N = party slot 1-6)',
    '  surrender',
    '',
  ].join('\n');
}

export function parseAiActionChoice(
  text: string,
  limits: ParseAiActionChoiceInput,
): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return null;
  if (/^surrender$/i.test(trimmed)) return 'surrender';

  const moveMatch = /^move:(\d+)$/i.exec(trimmed);
  if (moveMatch) {
    const index = Number.parseInt(moveMatch[1], 10);
    if (index >= 1 && index <= limits.moveCount) return `move:${index}`;
    return null;
  }

  const switchMatch = /^switch:(\d+)$/i.exec(trimmed);
  if (switchMatch) {
    const index = Number.parseInt(switchMatch[1], 10);
    if (index >= 1 && index <= limits.partyCount) return `switch:${index}`;
    return null;
  }

  return null;
}
