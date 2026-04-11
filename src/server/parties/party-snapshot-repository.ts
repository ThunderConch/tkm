import type { PvpGeneration } from '../rules/index.js';
import type { ActivePartySnapshot } from './party-types.js';

export interface PartySnapshotRepository {
  getActiveSnapshot(playerId: string, generation: PvpGeneration): ActivePartySnapshot | undefined;
  listSnapshots(playerId: string, generation: PvpGeneration): readonly ActivePartySnapshot[];
  replaceActiveSnapshot(snapshot: ActivePartySnapshot): void;
  createSnapshotId(generation: PvpGeneration): string;
  getNextSnapshotVersion(playerId: string, generation: PvpGeneration): number;
  seedSnapshots(snapshots: readonly ActivePartySnapshot[]): void;
}

function createRepositoryKey(playerId: string, generation: PvpGeneration): string {
  return `${playerId}:${generation}`;
}

function extractSnapshotSequence(snapshotId: string): number | undefined {
  const matched = /^ops_gen\d+_(\d{6})$/.exec(snapshotId);
  if (!matched) {
    return undefined;
  }

  return Number(matched[1]);
}

export class InMemoryPartySnapshotRepository implements PartySnapshotRepository {
  private readonly snapshotsByKey = new Map<string, ActivePartySnapshot[]>();

  private readonly sequenceByGeneration = new Map<PvpGeneration, number>();

  getActiveSnapshot(playerId: string, generation: PvpGeneration): ActivePartySnapshot | undefined {
    return this.snapshotsByKey
      .get(createRepositoryKey(playerId, generation))
      ?.find((snapshot) => snapshot.isActive);
  }

  listSnapshots(playerId: string, generation: PvpGeneration): readonly ActivePartySnapshot[] {
    return this.snapshotsByKey.get(createRepositoryKey(playerId, generation)) ?? [];
  }

  replaceActiveSnapshot(snapshot: ActivePartySnapshot): void {
    const key = createRepositoryKey(snapshot.playerId, snapshot.generation);
    const existingSnapshots = this.snapshotsByKey.get(key) ?? [];
    const deactivatedSnapshots = existingSnapshots.map((existingSnapshot) => ({
      ...existingSnapshot,
      isActive: false,
    }));

    this.snapshotsByKey.set(key, [...deactivatedSnapshots, { ...snapshot, isActive: true }]);
    this.syncSequence(snapshot);
  }

  createSnapshotId(generation: PvpGeneration): string {
    const nextSequence = (this.sequenceByGeneration.get(generation) ?? 0) + 1;
    this.sequenceByGeneration.set(generation, nextSequence);

    return `ops_${generation}_${String(nextSequence).padStart(6, '0')}`;
  }

  getNextSnapshotVersion(playerId: string, generation: PvpGeneration): number {
    const snapshots = this.snapshotsByKey.get(createRepositoryKey(playerId, generation)) ?? [];
    const highestVersion = snapshots.reduce(
      (currentHighest, snapshot) => Math.max(currentHighest, snapshot.snapshotVersion),
      0,
    );

    return highestVersion + 1;
  }

  seedSnapshots(snapshots: readonly ActivePartySnapshot[]): void {
    const nextSnapshotsByKey = new Map(this.snapshotsByKey);

    for (const snapshot of snapshots) {
      const key = createRepositoryKey(snapshot.playerId, snapshot.generation);
      const seededSnapshots = nextSnapshotsByKey.get(key) ?? [];

      if (snapshot.isActive) {
        nextSnapshotsByKey.set(
          key,
          [...seededSnapshots.map((existingSnapshot) => ({ ...existingSnapshot, isActive: false })), snapshot],
        );
      } else {
        nextSnapshotsByKey.set(key, [...seededSnapshots, snapshot]);
      }

      this.syncSequence(snapshot);
    }

    this.snapshotsByKey.clear();
    for (const [key, seededSnapshots] of nextSnapshotsByKey.entries()) {
      this.snapshotsByKey.set(key, seededSnapshots.map((snapshot) => ({ ...snapshot })));
    }
  }

  private syncSequence(snapshot: ActivePartySnapshot): void {
    const sequence = extractSnapshotSequence(snapshot.snapshotId);
    if (!sequence) {
      return;
    }

    const currentSequence = this.sequenceByGeneration.get(snapshot.generation) ?? 0;
    if (sequence > currentSequence) {
      this.sequenceByGeneration.set(snapshot.generation, sequence);
    }
  }
}
