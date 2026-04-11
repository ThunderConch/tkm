/**
 * Battle State File I/O — read/write/delete the persistent battle state JSON.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { createStatStages } from './stat-stages.js';
import type { BattlePokemon, BattleState, BattleTeam, GymData } from './types.js';

// ── Constants ──

export const STATE_DIR = join(process.env.HOME || '', '.claude', 'tokenmon');
// Battle state is stored at a fixed location (not per-gen) because
// only one battle can be active at a time across all generations.
export const BATTLE_STATE_PATH = join(STATE_DIR, 'battle-state.json');

// ── Types ──

export interface BattleStateFile {
  battleState: BattleState;
  gym: GymData;
  generation: string;
  stateDir: string;
  playerPartyNames: string[];
  sessionId?: string;
}

// ── File Operations ──

/**
 * Backfill status fields on a BattlePokemon parsed from an older save.
 * `statusCondition` and `toxicCounter` were added in status-effects-v2;
 * `sleepCounter` was added in status-effects-v3a. Earlier battle-state.json
 * files lack these. We normalize `undefined` to schema defaults so downstream
 * checks (e.g. `statusCondition !== null`) do not mistake a pre-status battle
 * for "already has a status", and so arithmetic on `sleepCounter` does not
 * produce NaN (which would trap a sleeping mon in permanent sleep on resume).
 */
export function normalizeBattlePokemon(mon: BattlePokemon): void {
  if (mon.statusCondition === undefined) {
    mon.statusCondition = null;
  }
  if (mon.toxicCounter === undefined) {
    mon.toxicCounter = 0;
  }
  if (mon.sleepCounter === undefined || !Number.isFinite(mon.sleepCounter)) {
    mon.sleepCounter = 0;
  }
  if (!Array.isArray(mon.volatileStatuses)) {
    mon.volatileStatuses = [];
  } else {
    // Validate each entry and drop malformed ones so resumed state with
    // schema drift cannot crash end-of-turn logic (e.g., leech-seed with
    // an unknown sourceSide dereferencing allPokemon[undefined]).
    const validTypes = new Set(['confusion', 'flinch', 'leech_seed']);
    const validSides = new Set(['player', 'opponent']);
    mon.volatileStatuses = mon.volatileStatuses.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (!validTypes.has((entry as { type?: string }).type ?? '')) return false;
      // confusion: drop entries with invalid or already-expired turn counters
      // so the next turn cannot trigger an extra self-hit roll on a
      // supposedly-cleaned save (checkConfusionSkip runs the self-hit roll
      // before decrementing below 0).
      if ((entry as { type: string }).type === 'confusion') {
        const t = (entry as { turnsRemaining?: unknown }).turnsRemaining;
        if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
          return false;
        }
      }
      // leech_seed: require valid sourceSide AND numeric sourceSlot.
      // Legacy saves from before the ownership fix have no sourceSlot,
      // which would let them drain the target forever without the
      // ownership guard ever matching. Drop them entirely so resume
      // cannot silently revive the pre-R3 ownership bug.
      if ((entry as { type: string }).type === 'leech_seed') {
        const s = (entry as { sourceSide?: unknown }).sourceSide;
        if (typeof s !== 'string' || !validSides.has(s)) return false;
        const slot = (entry as { sourceSlot?: unknown }).sourceSlot;
        if (typeof slot !== 'number' || !Number.isFinite(slot) || slot < 0) return false;
      }
      return true;
    });
  }
  if (mon.statStages === undefined) {
    mon.statStages = createStatStages();
  } else {
    mon.statStages.attack = Number.isFinite(mon.statStages.attack) ? mon.statStages.attack : 0;
    mon.statStages.defense = Number.isFinite(mon.statStages.defense) ? mon.statStages.defense : 0;
    mon.statStages.spAttack = Number.isFinite(mon.statStages.spAttack) ? mon.statStages.spAttack : 0;
    mon.statStages.spDefense = Number.isFinite(mon.statStages.spDefense) ? mon.statStages.spDefense : 0;
    mon.statStages.speed = Number.isFinite(mon.statStages.speed) ? mon.statStages.speed : 0;
    mon.statStages.accuracy = Number.isFinite(mon.statStages.accuracy) ? mon.statStages.accuracy : 0;
    mon.statStages.evasion = Number.isFinite(mon.statStages.evasion) ? mon.statStages.evasion : 0;
  }
}

export function normalizeBattleTeam(team: BattleTeam): void {
  if (!team || !Array.isArray(team.pokemon)) return;
  for (const mon of team.pokemon) {
    normalizeBattlePokemon(mon);
  }
}

export function readBattleState(): BattleStateFile | null {
  if (!existsSync(BATTLE_STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BATTLE_STATE_PATH, 'utf-8')) as BattleStateFile;
    // Migrate pre-status saves so they can be resumed safely.
    if (parsed?.battleState?.player) normalizeBattleTeam(parsed.battleState.player);
    if (parsed?.battleState?.opponent) normalizeBattleTeam(parsed.battleState.opponent);
    // Migrate animating phase: if battle was stuck in animation, reconcile to the
    // correct legal phase based on winner/fainted state — not blindly select_action.
    if ((parsed?.battleState?.phase as string) === 'animating') {
      const bs = parsed.battleState;
      if (bs.winner) {
        // Battle already resolved (badges were awarded before animation started).
        // Delete the stale state file and return null so caller treats it as no battle.
        try { unlinkSync(BATTLE_STATE_PATH); } catch { /* ignore */ }
        return null;
      }
      const active = bs.player.pokemon[bs.player.activeIndex];
      if (active?.fainted && bs.player.pokemon.some((p, i) => i !== bs.player.activeIndex && !p.fainted)) {
        bs.phase = 'fainted_switch';
      } else {
        bs.phase = 'select_action';
      }
    }
    return {
      ...parsed,
      sessionId: parsed.sessionId ?? undefined,
    };
  } catch {
    return null;
  }
}

export function writeBattleState(bsf: BattleStateFile): void {
  const dir = dirname(BATTLE_STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = BATTLE_STATE_PATH + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(bsf, null, 2), 'utf-8');
    renameSync(tmpPath, BATTLE_STATE_PATH);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function deleteBattleState(): void {
  if (existsSync(BATTLE_STATE_PATH)) {
    try { unlinkSync(BATTLE_STATE_PATH); } catch { /* ignore */ }
  }
}
