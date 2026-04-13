import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDefaultConfig, readConfig } from '../core/config.js';
import { getActiveGeneration } from '../core/paths.js';
import { hydrateState, readState } from '../core/state.js';
import type { Config, State } from '../core/types.js';
import {
  createFriendlyBattleBattleRuntime,
  submitFriendlyBattleChoice,
  toFriendlyBattleBattleRef,
  type FriendlyBattleBattleRuntime,
} from './battle-adapter.js';
import {
  createFriendlyBattleReadyState,
  createFriendlyBattleSessionState,
  type FriendlyBattleBattleEvent,
  type FriendlyBattleChoice,
  type FriendlyBattleChoiceEnvelope,
  type FriendlyBattleRole,
  type FriendlyBattleSessionState,
} from './contracts.js';
import {
  friendlyBattleBattlePath,
  friendlyBattleSessionPath,
  friendlyBattleSnapshotPath,
} from './paths.js';
import {
  buildFriendlyBattlePartySnapshot,
  buildFriendlyBattleProgressionRef,
  buildFriendlyBattleProgressionRefFromSnapshot,
  createBattleTeamFromFriendlyBattleSnapshot,
  assertValidFriendlyBattlePartySnapshot,
  toFriendlyBattleSnapshotRef,
} from './snapshot.js';
import type { FriendlyBattlePartySnapshot } from './contracts.js';

export interface FriendlyBattleLoadedProfile {
  configDir?: string;
  generation: string;
  config: Config;
  state: State;
}

export interface FriendlyBattleLocalArtifacts {
  sessionId: string;
  battleId: string;
  generation: string;
  session: FriendlyBattleSessionState;
  hostSnapshotPath: string;
  guestSnapshotPath: string | null;
  sessionPath: string;
  battlePath: string;
}

export interface FriendlyBattleLocalBattleArtifacts {
  runtime: FriendlyBattleBattleRuntime;
  events: FriendlyBattleBattleEvent[];
}

export interface FriendlyBattleLocalChoiceRequest {
  role: 'host' | 'guest';
  turn: number;
  phase: FriendlyBattleBattleRuntime['phase'];
  artifacts: FriendlyBattleLocalArtifacts;
  runtime: FriendlyBattleBattleRuntime;
}

export type FriendlyBattleLocalChoiceProvider = (
  request: FriendlyBattleLocalChoiceRequest,
) => string | Promise<string>;

export function loadFriendlyBattleCurrentProfile(generation?: string): FriendlyBattleLoadedProfile {
  const resolvedGeneration = generation ?? getActiveGeneration();
  return {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    generation: resolvedGeneration,
    config: readConfig(resolvedGeneration),
    state: readState(resolvedGeneration),
  };
}

export function loadFriendlyBattleProfileFromConfigDir(
  configDir: string,
  generation?: string,
): FriendlyBattleLoadedProfile {
  const resolvedGeneration = generation ?? resolveGenerationFromConfigDir(configDir);
  const tokenmonDir = join(configDir, 'tokenmon');
  const configPath = join(tokenmonDir, resolvedGeneration, 'config.json');
  const externalStatePath = join(tokenmonDir, resolvedGeneration, 'state.json');

  return {
    configDir,
    generation: resolvedGeneration,
    config: mergeConfigWithDefaults(readJsonFile<Config>(configPath)),
    state: hydrateState(readJsonFile<State>(externalStatePath), {
      gen: resolvedGeneration,
      stateFilePath: externalStatePath,
    }),
  };
}

