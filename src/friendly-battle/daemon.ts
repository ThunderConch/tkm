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
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createFriendlyBattleSpikeHost,
  connectFriendlyBattleSpikeGuest,
} from './spike/tcp-direct.js';
import {
  createFriendlyBattleBattleRuntime,
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
  FriendlyBattleRole,
  FriendlyBattlePartySnapshot,
} from './contracts.js';
import type { FriendlyBattleBattleRuntime } from './battle-adapter.js';

// ---------------------------------------------------------------------------
// Minimal AsyncQueue — copied from tcp-direct.ts so this module is self-contained
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  fail(error: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  shift(timeoutMs: number, label: string): Promise<T> {
    if (this.values.length > 0) {
      return Promise.resolve(this.values.shift() as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
      } as {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        timer?: NodeJS.Timeout;
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  get size(): number {
    return this.values.length;
  }
}

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

// ---------------------------------------------------------------------------
// Helpers: convert BattleEvents → turn-json fields
// ---------------------------------------------------------------------------

function buildMoveOptionsFromSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleTurnMoveOption[] {
  // find the first alive pokemon (slot 0 is the active one for a fresh battle)
  const active = snapshot.pokemon.slice().sort((a, b) => a.slot - b.slot)[0];
  if (!active) return [];
  return active.moves.map((move, index) => ({
    index,
    nameKo: move.name ?? `Move ${index + 1}`,
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
  return active.moves.map((move, index) => ({
    index,
    nameKo: move.data.nameKo ?? move.data.name ?? `Move ${index + 1}`,
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
  return team.pokemon.map((pokemon, index) => ({
    index,
    name: pokemon.displayName ?? `Pokemon ${index + 1}`,
    hp: pokemon.currentHp,
    maxHp: pokemon.maxHp,
    fainted: pokemon.fainted,
  }));
}

function buildPartyOptionsFromSnapshot(
  snapshot: FriendlyBattlePartySnapshot,
): FriendlyBattleTurnPartyOption[] {
  return snapshot.pokemon.map((pokemon, index) => ({
    index,
    name: pokemon.displayName,
    hp: pokemon.baseStats.hp,
    maxHp: pokemon.baseStats.hp,
    fainted: false,
  }));
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
    case 'battle_initialized':
      return {
        questionContext: 'Battle started!',
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : (ownSnapshot ? buildPartyOptionsFromSnapshot(ownSnapshot) : []),
        animationFrames: [{ kind: 'message', text: 'Battle started!', durationMs: 300 }],
        currentFrameIndex: 0,
      };
    case 'choices_requested': {
      const moveOptions = runtime
        ? buildMoveOptionsFromRuntime(runtime, role)
        : (ownSnapshot ? buildMoveOptionsFromSnapshot(ownSnapshot) : []);
      const partyOptions = runtime
        ? buildPartyOptionsFromRuntime(runtime, role)
        : (ownSnapshot ? buildPartyOptionsFromSnapshot(ownSnapshot) : []);
      return {
        questionContext: `Turn ${event.turn}: Choose your action`,
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
      return {
        questionContext: event.messages.join(' '),
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: frames,
        currentFrameIndex: 0,
      };
    }
    case 'battle_finished':
      return {
        questionContext: event.winner === role ? 'You won!' : 'You lost!',
        moveOptions: [],
        partyOptions: runtime ? buildPartyOptionsFromRuntime(runtime, role) : [],
        animationFrames: [],
        currentFrameIndex: 0,
      };
  }
}

function eventStatus(
  event: FriendlyBattleBattleEvent,
  role: FriendlyBattleRole,
): FriendlyBattleSessionRecord['status'] {
  switch (event.type) {
    case 'battle_initialized':
      return 'ongoing';
    case 'choices_requested':
      return event.phase === 'awaiting_fainted_switch' ? 'fainted_switch' : 'select_action';
    case 'turn_resolved':
      return 'ongoing';
    case 'battle_finished':
      return event.winner === role ? 'victory' : 'defeat';
  }
}

// ---------------------------------------------------------------------------
// Serialize a DaemonAction for use with connectFriendlyBattleSpikeGuest.submitChoice
// ---------------------------------------------------------------------------

function serializeDaemonAction(action: DaemonAction): string {
  switch (action.kind) {
    case 'move':
      return `move:${action.index}`;
  }
}

// ---------------------------------------------------------------------------
// Main daemon entry
// ---------------------------------------------------------------------------

async function runDaemon(role: FriendlyBattleRole, options: DaemonOptions): Promise<void> {
  const { sessionId, sessionCode, host, port, generation, playerName, timeoutMs } = options;

  // Derive the socket path — lives in the same dir as session records
  const sessionsDir = friendlyBattleSessionsDir(generation);
  mkdirSync(sessionsDir, { recursive: true });
  const socketPath = join(sessionsDir, `${sessionId}.sock`);

  const nowIso = () => new Date().toISOString();

  // ---------------------------------------------------------------------------
  // Event queue (delivered to UNIX socket wait_next_event callers)
  // Action queue (populated by UNIX socket submit_action callers)
  // ---------------------------------------------------------------------------
  const localEventQueue = new AsyncQueue<FriendlyBattleBattleEvent>();
  const localActionQueue = new AsyncQueue<FriendlyBattleChoiceEnvelope>();

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
        const event = await localEventQueue.shift(req.timeoutMs, 'wait_next_event');
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
    }
  }

  // ---------------------------------------------------------------------------
  // Start the IPC server before doing anything else so DAEMON_READY can fire
  // ---------------------------------------------------------------------------
  const ipcServer = await createDaemonIpcServer(socketPath, ipcHandler);

  // Signal to parent that we're ready
  process.stdout.write(`DAEMON_READY ${sessionId} ${socketPath}\n`);

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
    localEventQueue.fail(new Error('daemon shutting down'));
    localActionQueue.fail(new Error('daemon shutting down'));
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

    try {
      // Handshake
      record.phase = 'waiting_for_guest';
      record.status = 'waiting_for_guest';
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
        // Wait for both host action (from UNIX socket) and guest choice (from TCP)
        const [hostEnvelope, guestEnvelope] = await Promise.all([
          localActionQueue.shift(timeoutMs, 'host action'),
          host_transport.waitForGuestChoice(timeoutMs),
        ]);

        // submitFriendlyBattleChoice requires two calls; first returns [], second returns events
        submitFriendlyBattleChoice(runtime, hostEnvelope);
        const resolvedEvents = submitFriendlyBattleChoice(runtime, guestEnvelope);

        // Push events to local queue and send to guest
        for (const event of resolvedEvents) {
          localEventQueue.push(event);
        }
        host_transport.sendBattleEvents(resolvedEvents);

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

  try {
    await guest_transport.markReady();
    record.phase = 'ready';
    record.status = 'connecting';
    writeRecord();

    const started = await guest_transport.waitForStarted(timeoutMs);
    record.phase = 'battle';
    record.status = 'select_action';
    writeRecord();

    // Synthesize an initial choices_requested event from own snapshot so the
    // guest has something to display before the first real TCP event arrives.
    const initialChoicesEvent: FriendlyBattleBattleEvent = {
      type: 'choices_requested',
      turn: 1,
      waitingFor: ['host', 'guest'],
      phase: 'waiting_for_choices',
    };
    localEventQueue.push(initialChoicesEvent);

    // We don't actually need the battleId from started for anything, but keep
    // the variable to silence unused-import TS noise
    void started;

    // ---------------------------------------------------------------------------
    // Guest turn loop
    // ---------------------------------------------------------------------------
    let battleFinished = false;
    while (!battleFinished) {
      // Wait for the local player to submit an action via UNIX socket
      const myAction = await localActionQueue.shift(timeoutMs, 'guest action');

      // Forward to host over TCP using the parsed choice from the envelope
      await guest_transport.submitChoice(formatFriendlyBattleChoice(myAction.choice));

      // Pump events from TCP until we see choices_requested or battle_finished
      let turnDone = false;
      while (!turnDone) {
        const event = await guest_transport.waitForBattleEvent(timeoutMs);
        localEventQueue.push(event);
        if (event.type === 'battle_finished') {
          battleFinished = true;
          turnDone = true;
          record.phase = 'finished';
          record.status = event.winner === 'guest' ? 'victory' : 'defeat';
          writeRecord();
        } else if (event.type === 'choices_requested') {
          turnDone = true;
        }
        // turn_resolved: keep pumping (battle_finished or choices_requested will follow)
      }
    }

    await guest_transport.close().catch(() => undefined);
    await shutdown(0, 'finished');
  } catch (err) {
    process.stderr.write(`daemon guest error: ${(err as Error).message}\n`);
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
  let optionsJson: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--role' && argv[i + 1]) {
      const r = argv[++i];
      if (r !== 'host' && r !== 'guest') {
        process.stderr.write(`daemon: --role must be 'host' or 'guest', got ${JSON.stringify(r)}\n`);
        process.exit(1);
      }
      role = r as FriendlyBattleRole;
    } else if (argv[i] === '--options-json' && argv[i + 1]) {
      optionsJson = argv[++i];
    }
  }

  if (!role) {
    process.stderr.write('daemon: missing --role\n');
    process.exit(1);
  }
  if (!optionsJson) {
    process.stderr.write('daemon: missing --options-json\n');
    process.exit(1);
  }

  let options: DaemonOptions;
  try {
    const decoded = Buffer.from(optionsJson, 'base64').toString('utf8');
    options = JSON.parse(decoded) as DaemonOptions;
  } catch (err) {
    process.stderr.write(`daemon: failed to decode --options-json: ${(err as Error).message}\n`);
    process.exit(1);
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
