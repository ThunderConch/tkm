import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const CODEX_DB_PATH = join(homedir(), '.codex', 'state_5.sqlite');

// node:sqlite is experimental in Node 22 — load at module scope, null if unavailable
let DatabaseSync: (new (path: string, opts?: { readOnly?: boolean }) => any) | null = null;
try {
  const esmRequire = createRequire(import.meta.url);
  DatabaseSync = esmRequire('node:sqlite').DatabaseSync;
} catch (e: unknown) {
  // node:sqlite unavailable — readCodexTotalTokens will always return 0
  process.stderr.write(`tokenmon: node:sqlite unavailable, Codex XP disabled: ${e instanceof Error ? e.message : e}\n`);
}

/**
 * Read total tokens consumed across all Codex threads.
 * Returns 0 if Codex is not installed or DB is unreadable.
 */
export function readCodexTotalTokens(): number {
  if (!DatabaseSync || !existsSync(CODEX_DB_PATH)) return 0;
  try {
    const db = new DatabaseSync(CODEX_DB_PATH, { readOnly: true });
    try {
      const row = db.prepare('SELECT COALESCE(SUM(tokens_used), 0) AS total FROM threads').get() as { total: number };
      return row.total;
    } finally {
      db.close();
    }
  } catch (e: unknown) {
    // DB exists but read failed — log for diagnostics (not silent)
    process.stderr.write(`tokenmon: codex db read failed: ${e instanceof Error ? e.message : e}\n`);
    return 0;
  }
}