export function createFriendlyBattleLocalArtifacts(input: {
  hostProfile: FriendlyBattleLoadedProfile;
  sessionCode: string;
  hostPlayerName: string;
  guestPlayerName?: string;
}): FriendlyBattleLocalArtifacts {
  const generation = input.hostProfile.generation;

  const hostProgression = buildFriendlyBattleProgressionRef(input.hostProfile);
  const hostSnapshot = buildFriendlyBattlePartySnapshot(input.hostProfile);

  const sessionId = randomUUID();
  const battleId = randomUUID();
  const createdAt = new Date().toISOString();
  const session = createFriendlyBattleSessionState({
    sessionId,
    sessionCode: input.sessionCode,
    generation,
    hostPlayerName: input.hostPlayerName,
    hostProgression,
    createdAt,
  });

  session.hostSnapshot = toFriendlyBattleSnapshotRef(hostSnapshot);
  session.guest.playerName = input.guestPlayerName ?? 'Guest';
  session.guestProgression = null;
  session.guestSnapshot = null;
  session.updatedAt = createdAt;

  const artifacts: FriendlyBattleLocalArtifacts = {
    sessionId,
    battleId,
    generation,
    session,
    sessionPath: friendlyBattleSessionPath(sessionId, generation),
    hostSnapshotPath: friendlyBattleSnapshotPath(hostSnapshot.snapshotId, generation),
    guestSnapshotPath: null,
    battlePath: friendlyBattleBattlePath(battleId, generation),
  };

  writeJsonAtomic(artifacts.hostSnapshotPath, hostSnapshot);
  writeJsonAtomic(artifacts.sessionPath, session);

  return artifacts;
}

export function attachFriendlyBattleGuestSnapshot(
  artifacts: FriendlyBattleLocalArtifacts,
  input: {
    guestPlayerName: string;
    guestSnapshot: FriendlyBattlePartySnapshot;
  },
): void {
  assertValidFriendlyBattlePartySnapshot(input.guestSnapshot);
  if (input.guestSnapshot.generation !== artifacts.generation) {
    throw new Error(
      `Friendly battle local harness generation mismatch: host=${artifacts.generation} guest=${input.guestSnapshot.generation}`,
    );
  }

  const guestProgression = buildFriendlyBattleProgressionRefFromSnapshot(input.guestSnapshot);
  const guestSnapshotPath = friendlyBattleSnapshotPath(
    input.guestSnapshot.snapshotId,
    artifacts.generation,
  );

  writeJsonAtomic(guestSnapshotPath, input.guestSnapshot);

  artifacts.session.phase = 'awaiting_ready';
  artifacts.session.updatedAt = new Date().toISOString();
  artifacts.session.guest.playerName = input.guestPlayerName;
  artifacts.session.guest.connectionState = 'connected';
  artifacts.session.guestProgression = guestProgression;
  artifacts.session.guestSnapshot = toFriendlyBattleSnapshotRef(input.guestSnapshot);
  writeJsonAtomic(artifacts.sessionPath, artifacts.session);
  artifacts.guestSnapshotPath = guestSnapshotPath;
}

export function markFriendlyBattleReady(
  artifacts: FriendlyBattleLocalArtifacts,
  readyState: { hostReady: boolean; guestReady: boolean; canStart: boolean },
): void {
  artifacts.session.phase = readyState.canStart ? 'battle_starting' : 'awaiting_ready';
  artifacts.session.updatedAt = new Date().toISOString();
  artifacts.session.host.ready = readyState.hostReady;
  artifacts.session.guest.ready = readyState.guestReady;
  artifacts.session.readyState = createFriendlyBattleReadyState(readyState.hostReady, readyState.guestReady);
  writeJsonAtomic(artifacts.sessionPath, artifacts.session);
}

export function startFriendlyBattleLocalBattle(
  artifacts: FriendlyBattleLocalArtifacts,
): FriendlyBattleLocalBattleArtifacts {
  if (!artifacts.guestSnapshotPath) {
    throw new Error(
      'Friendly battle local harness cannot start battle before guest snapshot is attached',
    );
  }

  const { runtime, events } = createFriendlyBattleBattleRuntime({
    battleId: artifacts.battleId,
    hostTeam: createBattleTeamFromFriendlyBattleSnapshot(
      readFriendlyBattleSnapshotFile(artifacts.hostSnapshotPath),
    ),
    guestTeam: createBattleTeamFromFriendlyBattleSnapshot(
      readFriendlyBattleSnapshotFile(artifacts.guestSnapshotPath),
    ),
  });

  artifacts.session.phase = 'in_battle';
  artifacts.session.updatedAt = runtime.startedAt;
  artifacts.session.battle = toFriendlyBattleBattleRef(runtime);
  writeJsonAtomic(artifacts.sessionPath, artifacts.session);
  const battleArtifacts: FriendlyBattleLocalBattleArtifacts = {
    runtime,
    events: [...events],
  };

  writeJsonAtomic(artifacts.battlePath, {
    layer: 'battle',
    battleId: runtime.battleId,
    generation: artifacts.generation,
    createdAt: runtime.startedAt,
    battle: toFriendlyBattleBattleRef(runtime),
    events: battleArtifacts.events,
  });

  return battleArtifacts;
}

