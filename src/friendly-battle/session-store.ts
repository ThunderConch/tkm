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
  daemonPid?: number;
  socketPath?: string;
  createdAt: string;
  updatedAt: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

function assertSafeSegment(value: string, field: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`friendly-battle session store: invalid ${field}: ${JSON.stringify(value)}`);
  }
}

function isValidRecord(value: unknown): value is FriendlyBattleSessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.sessionId !== 'string' || !SAFE_SEGMENT.test(r.sessionId)) return false;
  if (typeof r.generation !== 'string' || !SAFE_SEGMENT.test(r.generation)) return false;
  if (r.role !== 'host' && r.role !== 'guest') return false;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return false;
  if (typeof r.daemonPid !== 'number' || !Number.isInteger(r.daemonPid) || r.daemonPid <= 0) return false;
  if (typeof r.socketPath !== 'string' || r.socketPath.length === 0) return false;
  if (typeof r.phase !== 'string') return false;
  if (typeof r.status !== 'string') return false;
  if (typeof r.sessionCode !== 'string') return false;
  if (typeof r.transport !== 'object' || r.transport === null) return false;
  if (typeof r.createdAt !== 'string') return false;
  if (typeof r.updatedAt !== 'string') return false;
  return true;
}

function currentClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function friendlyBattleSessionsDir(generation: string): string {
  assertSafeSegment(generation, 'generation');
  return join(currentClaudeDir(), 'tokenmon', generation, 'friendly-battle', 'sessions');
}

export function friendlyBattleSessionRecordPath(sessionId: string, generation: string): string {
  assertSafeSegment(sessionId, 'sessionId');
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
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isValidRecord(parsed)) return null;
  return parsed;
}

export function listFriendlyBattleSessionRecords(generation: string): FriendlyBattleSessionRecord[] {
  const dir = friendlyBattleSessionsDir(generation);
  if (!existsSync(dir)) return [];
  const records: FriendlyBattleSessionRecord[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (isValidRecord(parsed)) records.push(parsed);
  }
  return records;
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

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
