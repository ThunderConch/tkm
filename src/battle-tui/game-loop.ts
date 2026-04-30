import { renderBattleScreen, renderSurrenderConfirm, renderBattleEnd } from './renderer.js';
import { createBattleState, resolveTurn, getActivePokemon, hasAlivePokemon } from '../core/turn-battle.js';
import { selectAiAction } from '../core/gym-ai.js';
import { startInput, stopInput } from './input.js';
import { t } from '../i18n/index.js';
import type { BattleState, BattlePokemon, TurnAction, GymData } from '../core/types.js';

// ── Types ──

type GamePhase = 'action_select' | 'surrender_confirm' | 'switch_select' | 'animating' | 'battle_over';

interface GameLoop {
  battleState: BattleState;
  gym: GymData | null;
  phase: GamePhase;
  recentMessages: string[];
  onComplete: (result: { winner: 'player' | 'opponent'; turnsPlayed: number }) => void;
}

// ── Rendering ──

function render(game: GameLoop): void {
  if (game.phase === 'battle_over') {
    process.stdout.write(renderBattleEnd(game.battleState, game.gym));
  } else if (game.phase === 'surrender_confirm') {
    // Show battle screen first, then surrender prompt overlay
    process.stdout.write(renderBattleScreen(game.battleState, game.gym, game.recentMessages));
    process.stdout.write(renderSurrenderConfirm());
  } else {
    // action_select, switch_select, animating — all use battle screen
    // For switch_select after faint, the battleState.phase is 'fainted_switch'
    // which renderer handles by showing the switch menu
    process.stdout.write(renderBattleScreen(game.battleState, game.gym, game.recentMessages));
  }
}

// ── AI Auto-switch ──

function autoSwitchAi(game: GameLoop): void {
  const oppTeam = game.battleState.opponent;
  const active = getActivePokemon(oppTeam);
  if (!active.fainted) return;

  // Find first non-fainted pokemon
  for (let i = 0; i < oppTeam.pokemon.length; i++) {
    if (!oppTeam.pokemon[i].fainted) {
      oppTeam.activeIndex = i;
      game.recentMessages.push(t('battle.opp_sent_out', { name: oppTeam.pokemon[i].displayName }));
      return;
    }
  }
}

// ── Key Handlers ──

function handleActionKey(game: GameLoop, key: string): void {
  const num = parseInt(key, 10);
  if (isNaN(num) || num < 1 || num > 6) return;

  const player = getActivePokemon(game.battleState.player);

  if (num >= 1 && num <= 4) {
    // Move selection
    const moveIndex = num - 1;
    const move = player.moves[moveIndex];
    if (!move) return; // no such move slot

    // Before rejecting a 0-PP move, check if ALL moves are depleted
    const allDepleted = player.moves.every(m => m.currentPp <= 0);
    let playerAction: TurnAction;
    if (allDepleted) {
      // Force through — engine will use Struggle
      playerAction = { type: 'move', moveIndex: 0 };
    } else if (move.currentPp <= 0) {
      return; // Only reject if other moves are available
    } else {
      playerAction = { type: 'move', moveIndex };
    }
    const opponent = getActivePokemon(game.battleState.opponent);
    const opponentAction = selectAiAction(opponent, player);

    const result = resolveTurn(game.battleState, playerAction, opponentAction);
    game.recentMessages = result.messages;

    // Post-turn logic
    if (result.opponentFainted && hasAlivePokemon(game.battleState.opponent)) {
      autoSwitchAi(game);
    }

    if (game.battleState.phase === 'battle_end') {
      game.phase = 'battle_over';
    } else if (game.battleState.phase === 'fainted_switch') {
      game.phase = 'switch_select';
    } else {
      game.phase = 'action_select';
    }
  } else if (num === 5) {
    // Switch pokemon
    const team = game.battleState.player;
    const hasAlive = team.pokemon.some((p, i) => !p.fainted && i !== team.activeIndex);
    if (!hasAlive) return; // no available switch targets

    game.battleState.phase = 'fainted_switch'; // renderer uses this to show switch menu
    game.phase = 'switch_select';
  } else if (num === 6) {
    // Surrender
    game.phase = 'surrender_confirm';
  }

  render(game);
}

function handleSurrenderKey(game: GameLoop, key: string): void {
  if (key === '1') {
    // Confirm surrender
    const playerAction: TurnAction = { type: 'surrender' };
    const opponentAction: TurnAction = { type: 'move', moveIndex: 0 };
    const result = resolveTurn(game.battleState, playerAction, opponentAction);
    game.recentMessages = result.messages;
    game.phase = 'battle_over';
  } else if (key === '2') {
    // Cancel surrender
    game.battleState.phase = 'select_action';
    game.phase = 'action_select';
  } else {
    return; // ignore other keys
  }

  render(game);
}

function handleSwitchKey(game: GameLoop, key: string): void {
  const num = parseInt(key, 10);
  if (isNaN(num) || num < 1) return;

  const targetIndex = num - 1;
  const team = game.battleState.player;

  // Validate index
  if (targetIndex >= team.pokemon.length) return;
  if (team.pokemon[targetIndex].fainted) return;
  if (targetIndex === team.activeIndex) return;

  // Check if this is a fainted-switch (forced) or voluntary switch
  const currentActive = getActivePokemon(team);
  const isFaintedSwitch = currentActive.fainted;

  if (isFaintedSwitch) {
    // Forced switch — no AI turn, just swap
    team.activeIndex = targetIndex;
    const newActive = getActivePokemon(team);
    game.recentMessages = [t('battle.go', { pokemon: newActive.displayName })];
    game.battleState.phase = 'select_action';
    game.phase = 'action_select';
  } else {
    // Voluntary switch — AI gets a turn
    const playerAction: TurnAction = { type: 'switch', pokemonIndex: targetIndex };
    const opponent = getActivePokemon(game.battleState.opponent);
    const player = getActivePokemon(team);
    const opponentAction = selectAiAction(opponent, player);

    const result = resolveTurn(game.battleState, playerAction, opponentAction);
    game.recentMessages = result.messages;

    if (result.opponentFainted && hasAlivePokemon(game.battleState.opponent)) {
      autoSwitchAi(game);
    }

    if (game.battleState.phase === 'battle_end') {
      game.phase = 'battle_over';
    } else if (game.battleState.phase === 'fainted_switch') {
      game.phase = 'switch_select';
    } else {
      game.phase = 'action_select';
    }
  }

  render(game);
}

// ── Main Entry ──

export function startGameLoop(
  playerTeam: BattlePokemon[],
  opponentTeam: BattlePokemon[],
  gym: GymData | null,
  onComplete: (result: { winner: 'player' | 'opponent'; turnsPlayed: number }) => void,
): void {
  const battleState = createBattleState(playerTeam, opponentTeam);

  const game: GameLoop = {
    battleState,
    gym,
    phase: 'action_select',
    recentMessages: gym
      ? [t('battle.gym_challenge', { leader: gym.leader })]
      : [t('battle.battle_start')],
    onComplete,
  };

  // Initial render
  render(game);

  // Input loop
  startInput((key: string) => {
    if (game.phase === 'battle_over') {
      // Any key exits
      stopInput();
      onComplete({
        winner: battleState.winner as 'player' | 'opponent',
        turnsPlayed: battleState.turn,
      });
      return;
    }

    switch (game.phase) {
      case 'action_select':
        handleActionKey(game, key);
        break;
      case 'surrender_confirm':
        handleSurrenderKey(game, key);
        break;
      case 'switch_select':
        handleSwitchKey(game, key);
        break;
      default:
        break;
    }
  });
}
