import { join } from 'path';
import { genUserDir } from '../core/paths.js';
import { FRIENDLY_BATTLE_NAMESPACE } from './contracts.js';

export function friendlyBattleRootDir(gen?: string): string {
  return join(genUserDir(gen), FRIENDLY_BATTLE_NAMESPACE);
}

export function friendlyBattleSessionsDir(gen?: string): string {
  return join(friendlyBattleRootDir(gen), 'sessions');
}

export function friendlyBattleSnapshotsDir(gen?: string): string {
  return join(friendlyBattleRootDir(gen), 'snapshots');
}

export function friendlyBattleBattlesDir(gen?: string): string {
  return join(friendlyBattleRootDir(gen), 'battles');
}

export function friendlyBattleSessionPath(sessionId: string, gen?: string): string {
  return join(friendlyBattleSessionsDir(gen), `${sessionId}.json`);
}

export function friendlyBattleSnapshotPath(snapshotId: string, gen?: string): string {
  return join(friendlyBattleSnapshotsDir(gen), `${snapshotId}.json`);
}

export function friendlyBattleBattlePath(battleId: string, gen?: string): string {
  return join(friendlyBattleBattlesDir(gen), `${battleId}.json`);
}
