import { t } from '../i18n/index.js';
import type {
  BattleMove,
  BattlePokemon,
  BattleState,
  VolatileStatus,
  VolatileStatusType,
} from './types.js';
import { calculateDamage } from './turn-battle.js';

export function hasVolatileStatus(pokemon: BattlePokemon, type: VolatileStatusType): boolean {
  return pokemon.volatileStatuses.some((status) => status.type === type);
}

export function removeVolatileStatus(pokemon: BattlePokemon, type: VolatileStatusType): boolean {
  const before = pokemon.volatileStatuses.length;
  pokemon.volatileStatuses = pokemon.volatileStatuses.filter((status) => status.type !== type);
  return pokemon.volatileStatuses.length !== before;
}

export function clearVolatileStatuses(pokemon: BattlePokemon): void {
  pokemon.volatileStatuses = [];
}

export function addVolatileStatus(
  target: BattlePokemon,
  status: VolatileStatus,
  messages: string[],
): boolean {
  if (target.fainted) return false;

  if (hasVolatileStatus(target, status.type)) {
    if (status.type === 'confusion') {
      messages.push(t('volatile.confusion.already', { name: target.displayName }));
    }
    return false;
  }

  if (status.type === 'leech_seed' && target.types.includes('grass')) {
    messages.push(t('volatile.leech_seed.grass_immune', { name: target.displayName }));
    return false;
  }

  const nextStatus =
    status.type === 'confusion'
      ? {
          ...status,
          turnsRemaining: status.turnsRemaining ?? (Math.floor(Math.random() * 4) + 2),
        }
      : status;

  target.volatileStatuses.push(nextStatus);

  if (status.type === 'confusion') {
    messages.push(t('volatile.confusion.inflicted', { name: target.displayName }));
  } else if (status.type === 'leech_seed') {
    messages.push(t('volatile.leech_seed.inflicted', { name: target.displayName }));
  }

  return true;
}

const CONFUSION_SELF_HIT: BattleMove = {
  data: {
    id: -1,
    name: 'confusion-self-hit',
    nameKo: '혼란 자해',
    nameEn: 'Confusion Self Hit',
    type: 'typeless',
    category: 'physical',
    power: 40,
    accuracy: 100,
    pp: 1,
  },
  currentPp: 1,
};

export function applyConfusionSelfDamage(pokemon: BattlePokemon, messages: string[]): void {
  const damage = calculateDamage(pokemon, pokemon, CONFUSION_SELF_HIT);
  pokemon.currentHp = Math.max(0, pokemon.currentHp - damage);
  messages.push(t('volatile.confusion.self_hit', { name: pokemon.displayName }));
  if (pokemon.currentHp <= 0) {
    pokemon.fainted = true;
    messages.push(t('battle.fainted', { name: pokemon.displayName }));
  }
}

export function checkFlinchSkip(pokemon: BattlePokemon, messages: string[]): boolean {
  if (!removeVolatileStatus(pokemon, 'flinch')) return false;
  messages.push(t('volatile.flinch.inflicted', { name: pokemon.displayName }));
  return true;
}

export function checkConfusionSkip(pokemon: BattlePokemon, messages: string[]): boolean {
  const status = pokemon.volatileStatuses.find((entry) => entry.type === 'confusion');
  if (!status) return false;

  const current =
    typeof status.turnsRemaining === 'number' && Number.isFinite(status.turnsRemaining)
      ? status.turnsRemaining
      : 0;
  const next = Math.max(0, current - 1);
  status.turnsRemaining = next;

  const selfHit = Math.random() < (1 / 3);
  if (selfHit) {
    applyConfusionSelfDamage(pokemon, messages);
  }

  if (next === 0) {
    removeVolatileStatus(pokemon, 'confusion');
    messages.push(t('volatile.confusion.snap_out', { name: pokemon.displayName }));
  }

  return selfHit;
}

export function applyLeechSeedEndOfTurn(
  affected: BattlePokemon,
  allPokemon: Pick<BattleState, 'player' | 'opponent'>,
  messages: string[],
): boolean {
  const seeded = affected.volatileStatuses.find((entry) => entry.type === 'leech_seed');
  if (!seeded || affected.fainted) return false;

  // Defensive: a resumed save with a corrupted sourceSide ('foo') must not
  // crash when we look up the healing team. The normalizer drops invalid
  // entries on load, but this is a second line of defense.
  if (seeded.sourceSide !== 'player' && seeded.sourceSide !== 'opponent') return false;
  const sourceTeam = allPokemon[seeded.sourceSide];
  if (!sourceTeam || !Array.isArray(sourceTeam.pokemon)) return false;
  const healer = sourceTeam.pokemon[sourceTeam.activeIndex];
  if (!healer) return false;

  // Ownership guard: healing requires an explicit sourceSlot that still
  // matches the source team's active slot. This is stricter than the
  // executeSwitch cleanup path and covers three additional cases:
  //   1. Legacy/resumed saves with leech_seed but no sourceSlot field
  //      (pre-ownership-fix schema) — still drain, never heal.
  //   2. Active-slot changes outside executeSwitch (CLI/TUI replacement
  //      flows, post-faint replacements) where cleanup was skipped —
  //      the mismatched slot blocks healing even if the entry survives.
  //   3. Corrupted save data with a non-numeric sourceSlot.
  const healingAllowed =
    typeof seeded.sourceSlot === 'number' && seeded.sourceSlot === sourceTeam.activeIndex;

  const drain = Math.max(1, Math.floor(affected.maxHp / 8));
  const actualDrain = Math.min(drain, affected.currentHp);
  if (actualDrain <= 0) return false;

  affected.currentHp -= actualDrain;
  messages.push(t('volatile.leech_seed.drain', { name: affected.displayName }));
  if (affected.currentHp <= 0) {
    affected.currentHp = 0;
    affected.fainted = true;
  }

  if (healingAllowed && !healer.fainted) {
    healer.currentHp = Math.min(healer.maxHp, healer.currentHp + actualDrain);
  }

  return affected.fainted;
}
