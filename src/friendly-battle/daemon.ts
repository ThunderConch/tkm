// src/friendly-battle/daemon.ts
//
// Long-lived daemon process that holds the TCP transport and drives the
// friendly-battle turn loop. Spawned as a detached child by --init-host /
// --init-join (Task 5). Exposes a UNIX socket for one-shot CLI subcommands.
//
// CLI:  tsx daemon.ts --role host|guest --options-json <base64>
//
// Options JSON shape:
//   { sessionId, sessionCode, host, port, generation, playerName, timeoutMs }
//
// Stdout protocol:
//   DAEMON_READY <sessionId> <socketPath>\n   ← emitted once, then silence
//
// SIGTERM / SIGINT → write phase='aborted', exit 1
// battle_finished  → write phase='finished', exit 0

import { randomUUID } from 'node:crypto';
import { closeSync as fsCloseSync, mkdirSync, openSync as fsOpenSync, writeSync as fsWriteSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createFriendlyBattleSpikeHost,
  connectFriendlyBattleSpikeGuest,
} from './spike/tcp-direct.js';
import {
  createFriendlyBattleBattleRuntime,
  getFriendlyBattleWaitingForRoles,
  submitFriendlyBattleChoice,
} from './battle-adapter.js';
import {
  createBattleTeamFromFriendlyBattleSnapshot,
  buildFriendlyBattlePartySnapshot,
} from './snapshot.js';
import {
  loadFriendlyBattleCurrentProfile,
  createFriendlyBattleChoiceEnvelope,
  formatFriendlyBattleChoice,
} from './local-harness.js';
import { getLoadedMovesDB } from '../core/battle-setup.js';
import { getDisplayName as getPokemonDisplayName } from '../core/pokemon-data.js';
import { getLocale, initLocale } from '../i18n/index.js';
import { readGlobalConfig } from '../core/config.js';
import {
  friendlyBattleSessionsDir,
  writeFriendlyBattleSessionRecord,
  type FriendlyBattleSessionRecord,
} from './session-store.js';
import { createDaemonIpcServer } from './daemon-ipc.js';
import type { DaemonRequest, DaemonResponse, DaemonAction } from './daemon-protocol.js';
import {
  formatFriendlyBattleTurnJson,
  type FriendlyBattleTurnMoveOption,
  type FriendlyBattleTurnPartyOption,
  type FriendlyBattleTurnAnimationFrame,
} from './turn-json.js';
import type {
  FriendlyBattleBattleEvent,
  FriendlyBattleChoiceEnvelope,
  FriendlyBattleLiveBattleState,
  FriendlyBattleRole,
  FriendlyBattlePartySnapshot,
} from './contracts.js';
import type { FriendlyBattleBattleRuntime } from './battle-adapter.js';
import { AsyncQueue } from './async-queue.js';

// ---------------------------------------------------------------------------
// Options JSON shape
// ---------------------------------------------------------------------------

interface DaemonOptions {
  sessionId: string;
  sessionCode: string;
  host: string;       // listenHost for role=host, remote host for role=guest
  port: number;
  generation: string;
  playerName: string;
  timeoutMs: number;
}