export function submitFriendlyBattleLocalChoice(input: {
  artifacts: FriendlyBattleLocalArtifacts;
  battle: FriendlyBattleLocalBattleArtifacts;
  envelope: FriendlyBattleChoiceEnvelope;
}): FriendlyBattleBattleEvent[] {
  const events = submitFriendlyBattleChoice(input.battle.runtime, input.envelope);
  input.battle.events.push(...events);

  persistFriendlyBattleLocalBattleState({
    artifacts: input.artifacts,
    runtime: input.battle.runtime,
    updatedAt: input.envelope.submittedAt,
    appendEvents: events,
  });

  return events;
}

export async function resolveFriendlyBattleLocalBattleToCompletion(input: {
  artifacts: FriendlyBattleLocalArtifacts;
  runtime: FriendlyBattleBattleRuntime;
  chooseHostAction: FriendlyBattleLocalChoiceProvider;
  chooseGuestAction: FriendlyBattleLocalChoiceProvider;
  maxChoices?: number;
}): Promise<FriendlyBattleBattleEvent[]> {
  const allEvents = readPersistedFriendlyBattleEvents(input.artifacts.battlePath);
  let remainingChoices = input.maxChoices ?? 200;

  while (input.runtime.phase !== 'completed') {
    const waitingFor = getWaitingForLocalBattle(input.runtime);
    if (waitingFor.length === 0) {
      throw new Error('Friendly battle local harness could not determine the next waiting actor');
    }

    for (const role of waitingFor) {
      remainingChoices -= 1;
      if (remainingChoices < 0) {
        throw new Error('Friendly battle local harness exceeded the max choice budget before completion');
      }

      const chooseAction = role === 'host' ? input.chooseHostAction : input.chooseGuestAction;
      const submittedAt = new Date().toISOString();
      const actionValue = await chooseAction({
        role,
        turn: input.runtime.state.turn + 1,
        phase: input.runtime.phase,
        artifacts: input.artifacts,
        runtime: input.runtime,
      });
      const events = submitFriendlyBattleChoice(
        input.runtime,
        createFriendlyBattleChoiceEnvelope(role, actionValue, submittedAt),
      );

      if (events.length > 0) {
        allEvents.push(...events);
      }

      persistFriendlyBattleLocalBattleState({
        artifacts: input.artifacts,
        runtime: input.runtime,
        updatedAt: submittedAt,
        appendEvents: events,
        eventHistory: allEvents,
      });
    }
  }

  return allEvents;
}

