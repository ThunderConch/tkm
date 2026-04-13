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
  createBattleTeamFromFriendlyBattleSnapshot,
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
  guestSnapshotPath: string;
  sessionPath: string;
  battlePath: string;
}

export interface FriendlyBattleLocalBattleArtifacts {
  runtime: FriendlyBattleBattleRuntime;
  events: FriendlyBattleBattleEvent[];
}

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
  guestProfile: FriendlyBattleLoadedProfile;
  sessionCode: string;
  hostPlayerName: string;
  guestPlayerName?: string;
}): FriendlyBattleLocalArtifacts {
  const generation = input.hostProfile.generation;
  if (input.guestProfile.generation !== generation) {
    throw new Error(
      `Friendly battle local harness generation mismatch: host=${generation} guest=${input.guestProfile.generation}`,
    );
  }

  const hostProgression = buildFriendlyBattleProgressionRef(input.hostProfile);
  const guestProgression = buildFriendlyBattleProgressionRef(input.guestProfile);
  const hostSnapshot = buildFriendlyBattlePartySnapshot(input.hostProfile);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(input.guestProfile);

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
  session.guestProgression = guestProgression;
  session.guestSnapshot = toFriendlyBattleSnapshotRef(guestSnapshot);
  session.updatedAt = createdAt;

  const artifacts: FriendlyBattleLocalArtifacts = {
    sessionId,
    battleId,
    generation,
    session,
    sessionPath: friendlyBattleSessionPath(sessionId, generation),
    hostSnapshotPath: friendlyBattleSnapshotPath(hostSnapshot.snapshotId, generation),
    guestSnapshotPath: friendlyBattleSnapshotPath(guestSnapshot.snapshotId, generation),
    battlePath: friendlyBattleBattlePath(battleId, generation),
  };

  writeJsonAtomic(artifacts.hostSnapshotPath, hostSnapshot);
  writeJsonAtomic(artifacts.guestSnapshotPath, guestSnapshot);
  writeJsonAtomic(artifacts.sessionPath, session);

  return artifacts;
}

export function markFriendlyBattleGuestJoined(
  artifacts: FriendlyBattleLocalArtifacts,
  guestPlayerName: string,
): void {
  artifacts.session.phase = 'awaiting_ready';
  artifacts.session.updatedAt = new Date().toISOString();
  artifacts.session.guest.playerName = guestPlayerName;
  artifacts.session.guest.connectionState = 'connected';
  writeJsonAtomic(artifacts.sessionPath, artifacts.session);
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
  writeJsonAtomic(artifacts.battlePath, {
    layer: 'battle',
    battleId: runtime.battleId,
    generation: artifacts.generation,
    createdAt: runtime.startedAt,
    battle: toFriendlyBattleBattleRef(runtime),
    events,
  });

  return { runtime, events };
}

export function resolveFriendlyBattleLocalFirstTurn(input: {
  artifacts: FriendlyBattleLocalArtifacts;
  runtime: FriendlyBattleBattleRuntime;
  guestActionValue: string;
  hostActionValue: string;
}): FriendlyBattleBattleEvent[] {
  const submittedAt = new Date().toISOString();
  const guestEvents = submitFriendlyBattleChoice(input.runtime, createChoiceEnvelope('guest', input.guestActionValue, submittedAt));
  const hostEvents = submitFriendlyBattleChoice(input.runtime, createChoiceEnvelope('host', input.hostActionValue, submittedAt));
  const events = [...guestEvents, ...hostEvents];

  const resolved = events.some((event) => event.type === 'turn_resolved');
  if (!resolved) {
    throw new Error('Friendly battle local harness expected a turn_resolved event after first-turn exchange');
  }

  input.artifacts.session.updatedAt = submittedAt;
  input.artifacts.session.pendingChoices = {};
  input.artifacts.session.battle = toFriendlyBattleBattleRef(input.runtime);
  if (input.runtime.phase === 'completed') {
    input.artifacts.session.phase = 'completed';
  }

  writeJsonAtomic(input.artifacts.sessionPath, input.artifacts.session);
  writeJsonAtomic(input.artifacts.battlePath, {
    layer: 'battle',
    battleId: input.runtime.battleId,
    generation: input.artifacts.generation,
    createdAt: input.runtime.startedAt,
    battle: toFriendlyBattleBattleRef(input.runtime),
    events,
  });

  return events;
}

export function cleanupFriendlyBattleLocalArtifacts(artifacts: FriendlyBattleLocalArtifacts): void {
  for (const path of [
    artifacts.sessionPath,
    artifacts.hostSnapshotPath,
    artifacts.guestSnapshotPath,
    artifacts.battlePath,
  ]) {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
}

function createChoiceEnvelope(
  actor: 'host' | 'guest',
  value: string,
  submittedAt: string,
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

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tempPath, path);
}