// Player actions are taken by humans who can spend minutes thinking. The
// init handshake's --timeout-ms is meant for pre-battle network setup, not
// for the in-battle turn loop, so we use a separate (much longer) bound for
// the per-turn waits. 30 minutes leaves room for slow play and tool latency
// without leaving a daemon orphaned forever. Tests may override this via
// TKM_FB_TURN_TIMEOUT_MS so leave/disconnect specs can finish in seconds.
const TURN_LOOP_TIMEOUT_MS = (() => {
  const override = Number.parseInt(process.env.TKM_FB_TURN_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(override) && override > 0 ? override : 30 * 60 * 1000;
})();

// ---------------------------------------------------------------------------
// Helpers: convert BattleEvents → turn-json fields
// ---------------------------------------------------------------------------

function buildMoveOptionsFromSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleTurnMoveOption[] {
  // find the first alive pokemon (slot 0 is the active one for a fresh battle)
  const active = snapshot.pokemon.slice().sort((a, b) => a.slot - b.slot)[0];
  if (!active) return [];
  // SKILL.md / CLI expect 1-based move indexes (matches skills/gym/SKILL.md).
  // The CLI runAction subtracts 1 before forwarding to the battle adapter.
  return active.moves.map((move, arrayIdx) => ({
    index: arrayIdx + 1,
    nameKo: move.name ?? `Move ${arrayIdx + 1}`,
    pp: move.pp,
    maxPp: move.pp,
    disabled: move.pp <= 0,
  }));
}

function buildMoveOptionsFromRuntime(
  runtime: FriendlyBattleBattleRuntime,
  role: FriendlyBattleRole,
): FriendlyBattleTurnMoveOption[] {
  const team = role === 'host' ? runtime.state.player : runtime.state.opponent;
  const active = team.pokemon[team.activeIndex];
  if (!active) return [];
  // 1-based indexes (see buildMoveOptionsFromSnapshot comment).
  return active.moves.map((move, arrayIdx) => ({
    index: arrayIdx + 1,
    nameKo: move.data.nameKo ?? move.data.name ?? `Move ${arrayIdx + 1}`,
    pp: move.currentPp,
    maxPp: move.data.pp,
    disabled: move.currentPp <= 0,
  }));
}

function buildPartyOptionsFromRuntime(
  runtime: FriendlyBattleBattleRuntime,
  role: FriendlyBattleRole,
): FriendlyBattleTurnPartyOption[] {
  const team = role === 'host' ? runtime.state.player : runtime.state.opponent;
  // 1-based party indexes (matches switch:<N> token in SKILL.md).
  return team.pokemon.map((pokemon, arrayIdx) => ({
    index: arrayIdx + 1,
    name: pokemon.displayName ?? `Pokemon ${arrayIdx + 1}`,
    hp: pokemon.currentHp,
    maxHp: pokemon.maxHp,
    fainted: pokemon.fainted,
  }));
}

function buildPartyOptionsFromSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleTurnPartyOption[] {
  return snapshot.pokemon.map((pokemon, arrayIdx) => ({
    index: arrayIdx + 1,
    name: pokemon.displayName,
    hp: pokemon.baseStats.hp,
    maxHp: pokemon.baseStats.hp,
    fainted: false,
  }));
}

/**
 * Build a gym-style battle context string for the question headline:
 *   "<headline>\n⚔️ 상대 <name> Lv.L HP:cur/max | 내 <name> Lv.L HP:cur/max"
 *
 * When the daemon has a battle-adapter runtime (host side), we can render
 * both sides' live HP. On the guest side without a runtime we fall back to
 * the local party snapshot and render only "내 <name>" (opponent is omitted
 * because we don't have authoritative guest-side HP state yet).
 */
function buildBattleContext(
  headline: string,
  runtime: FriendlyBattleBattleRuntime | null,
  role: FriendlyBattleRole,
  ownSnapshot: FriendlyBattlePartySnapshot | null,
): string {
  if (runtime) {
    const selfTeam = role === 'host' ? runtime.state.player : runtime.state.opponent;
    const oppTeam  = role === 'host' ? runtime.state.opponent : runtime.state.player;
    const self = selfTeam.pokemon[selfTeam.activeIndex];
    const opp  = oppTeam.pokemon[oppTeam.activeIndex];
    if (self && opp) {
      const oppLabel  = `상대 ${opp.displayName ?? 'Unknown'} Lv.${opp.level} HP:${opp.currentHp}/${opp.maxHp}`;
      const selfLabel = `내 ${self.displayName ?? 'Me'} Lv.${self.level} HP:${self.currentHp}/${self.maxHp}`;
      return `${headline}\n⚔️ ${oppLabel} | ${selfLabel}`;
    }
  }
  if (ownSnapshot) {
    const own = ownSnapshot.pokemon.slice().sort((a, b) => a.slot - b.slot)[0];
    if (own) {
      const selfLabel = `내 ${own.displayName} Lv.${own.level} HP:${own.baseStats.hp}/${own.baseStats.hp}`;
      return `${headline}\n${selfLabel} (상대 HP는 다음 턴 결과에서 확인)`;
    }
  }
  return headline;
}

/**
 * Look up a move's name in the local (per-client) i18n data so each daemon
 * renders names in its OWN locale instead of reusing the host's resolved
 * strings. Falls back to the host-authored wire name if the local DB cannot
 * find the move id.
 */
function localizeMoveName(moveId: number, fallback: string): string {
  if (!moveId || moveId <= 0) return fallback;
  const db = getLoadedMovesDB();
  if (!db) return fallback;
  const data = db[String(moveId)];
  if (!data) return fallback;
  const localized = getLocale() === 'ko'
    ? (data.nameKo ?? data.nameEn ?? data.name)
    : (data.nameEn ?? data.nameKo ?? data.name);
  return localized || fallback;
}

/**
 * Look up a pokemon species name in the local i18n data. Falls back to the
 * host-authored wire name if the local DB cannot find the species id.
 */
function localizePokemonName(speciesId: number, fallback: string): string {
  if (!speciesId || speciesId <= 0) return fallback;
  try {
    const display = getPokemonDisplayName(speciesId);
    return display || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build the envelope display fields directly from the host-authored live
 * battle state. This is the canonical path: guest daemons consume it without
 * needing their own runtime, and host daemons get the same accurate render
 * as a side effect. The legacy buildXxxFromRuntime / FromSnapshot helpers
 * are kept only for old test events that don't carry liveState.
 */
function buildEnvelopeFieldsFromLiveState(input: {
  headline: string;
  liveState: FriendlyBattleLiveBattleState;
  role: FriendlyBattleRole;
  showMoveOptions: boolean;
  showPartyOptions: boolean;
}): {
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
} {
  const self = input.role === 'host' ? input.liveState.host : input.liveState.guest;
  const opp  = input.role === 'host' ? input.liveState.guest : input.liveState.host;

  // Localize names locally so each client renders in its OWN locale instead
  // of reusing the host's pre-resolved strings.
  const moveOptions: FriendlyBattleTurnMoveOption[] = input.showMoveOptions
    ? self.active.moves.map((m) => ({
        index: m.index,
        nameKo: localizeMoveName(m.moveId, m.nameKo),
        pp: m.pp,
        maxPp: m.maxPp,
        disabled: m.disabled,
      }))
    : [];

  const partyOptions: FriendlyBattleTurnPartyOption[] = input.showPartyOptions
    ? self.party.map((p) => ({
        index: p.index,
        name: localizePokemonName(p.pokemonId, p.name),
        hp: p.hp,
        maxHp: p.maxHp,
        fainted: p.fainted,
      }))
    : [];

  const oppName  = localizePokemonName(opp.active.pokemonId, opp.active.name);
  const selfName = localizePokemonName(self.active.pokemonId, self.active.name);
  const oppLabel  = `상대 ${oppName} Lv.${opp.active.level} HP:${opp.active.hp}/${opp.active.maxHp}`;
  const selfLabel = `내 ${selfName} Lv.${self.active.level} HP:${self.active.hp}/${self.active.maxHp}`;
  const questionContext = `${input.headline}\n⚔️ ${oppLabel} | ${selfLabel}`;

  return {
    questionContext,
    moveOptions,
    partyOptions,
    animationFrames: [],
    currentFrameIndex: 0,
  };
}

function eventToEnvelopeFields(
  event: FriendlyBattleBattleEvent,
  role: FriendlyBattleRole,
  runtime: FriendlyBattleBattleRuntime | null,
  ownSnapshot: FriendlyBattlePartySnapshot | null,
): {
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
} {
  switch (event.type) {
    case 'battle_initialized': {
      // Prefer the authoritative live state the host embedded. Guest daemons
      // don't have a local runtime; without liveState, the legacy fallback
      // rendered species-base HP (100/100 for Dialga) from ownSnapshot.
      if (event.liveState) {
        const fromLive = buildEnvelopeFieldsFromLiveState({
          headline: 'Battle started!',
          liveState: event.liveState,
          role,
          showMoveOptions: false,
          showPartyOptions: false,
        });
        return {
          ...fromLive,
          animationFrames: [{ kind: 'message', text: 'Battle started!', durationMs: 300 }],
        };
      }
      return {
        questionContext: buildBattleContext('Battle started!', runtime, role, ownSnapshot),
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : (ownSnapshot ? buildPartyOptionsFromSnapshot(ownSnapshot) : []),
        animationFrames: [{ kind: 'message', text: 'Battle started!', durationMs: 300 }],
        currentFrameIndex: 0,
      };
    }
    case 'choices_requested': {
      const isFaintedSwitch = event.phase === 'awaiting_fainted_switch';
      const localIsWaiting = event.waitingFor.includes(role);
      // Prefer the authoritative live state the host embedded in the event.
      // If absent (older test events), fall back to the local runtime/snapshot.
      if (event.liveState) {
        const headline = isFaintedSwitch
          ? (localIsWaiting
              ? `Turn ${event.turn}: Your Pokémon fainted — pick a replacement`
              : `Turn ${event.turn}: Opponent's Pokémon fainted — waiting for their replacement`)
          : `Turn ${event.turn}: Choose your action`;
        return buildEnvelopeFieldsFromLiveState({
          headline,
          liveState: event.liveState,
          role,
          // Only the side that is actually waiting gets move/party options;
          // the other side is just a spectator until the peer submits.
          showMoveOptions: !isFaintedSwitch && localIsWaiting,
          showPartyOptions: localIsWaiting,
        });
      }
      // Legacy fallback path (used by older synthetic-event tests)
      const moveOptions = isFaintedSwitch
        ? []
        : (runtime
            ? buildMoveOptionsFromRuntime(runtime, role)
            : (ownSnapshot ? buildMoveOptionsFromSnapshot(ownSnapshot) : []));
      const partyOptions = runtime
        ? buildPartyOptionsFromRuntime(runtime, role)
        : (ownSnapshot ? buildPartyOptionsFromSnapshot(ownSnapshot) : []);
      const headline = isFaintedSwitch
        ? `Turn ${event.turn}: Your Pokémon fainted — pick a replacement`
        : `Turn ${event.turn}: Choose your action`;
      return {
        questionContext: buildBattleContext(headline, runtime, role, ownSnapshot),
        moveOptions,
        partyOptions,
        animationFrames: [],
        currentFrameIndex: 0,
      };
    }
    case 'turn_resolved': {
      const frames: FriendlyBattleTurnAnimationFrame[] = event.messages.map((msg) => ({
        kind: 'message',
        text: msg,
        durationMs: 300,
      }));
      // Host-authoritative post-turn state when available (see battle-adapter
      // finalizeResolution). Without this, guest turn recaps showed stale
      // species-base HP from ownSnapshot.
      if (event.liveState) {
        const fromLive = buildEnvelopeFieldsFromLiveState({
          headline: event.messages.join(' '),
          liveState: event.liveState,
          role,
          showMoveOptions: false,
          showPartyOptions: false,
        });
        return {
          ...fromLive,
          animationFrames: frames,
        };
      }
      return {
        questionContext: buildBattleContext(event.messages.join(' '), runtime, role, ownSnapshot),
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: frames,
        currentFrameIndex: 0,
      };
    }
    case 'battle_finished': {
      // Distinguish voluntary leave (cancelled) and peer disconnect from a
      // normal win/loss so the skill can render an accurate end-of-battle
      // message without having to sniff stderr or the reason field.
      let questionContext: string;
      if (event.reason === 'cancelled') {
        questionContext = 'You left the battle.';
      } else if (event.reason === 'disconnect') {
        questionContext = 'Opponent left the battle.';
      } else if (event.winner === role) {
        questionContext = 'You won!';
      } else {
        questionContext = 'You lost!';
      }
      return {
        questionContext,
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: [],
        currentFrameIndex: 0,
      };
    }
  }
}

function eventStatus(
  event: FriendlyBattleBattleEvent,
  role: FriendlyBattleRole,
): FriendlyBattleSessionRecord['status'] {
  switch (event.type) {
    case 'battle_initialized':
      return 'ongoing';
    case 'choices_requested': {
      // For fainted_switch, only the role(s) actually in waitingFor should
      // see the forced-switch menu. Spectators (the side whose pokemon did
      // NOT faint) treat the event as 'ongoing' and loop back to wait_next_event
      // — otherwise both clients would try to pick a replacement when only
      // one needs to.
      if (event.phase === 'awaiting_fainted_switch') {
        return event.waitingFor.includes(role) ? 'fainted_switch' : 'ongoing';
      }
      // Normal turn: both sides are in waitingFor by definition. If for some
      // reason the local role has already submitted and is waiting on the
      // peer, surface it as 'ongoing' so the skill polls again instead of
      // re-prompting for a duplicate move.
      return event.waitingFor.includes(role) ? 'select_action' : 'ongoing';
    }
    case 'turn_resolved':
      return 'ongoing';
    case 'battle_finished':
      // Voluntary leave (cancelled) and peer disconnect are aborted states,
      // not a win/loss. Map them to 'aborted' so the skill's turn loop can
      // branch cleanly without sniffing the reason field.
      if (event.reason === 'cancelled' || event.reason === 'disconnect') {
        return 'aborted';
      }
      return event.winner === role ? 'victory' : 'defeat';
  }
}

// ---------------------------------------------------------------------------
// Serialize a DaemonAction for use with connectFriendlyBattleSpikeGuest.submitChoice
// ---------------------------------------------------------------------------

function serializeDaemonAction(action: DaemonAction): string {
  switch (action.kind) {
    case 'move': return `move:${action.index}`;
    case 'switch': return `switch:${action.pokemonIndex}`;
    case 'surrender': return 'surrender';
  }
}

// ---------------------------------------------------------------------------
// Main daemon entry
// ---------------------------------------------------------------------------

async function runDaemon(role: FriendlyBattleRole, options: DaemonOptions): Promise<void> {
  const { sessionId, sessionCode, host, port, generation, playerName, timeoutMs } = options;

  // Initialize locale from the user's global config so getPokemonName,
  // getGameI18n, localizeMoveName, and localizePokemonName all render in
  // the player's chosen language. Without this, the daemon subprocess
  // defaults to 'en' even when the user's tokenmon config is 'ko'.
  // Wrapped in try/catch so a missing/corrupt config still lets the
  // daemon come up (the battle will just show English names).
  try {
    const globalConfig = readGlobalConfig();
    initLocale(globalConfig.language ?? 'en', globalConfig.voice_tone);
  } catch {
    // swallow — locale init must never crash the daemon
  }

  // Derive the socket path — lives in the same dir as session records
  const sessionsDir = friendlyBattleSessionsDir(generation);
  mkdirSync(sessionsDir, { recursive: true });
  const socketPath = join(sessionsDir, `${sessionId}.sock`);

  // ---------------------------------------------------------------------------
  // Crash log — captures stderr + uncaughtException + unhandledRejection so we
  // can actually see why the daemon died. The parent CLI destroys its read end
  // of child.stderr right after DAEMON_READY so stderr writes would otherwise
  // be silently discarded. Writing to a file here gives us a post-mortem even
  // when the parent is long gone.
  const crashLogPath = join(sessionsDir, `${sessionId}.crash.log`);
  const crashLogFd = fsOpenSync(crashLogPath, 'a');
  const logLine = (line: string): void => {
    try {
      fsWriteSync(crashLogFd, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // swallow — logging must never crash the daemon
    }
  };
  logLine(`daemon-start role=${role} pid=${process.pid} sessionId=${sessionId}`);

  // Mirror process.stderr.write into the crash log. We deliberately do NOT
  // forward to the real stderr stream — the parent CLI destroys its read end
  // of the child's stderr right after DAEMON_READY, so any subsequent write
  // to the original stream would EPIPE and uncaughtException-kill the
  // daemon (this exact crash appeared in early visual QA logs). The crash
  // log file is now the canonical post-mortem channel.
  process.stderr.write = ((
    chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    _cb?: (err?: Error) => void,
  ): boolean => {
    try {
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString('utf8');
      fsWriteSync(crashLogFd, text);
    } catch {
      // swallow — logging must never crash the daemon
    }
    return true;
  }) as typeof process.stderr.write;

  process.on('uncaughtException', (err: Error) => {
    logLine(`uncaughtException: ${err.stack ?? err.message ?? String(err)}`);
    try { fsCloseSync(crashLogFd); } catch { /* swallow */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logLine(`unhandledRejection: ${stack}`);
    try { fsCloseSync(crashLogFd); } catch { /* swallow */ }
    process.exit(1);
  });

  const nowIso = () => new Date().toISOString();

  // ---------------------------------------------------------------------------
  // Event queue (delivered to UNIX socket wait_next_event callers)
  // Action queue (populated by UNIX socket submit_action callers)
  // ---------------------------------------------------------------------------
  const localEventQueue = new AsyncQueue<FriendlyBattleBattleEvent>();
  const localActionQueue = new AsyncQueue<FriendlyBattleChoiceEnvelope>();

  // Sentinel set during clean shutdown: late wait_next_event callers get this
  // finished envelope immediately instead of hanging until their own timeout.
  let queueClosedEnvelope: ReturnType<typeof formatFriendlyBattleTurnJson> | null = null;

  // Transport closer: set by the host/guest path once a transport is created.
  // The leave IPC handler uses this to tear down the TCP connection so the
  // peer gets an EOF and can shut down on its own.
  let transportClose: (() => Promise<void>) | null = null;

  // ---------------------------------------------------------------------------
  // Session record — written every time phase changes
  // ---------------------------------------------------------------------------
  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role,
    generation,
    sessionCode,
    phase: role === 'host' ? 'waiting_for_guest' : 'handshake',
    status: role === 'host' ? 'waiting_for_guest' : 'connecting',
    transport: { host, port },
    opponent: null,
    pid: process.pid,
    daemonPid: process.pid,
    socketPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  function writeRecord(): void {
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
  }

  writeRecord();

  // ---------------------------------------------------------------------------
  // Runtime reference (only host sets this)
  // ---------------------------------------------------------------------------
  let runtime: FriendlyBattleBattleRuntime | null = null;
  // Own snapshot (for guest-side move option construction before first event)
  let ownSnapshot: FriendlyBattlePartySnapshot | null = null;

  // ---------------------------------------------------------------------------
  // IPC handler
  // ---------------------------------------------------------------------------
  async function ipcHandler(req: DaemonRequest): Promise<DaemonResponse> {
    switch (req.op) {
      case 'ping':
        return { op: 'pong', pid: process.pid };

      case 'status': {
        const fields = {
          questionContext: `phase=${record.phase} status=${record.status}`,
          moveOptions: runtime ? buildMoveOptionsFromRuntime(runtime, role) : (ownSnapshot ? buildMoveOptionsFromSnapshot(ownSnapshot) : []),
          partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : (ownSnapshot ? buildPartyOptionsFromSnapshot(ownSnapshot) : []),
          animationFrames: [] as FriendlyBattleTurnAnimationFrame[],
          currentFrameIndex: 0,
        };
        return { op: 'status', envelope: formatFriendlyBattleTurnJson({ record, ...fields }) };
      }

      case 'wait_next_event': {
        // If the queue was closed cleanly, return the finished envelope immediately.
        if (queueClosedEnvelope !== null) {
          return { op: 'event', envelope: queueClosedEnvelope };
        }
        let event: FriendlyBattleBattleEvent;
        try {
          event = await localEventQueue.shift(req.timeoutMs, 'wait_next_event');
        } catch (err) {
          // If shutdown armed the sentinel while we were blocked on shift(),
          // fall through to the finished envelope. Otherwise propagate.
          if (queueClosedEnvelope !== null) {
            return { op: 'event', envelope: queueClosedEnvelope };
          }
          throw err;
        }
        const fields = eventToEnvelopeFields(event, role, runtime, ownSnapshot);
        // Update record status based on the event
        record.status = eventStatus(event, role);
        writeRecord();
        return { op: 'event', envelope: formatFriendlyBattleTurnJson({ record, ...fields }) };
      }

      case 'submit_action': {
        const envelope = createFriendlyBattleChoiceEnvelope(role, serializeDaemonAction(req.action));
        localActionQueue.push(envelope);
        // Return current status snapshot
        const fields = {
          questionContext: `Action submitted: ${serializeDaemonAction(req.action)}`,
          moveOptions: [] as FriendlyBattleTurnMoveOption[],
          partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
          animationFrames: [] as FriendlyBattleTurnAnimationFrame[],
          currentFrameIndex: 0,
        };
        return { op: 'ack', envelope: formatFriendlyBattleTurnJson({ record, ...fields }) };
      }

      case 'leave': {
        // Mark the session as aborted. The leaving player gets the ack envelope
        // directly (no need to push to localEventQueue — that would cause the
        // shutdown drain to wait 10s for a consumer that never comes).
        record.phase = 'aborted';
        record.status = 'aborted';
        writeRecord();
        const leaveEnvelope = formatFriendlyBattleTurnJson({
          record,
          questionContext: 'You left the battle.',
          moveOptions: [],
          partyOptions: [],
          animationFrames: [],
          currentFrameIndex: 0,
        });
        // Kick off async shutdown but don't await it — we need to return the ack
        // response first. Close the transport first so the peer gets an EOF and
        // can shut down on its own. Then shut down this daemon.
        setImmediate(() => {
          void (async () => {
            if (transportClose) await transportClose().catch(() => undefined);
            await shutdown(0, 'finished');
          })();
        });
        return { op: 'ack', envelope: leaveEnvelope };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Start the IPC server before doing anything else so DAEMON_READY can fire
  // ---------------------------------------------------------------------------
  const ipcServer = await createDaemonIpcServer(socketPath, ipcHandler);

  // ---------------------------------------------------------------------------
  // Shutdown helper
  // ---------------------------------------------------------------------------
  let shutdownCalled = false;
  async function shutdown(exitCode: number, phase: FriendlyBattleSessionRecord['phase']): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;
    record.phase = phase;
    record.status = phase === 'finished' ? (record.status) : 'aborted';
    writeRecord();
    // Fail action queue to unblock any turn-loop waiter.
    localActionQueue.fail(new Error('daemon shutting down'));
    // Build the fallback message from the final record status so a late
    // wait_next_event caller gets a message consistent with the actual
    // outcome — including 'aborted' (voluntary leave / peer disconnect),
    // which used to contradictorily render as "You lost!".
    const fallbackContext = record.status === 'victory'
      ? 'You won!'
      : record.status === 'aborted'
        ? 'Battle ended.'
        : 'You lost!';
    if (exitCode !== 0) {
      // On error/abort: arm the sentinel BEFORE failing the queue so any
      // wait_next_event caller that was already blocked in shift() falls
      // through to the sentinel check in the IPC catch branch instead of
      // bubbling up a generic 'handler_error'.
      queueClosedEnvelope = formatFriendlyBattleTurnJson({
        record,
        questionContext: fallbackContext,
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: [],
        currentFrameIndex: 0,
      });
      localEventQueue.fail(new Error('daemon shutting down'));
    } else {
      // On clean finish: drain any already-buffered events first so legitimate
      // wait_next_event callers can consume them, with a 10s safety timeout.
      const drainDeadline = Date.now() + 10_000;
      while (localEventQueue.size > 0 && Date.now() < drainDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      // Arm the sentinel AFTER drain so new wait_next_event callers get the
      // finished envelope immediately instead of blocking on the now-empty
      // queue. Any waiter that was blocked on shift() during drain gets
      // unblocked by the subsequent localEventQueue.fail(); the IPC handler
      // catches that rejection and returns the sentinel.
      queueClosedEnvelope = formatFriendlyBattleTurnJson({
        record,
        questionContext: fallbackContext,
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: [],
        currentFrameIndex: 0,
      });
      // Unblock any shift() that's already in flight so it can fall through
      // to the sentinel check in the IPC handler's catch branch.
      localEventQueue.fail(new Error('daemon finished cleanly'));
    }
    await ipcServer.close().catch(() => undefined);
    process.exit(exitCode);
  }

  process.once('SIGTERM', () => { void shutdown(1, 'aborted'); });
  process.once('SIGINT',  () => { void shutdown(1, 'aborted'); });

  // ---------------------------------------------------------------------------
  // Host path
  // ---------------------------------------------------------------------------
  if (role === 'host') {
    const host_transport = await createFriendlyBattleSpikeHost({
      host,
      port,
      sessionCode,
      hostPlayerName: playerName,
      generation,
    });

    // Register transport closer so the leave IPC handler can tear down TCP.
    transportClose = () => host_transport.close();

    // Signal ready with actual bound port so parent/test can connect guest
    process.stdout.write(`DAEMON_READY ${sessionId} ${socketPath} ${host_transport.connectionInfo.port}\n`);

    try {
      // Handshake
      record.phase = 'waiting_for_guest';
      record.status = 'waiting_for_guest';
      record.transport = { host: host_transport.connectionInfo.host, port: host_transport.connectionInfo.port };
      writeRecord();

      const joined = await host_transport.waitForGuestJoin(timeoutMs);
      record.opponent = { playerName: joined.guestPlayerName };
      record.phase = 'handshake';
      record.status = 'ongoing';
      writeRecord();

      // Load host profile & build teams
      const hostProfile = loadFriendlyBattleCurrentProfile(generation);
      const hostSnapshot = buildFriendlyBattlePartySnapshot(hostProfile);
      ownSnapshot = hostSnapshot;
      const hostTeam = createBattleTeamFromFriendlyBattleSnapshot(hostSnapshot);
      const guestTeam = createBattleTeamFromFriendlyBattleSnapshot(joined.guestSnapshot);

      const battleId = randomUUID();
      const { runtime: rt, events: initEvents } = createFriendlyBattleBattleRuntime({
        battleId,
        hostTeam,
        guestTeam,
      });
      runtime = rt;

      // Ready up
      host_transport.markHostReady();
      await host_transport.waitUntilCanStart(timeoutMs);
      record.phase = 'ready';
      writeRecord();

      await host_transport.startBattle(battleId);
      record.phase = 'battle';
      record.status = 'select_action';
      writeRecord();

      // Send initial events to guest over TCP
      host_transport.sendBattleEvents(initEvents);

      // Push init events to local queue
      for (const event of initEvents) {
        localEventQueue.push(event);
      }

      // ---------------------------------------------------------------------------
      // Host turn loop
      // ---------------------------------------------------------------------------
      while (runtime.phase !== 'completed') {
        // Consult the adapter to learn which roles still need to submit this turn.
        // During awaiting_fainted_switch only the fainted side(s) submit; both
        // submit during normal turns. Skipping the non-waiting side avoids the
        // "not waiting for X" error that the unconditional Promise.all caused.
        const waitingFor = getFriendlyBattleWaitingForRoles(runtime);

        const hostPromise = waitingFor.includes('host')
          ? localActionQueue.shift(TURN_LOOP_TIMEOUT_MS, 'host action')
          : Promise.resolve(null as FriendlyBattleChoiceEnvelope | null);

        const guestPromise = waitingFor.includes('guest')
          ? host_transport.waitForGuestChoice(TURN_LOOP_TIMEOUT_MS)
          : Promise.resolve(null as FriendlyBattleChoiceEnvelope | null);

        const [hostEnvelope, guestEnvelope] = await Promise.all([hostPromise, guestPromise]);

        // Submit whichever side(s) actually had pending actions this turn.
        // The final submit (when all required roles have submitted) returns the
        // resolved event list; earlier submits return [].
        let resolvedEvents: FriendlyBattleBattleEvent[] = [];
        if (hostEnvelope) resolvedEvents = submitFriendlyBattleChoice(runtime, hostEnvelope);
        if (guestEnvelope) resolvedEvents = submitFriendlyBattleChoice(runtime, guestEnvelope);

        // Send to guest BEFORE pushing locally so the guest is no later than
        // the host on event arrival. Pushing locally first allowed the host
        // skill's wait_next_event to surface the new envelope and prompt for
        // a fresh action while the guest still hadn't received the previous
        // turn's events — eventually causing the battle-adapter to reject a
        // stale guest envelope with "not waiting for X". (Codex adversarial
        // review Q1 RISK.)
        host_transport.sendBattleEvents(resolvedEvents);
        for (const event of resolvedEvents) {
          localEventQueue.push(event);
        }

        // Check if battle is over
        const finished = resolvedEvents.find((e) => e.type === 'battle_finished');
        if (finished) {
          record.phase = 'finished';
          record.status = eventStatus(finished, role);
          writeRecord();
          break;
        }
      }

      // If runtime completed but we didn't catch battle_finished (shouldn't happen)
      if (runtime.phase === 'completed' && record.phase !== 'finished') {
        record.phase = 'finished';
        writeRecord();
      }

      await host_transport.close().catch(() => undefined);
      await shutdown(0, 'finished');
    } catch (err) {
      process.stderr.write(`daemon host error: ${(err as Error).message}\n`);
      // Push a synthetic battle_finished event so any pending wait_next_event
      // on this side returns a clean "opponent left" envelope instead of hanging.
      localEventQueue.push({
        type: 'battle_finished',
        winner: null,
        reason: 'disconnect',
      });
      await host_transport.close().catch(() => undefined);
      await shutdown(1, 'aborted');
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Guest path
  // ---------------------------------------------------------------------------
  const guestProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);
  ownSnapshot = guestSnapshot;

  const guest_transport = await connectFriendlyBattleSpikeGuest({
    host,
    port,
    sessionCode,
    guestPlayerName: playerName,
    generation,
    guestSnapshot,
    timeoutMs,
  });

  // Register transport closer so the leave IPC handler can tear down TCP.
  transportClose = () => guest_transport.close();

  // Signal ready to parent — guest doesn't emit a port
  process.stdout.write(`DAEMON_READY ${sessionId} ${socketPath}\n`);

  try {
    await guest_transport.markReady();
    record.phase = 'ready';
    record.status = 'connecting';
    writeRecord();

    const started = await guest_transport.waitForStarted(timeoutMs);
    record.phase = 'battle';
    record.status = 'select_action';
    writeRecord();

    // We don't actually need the battleId from started for anything, but keep
    // the variable to silence unused-import TS noise
    void started;

    // Drain the TCP init events (battle_initialized + choices_requested) that
    // the host sent before the guest connected. These are buffered in the TCP
    // transport and must be flushed into the local event queue NOW so they are
    // not interleaved with the real turn-resolution events that arrive after the
    // guest's first action.  We drain until the first choices_requested event,
    // which mirrors the inner-pump exit condition used inside the turn loop.
    //
    // Before this drain the guest has no events in localEventQueue. After it,
    // the queue contains the real initial events from the host (battle_initialized
    // + choices_requested(waiting_for_choices)) so the first wait_next_event call
    // from the IPC client returns the correct event.
    {
      let initDone = false;
      while (!initDone) {
        const initEvent = await guest_transport.waitForBattleEvent(timeoutMs);
        localEventQueue.push(initEvent);
        if (initEvent.type === 'choices_requested' || initEvent.type === 'battle_finished') {
          initDone = true;
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Guest turn loop — two independent coroutines because incoming TCP events
    // and outgoing local actions are not always paired turn-by-turn. The
    // previous single-loop design (await action; submit; pump events) blocked
    // the TCP pump while waiting for a local action, so a host-initiated event
    // (e.g. host's forced switch resolving without any guest input) would sit
    // in the TCP buffer until the guest user took an action — leaving the
    // guest skill watching an empty envelope queue indefinitely. Split into:
    //
    //   tcpPump   — continuously drains incoming battle events into the local
    //               event queue, no matter whether a guest action is pending.
    //   actionPump — continuously pulls local actions and submits them via TCP,
    //                no matter whether host has just sent unrelated events.
    //
    // They share the `battleFinished` flag (set by tcpPump on battle_finished)
    // so actionPump can exit cleanly. Promise.race waits for either to finish
    // (clean battle end OR error), and the existing catch handles both cases.
    // ---------------------------------------------------------------------------
    let battleFinished = false;
    const tcpPump = (async () => {
      while (!battleFinished) {
        const event = await guest_transport.waitForBattleEvent(TURN_LOOP_TIMEOUT_MS);
        localEventQueue.push(event);
        if (event.type === 'battle_finished') {
          battleFinished = true;
          // Route through eventStatus so voluntary leave / peer disconnect
          // map to 'aborted' instead of being silently downgraded to 'defeat'
          // (disconnect has winner=null, which the old strict-equality check
          // treated as a loss for the guest).
          record.phase = eventStatus(event, 'guest') === 'aborted' ? 'aborted' : 'finished';
          record.status = eventStatus(event, 'guest');
          writeRecord();
          // Unblock any pending action shift so actionPump can exit.
          localActionQueue.fail(new Error('guest battle finished'));
          return;
        }
      }
    })();

    const actionPump = (async () => {
      while (!battleFinished) {
        let myAction: FriendlyBattleChoiceEnvelope;
        try {
          myAction = await localActionQueue.shift(TURN_LOOP_TIMEOUT_MS, 'guest action');
        } catch (err) {
          // Queue failed (battle finished, daemon shutting down) — exit cleanly
          if (battleFinished) return;
          throw err;
        }
        await guest_transport.submitChoice(formatFriendlyBattleChoice(myAction.choice));
      }
    })();

    await Promise.race([tcpPump, actionPump]);
    // Wait for both to settle before falling through to shutdown
    await Promise.allSettled([tcpPump, actionPump]);

    await guest_transport.close().catch(() => undefined);
    await shutdown(0, 'finished');
  } catch (err) {
    process.stderr.write(`daemon guest error: ${(err as Error).message}\n`);
    // Push a synthetic battle_finished event so any pending wait_next_event
    // on this side returns a clean "opponent left" envelope instead of hanging.
    localEventQueue.push({
      type: 'battle_finished',
      winner: null,
      reason: 'disconnect',
    });
    await guest_transport.close().catch(() => undefined);
    await shutdown(1, 'aborted');
  }
}

// Re-export for test: parse the options JSON and run
export async function startDaemon(role: FriendlyBattleRole, options: DaemonOptions): Promise<void> {
  return runDaemon(role, options);
}

// ---------------------------------------------------------------------------
// CLI entry point (for `tsx daemon.ts --role host|guest --options-json <b64>`)
// ---------------------------------------------------------------------------

function parseCliOptions(argv: string[]): { role: FriendlyBattleRole; options: DaemonOptions } {
  let role: FriendlyBattleRole | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--role' && argv[i + 1]) {
      const r = argv[++i];
      if (r !== 'host' && r !== 'guest') {
        process.stderr.write(`daemon: --role must be 'host' or 'guest', got ${JSON.stringify(r)}\n`);
        process.exit(1);
      }
      role = r as FriendlyBattleRole;
    }
  }

  if (!role) {
    process.stderr.write('daemon: missing --role\n');
    process.exit(1);
  }

  const optionsB64 = process.env.TKM_FB_OPTIONS_B64;
  if (!optionsB64) {
    process.stderr.write('daemon: missing TKM_FB_OPTIONS_B64 environment variable\n');
    process.exit(1);
  }

  let options: DaemonOptions;
  try {
    const decoded = Buffer.from(optionsB64, 'base64').toString('utf8');
    options = JSON.parse(decoded) as DaemonOptions;
  } catch (err) {
    process.stderr.write(`daemon: failed to decode TKM_FB_OPTIONS_B64: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Re-validate filesystem-sensitive identifiers even though the CLI wrapper
  // already does so. The daemon is normally launched by our own CLI, but
  // validating here keeps the path-containment story intact if anything
  // ever spawns the daemon directly with a crafted TKM_FB_OPTIONS_B64.
  const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
  for (const [field, value] of [
    ['sessionId', options.sessionId],
    ['generation', options.generation],
    ['sessionCode', options.sessionCode],
  ] as const) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
      process.stderr.write(`daemon: invalid ${field} in decoded options\n`);
      process.exit(1);
    }
  }

  return { role, options };
}

const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  const { role, options } = parseCliOptions(process.argv.slice(2));
  runDaemon(role, options).catch((err: unknown) => {
    process.stderr.write(`daemon fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