export function cleanupFriendlyBattleLocalArtifacts(artifacts: FriendlyBattleLocalArtifacts): void {
  const paths = [
    artifacts.sessionPath,
    artifacts.hostSnapshotPath,
    artifacts.battlePath,
  ];
  if (artifacts.guestSnapshotPath) {
    paths.push(artifacts.guestSnapshotPath);
  }

  for (const path of paths) {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
}

export function createFriendlyBattleChoiceEnvelope(
  actor: FriendlyBattleRole,
  value: string,
  submittedAt = new Date().toISOString(),
): FriendlyBattleChoiceEnvelope {
  return {
    actor,
    submittedAt,
    choice: parseFriendlyBattleChoice(value),
  };
}

export function parseFriendlyBattleChoice(value: string): FriendlyBattleChoice {
  const moveMatch = value.match(/^move:(\d+)$/);
  if (moveMatch) {
    return { type: 'move', moveIndex: Number(moveMatch[1]) };
  }

  const switchMatch = value.match(/^switch:(\d+)$/);
  if (switchMatch) {
    return { type: 'switch', pokemonIndex: Number(switchMatch[1]) };
  }

  if (value === 'surrender') {
    return { type: 'surrender' };
  }

  throw new Error(`Unsupported friendly battle local action: ${value}`);
}

export function formatFriendlyBattleChoice(choice: FriendlyBattleChoice): string {
  switch (choice.type) {
    case 'move':
      return `move:${choice.moveIndex}`;
    case 'switch':
      return `switch:${choice.pokemonIndex}`;
    case 'surrender':
      return 'surrender';
  }
}

export function selectDeterministicFriendlyBattleChoiceValue(
  runtime: FriendlyBattleBattleRuntime,
  actor: FriendlyBattleRole,
): string {
  const team = actor === 'host' ? runtime.state.player : runtime.state.opponent;

  if (runtime.phase === 'awaiting_fainted_switch') {
    const switchIndex = team.pokemon.findIndex(
      (pokemon, index) => index !== team.activeIndex && !pokemon.fainted,
    );
    return switchIndex >= 0 ? `switch:${switchIndex}` : 'surrender';
  }

  const activePokemon = team.pokemon[team.activeIndex];
  const moveIndex = activePokemon?.moves.findIndex((move) => move.currentPp > 0) ?? -1;
  if (moveIndex >= 0) {
    return `move:${moveIndex}`;
  }

  const switchIndex = team.pokemon.findIndex(
    (pokemon, index) => index !== team.activeIndex && !pokemon.fainted,
  );
  return switchIndex >= 0 ? `switch:${switchIndex}` : 'surrender';
}

function resolveGenerationFromConfigDir(configDir: string): string {
  const path = join(configDir, 'tokenmon', 'global-config.json');
  const parsed = readJsonFile<{ active_generation?: string }>(path);
  return parsed?.active_generation ?? 'gen4';
}

function mergeConfigWithDefaults(parsed: Partial<Config> | null): Config {
  const defaults = getDefaultConfig();
  if (!parsed) {
    return defaults;
  }

  return {
    ...defaults,
    ...parsed,
    party: parsed.party ?? [],
  };
}

function readJsonFile<T>(path: string): Partial<T> | null {
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, 'utf8')) as Partial<T>;
}

function readFriendlyBattleSnapshotFile(path: string): FriendlyBattlePartySnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as FriendlyBattlePartySnapshot;
}

function readPersistedFriendlyBattleEvents(path: string): FriendlyBattleBattleEvent[] {
  if (!existsSync(path)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { events?: FriendlyBattleBattleEvent[] };
  return parsed.events ?? [];
}

function persistFriendlyBattleLocalBattleState(input: {
  artifacts: FriendlyBattleLocalArtifacts;
  runtime: FriendlyBattleBattleRuntime;
  updatedAt: string;
  appendEvents?: FriendlyBattleBattleEvent[];
  eventHistory?: FriendlyBattleBattleEvent[];
}): void {
  input.artifacts.session.updatedAt = input.updatedAt;
  input.artifacts.session.phase = input.runtime.phase === 'completed' ? 'completed' : 'in_battle';
  input.artifacts.session.pendingChoices = { ...input.runtime.pendingChoices };
  input.artifacts.session.battle = toFriendlyBattleBattleRef(input.runtime);

  const events = input.eventHistory
    ?? [
      ...readPersistedFriendlyBattleEvents(input.artifacts.battlePath),
      ...(input.appendEvents ?? []),
    ];

  writeJsonAtomic(input.artifacts.sessionPath, input.artifacts.session);
  writeJsonAtomic(input.artifacts.battlePath, {
    layer: 'battle',
    battleId: input.runtime.battleId,
    generation: input.artifacts.generation,
    createdAt: input.runtime.startedAt,
    battle: toFriendlyBattleBattleRef(input.runtime),
    events,
  });
}

function getWaitingForLocalBattle(
  runtime: FriendlyBattleBattleRuntime,
): Array<'host' | 'guest'> {
  if (runtime.phase === 'completed') {
    return [];
  }

  if (runtime.phase === 'waiting_for_choices') {
    return (['host', 'guest'] as const).filter(
      (role) => runtime.pendingChoices[role] === undefined,
    );
  }

  return (['host', 'guest'] as const).filter(
    (role) =>
      runtime.pendingChoices[role] === undefined
      && requiresForcedSwitchForRole(runtime, role),
  );
}

function requiresForcedSwitchForRole(
  runtime: FriendlyBattleBattleRuntime,
  role: 'host' | 'guest',
): boolean {
  const team = role === 'host' ? runtime.state.player : runtime.state.opponent;
  const activePokemon = team.pokemon[team.activeIndex];

  return activePokemon !== undefined
    && activePokemon.fainted
    && team.pokemon.some((pokemon, index) => index !== team.activeIndex && !pokemon.fainted);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tempPath, path);
}
