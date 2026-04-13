import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type FriendlyBattlePhase =
  | 'waiting_for_guest'
  | 'handshake'
  | 'ready'
  | 'battle'
  | 'finished'
  | 'aborted';

export type FriendlyBattleStatus =
  | 'waiting_for_guest'
  | 'connecting'
  | 'ongoing'
  | 'select_action'
  | 'fainted_switch'
  | 'surrender_pending'
  | 'victory'
  | 'defeat'
  | 'aborted'
  | 'rejected';

export interface FriendlyBattleSessionRecord {
  sessionId: string;
  role: 'host' | 'guest';
  generation: string;
  sessionCode: string;
  phase: FriendlyBattlePhase;
  status: FriendlyBattleStatus;
  transport: { host: string; port: number };
  opponent: { playerName: string } | null;
  pid: number;
  createdAt: string;
  updatedAt: string;
}

function currentClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function friendlyBattleSessionsDir(generation: string): string {
  return join(currentClaudeDir(), 'tokenmon', generation, 'friendly-battle', 'sessions');
}

export function friendlyBattleSessionRecordPath(sessionId: string, generation: string): string {
  return join(friendlyBattleSessionsDir(generation), `${sessionId}.json`);
}

export function writeFriendlyBattleSessionRecord(record: FriendlyBattleSessionRecord): void {
  const path = friendlyBattleSessionRecordPath(record.sessionId, record.generation);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmpPath, path);
}

export function readFriendlyBattleSessionRecord(
  sessionId: string,
  generation: string,
): FriendlyBattleSessionRecord | null {
  const path = friendlyBattleSessionRecordPath(sessionId, generation);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as FriendlyBattleSessionRecord;
}

export function listFriendlyBattleSessionRecords(generation: string): FriendlyBattleSessionRecord[] {
  const dir = friendlyBattleSessionsDir(generation);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as FriendlyBattleSessionRecord);
}

export function reapFriendlyBattleSessionRecord(sessionId: string, generation: string): void {
  const path = friendlyBattleSessionRecordPath(sessionId, generation);
  if (existsSync(path)) unlinkSync(path);
}

export function reapStaleFriendlyBattleSessions(generation: string): string[] {
  const reaped: string[] = [];
  for (const record of listFriendlyBattleSessionRecords(generation)) {
    if (!isPidAlive(record.pid)) {
      reapFriendlyBattleSessionRecord(record.sessionId, generation);
      reaped.push(record.sessionId);
    }
  }
  return reaped;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
