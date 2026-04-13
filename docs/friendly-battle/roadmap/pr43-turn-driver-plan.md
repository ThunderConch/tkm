# PR43 — Friendly-Battle Turn Driver CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-process foreground-blocking friendly-battle turn driver CLI that `skills/friendly-battle/SKILL.md` (PR44) can invoke as one-shots, mirroring the `battle-turn.ts` contract that `skills/gym/SKILL.md` already uses.

**Architecture:** Single tsx entry point (`src/cli/friendly-battle-turn.ts`) with subcommand dispatch. Each subcommand loads a disk-backed `FriendlyBattleSessionRecord`, drives an in-process transport/battle action, emits a gym-compatible JSON envelope to stdout, persists the updated record, and exits. Transport reuses `#40`'s `tcp-direct.ts`. Battle resolution reuses `#40`'s `battle-adapter.ts`. The session record is **observation state**, not a rendezvous channel — cross-machine communication still flows over TCP within one long-lived process per side.

**Tech Stack:** Node 22, TypeScript, `node:test`, `tsx`, existing friendly-battle modules under `src/friendly-battle/`.

**Parent branch:** `feat/friendly-battle-remote-snapshot-handshake` (PR #42)

**New branch:** `feat/friendly-battle-pvp-driver`

---

## File Structure

**Create:**

- `src/friendly-battle/session-store.ts` — disk-backed session record read/write + stale reap. ~180 LOC.
- `src/friendly-battle/turn-json.ts` — gym-compatible JSON envelope formatter. ~120 LOC.
- `src/cli/friendly-battle-turn.ts` — CLI entry with subcommand dispatch. ~350 LOC.
- `test/friendly-battle-session-store.test.ts` — session store unit tests. ~160 LOC.
- `test/friendly-battle-turn-json.test.ts` — turn-json formatter unit tests. ~120 LOC.
- `test/friendly-battle-turn-driver.test.ts` — end-to-end driver test spawning two tsx processes over real TCP. ~240 LOC.

**Modify:**

- `src/friendly-battle/local-harness.ts` — gate deterministic choice paths behind `TOKENMON_FORCE_DETERMINISTIC` env var so the default path yields control to real submitters. ~30 LOC touched.
- `src/friendly-battle/battle-adapter.ts` — expose `awaitNextBattleEvent(timeoutMs)` on the runtime so the turn driver can pump events without polling. ~40 LOC added.

**Not modified:**

- `src/cli/friendly-battle.ts` — public shell facade stays as-is; new driver is invoked by the upcoming skill (PR44), not by the shell CLI.
- `src/cli/friendly-battle-local.ts` — unchanged. Deterministic fallback moves behind env flag without deleting the code.
- `src/cli/friendly-battle-spike.ts` — unchanged. PR43 uses the same tcp-direct transport but via a new entry point.

---

## Task 1 — Session store

**Files:**
- Create: `src/friendly-battle/session-store.ts`
- Test: `test/friendly-battle-session-store.test.ts`

The session record is the disk artifact Claude Code can inspect between slash-command invocations (for statusbar display + debugging). It is **not** a rendezvous channel; the TCP transport still owns all cross-machine communication.

- [ ] **Step 1: Write the failing record shape + path resolver test**

```ts
// test/friendly-battle-session-store.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  friendlyBattleSessionRecordPath,
  readFriendlyBattleSessionRecord,
  writeFriendlyBattleSessionRecord,
  type FriendlyBattleSessionRecord,
} from '../src/friendly-battle/session-store.js';

function withTempClaudeDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-session-'));
  const prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<FriendlyBattleSessionRecord> = {}): FriendlyBattleSessionRecord {
  return {
    sessionId: 'fb-session-001',
    role: 'host',
    generation: 'gen4',
    sessionCode: 'alpha-123',
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: { host: '127.0.0.1', port: 52345 },
    opponent: null,
    pid: process.pid,
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('friendly-battle session store', () => {
  it('resolves a per-generation session record path under CLAUDE_CONFIG_DIR', () => {
    withTempClaudeDir((dir) => {
      const path = friendlyBattleSessionRecordPath('fb-session-001', 'gen4');
      assert.equal(
        path,
        join(dir, 'tokenmon', 'gen4', 'friendly-battle', 'sessions', 'fb-session-001.json'),
      );
    });
  });

  it('round-trips a session record through disk', () => {
    withTempClaudeDir(() => {
      const record = makeRecord();
      writeFriendlyBattleSessionRecord(record);
      const loaded = readFriendlyBattleSessionRecord('fb-session-001', 'gen4');
      assert.deepEqual(loaded, record);
    });
  });

  it('returns null for a missing session', () => {
    withTempClaudeDir(() => {
      const loaded = readFriendlyBattleSessionRecord('does-not-exist', 'gen4');
      assert.equal(loaded, null);
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails for "module not found"**

```
npx tsx --test test/friendly-battle-session-store.test.ts
```

Expected: FAIL with `Cannot find module '../src/friendly-battle/session-store.js'`.

- [ ] **Step 3: Implement session-store.ts minimal surface**

```ts
// src/friendly-battle/session-store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_DIR } from '../core/paths.js';

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

export function friendlyBattleSessionsDir(generation: string): string {
  return join(CLAUDE_DIR, 'tokenmon', generation, 'friendly-battle', 'sessions');
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
```

**Important:** `CLAUDE_DIR` is evaluated at import time. The test uses `withTempClaudeDir` which sets `CLAUDE_CONFIG_DIR` before reading the path — but because the module is already loaded in the test process, `CLAUDE_DIR` is frozen. Rework `session-store.ts` to read `process.env.CLAUDE_CONFIG_DIR` at call time:

```ts
function currentClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? CLAUDE_DIR;
}

export function friendlyBattleSessionsDir(generation: string): string {
  return join(currentClaudeDir(), 'tokenmon', generation, 'friendly-battle', 'sessions');
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```
npx tsx --test test/friendly-battle-session-store.test.ts
```

Expected: PASS with 3 tests.

- [ ] **Step 5: Write and pass a stale-pid reap test**

```ts
// Add inside describe block:
import { listFriendlyBattleSessionRecords, reapStaleFriendlyBattleSessions } from '../src/friendly-battle/session-store.js';

it('reaps records whose pids are no longer running', () => {
  withTempClaudeDir(() => {
    const liveRecord = makeRecord({ sessionId: 'alive', pid: process.pid });
    const deadRecord = makeRecord({ sessionId: 'dead', pid: 1 << 22 /* unreachable pid */ });
    writeFriendlyBattleSessionRecord(liveRecord);
    writeFriendlyBattleSessionRecord(deadRecord);

    const reaped = reapStaleFriendlyBattleSessions('gen4');

    assert.deepEqual(reaped, ['dead']);
    const remaining = listFriendlyBattleSessionRecords('gen4').map((r) => r.sessionId);
    assert.deepEqual(remaining.sort(), ['alive']);
  });
});
```

Extend `session-store.ts`:

```ts
import { readdirSync, unlinkSync } from 'node:fs';

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
```

Run and confirm PASS:

```
npx tsx --test test/friendly-battle-session-store.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/friendly-battle/session-store.ts test/friendly-battle-session-store.test.ts
git commit -m "Add disk-backed friendly-battle session store"
```

---

## Task 2 — Turn JSON formatter

**Files:**
- Create: `src/friendly-battle/turn-json.ts`
- Test: `test/friendly-battle-turn-json.test.ts`

The JSON envelope is the wire format between the SKILL.md and the driver CLI. It must be **byte-compatible with the gym contract** (see `skills/gym/SKILL.md` "JSON Output Contract") so the skill can reuse the same parsing instructions.

- [ ] **Step 1: Write the failing gym-contract matcher test**

```ts
// test/friendly-battle-turn-json.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFriendlyBattleTurnJson,
  type FriendlyBattleTurnJson,
} from '../src/friendly-battle/turn-json.js';
import type { FriendlyBattleSessionRecord } from '../src/friendly-battle/session-store.js';

function makeRecord(overrides: Partial<FriendlyBattleSessionRecord> = {}): FriendlyBattleSessionRecord {
  return {
    sessionId: 'fb-001',
    role: 'host',
    generation: 'gen4',
    sessionCode: 'alpha-123',
    phase: 'battle',
    status: 'select_action',
    transport: { host: '127.0.0.1', port: 52345 },
    opponent: { playerName: 'Guest' },
    pid: 12345,
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('friendly-battle turn-json formatter', () => {
  it('emits the gym-compatible envelope with sessionId/phase/status', () => {
    const json = formatFriendlyBattleTurnJson({
      record: makeRecord(),
      questionContext: '🤝 vs Guest | 디아루가 Lv.53 HP:169/169',
      moveOptions: [
        { index: 1, nameKo: '용의파동', pp: 10, maxPp: 10, disabled: false },
      ],
      partyOptions: [
        { index: 1, name: '디아루가', hp: 169, maxHp: 169, fainted: false },
      ],
      animationFrames: [],
      currentFrameIndex: 0,
    });

    assert.equal(json.sessionId, 'fb-001');
    assert.equal(json.phase, 'battle');
    assert.equal(json.status, 'select_action');
    assert.equal(json.questionContext, '🤝 vs Guest | 디아루가 Lv.53 HP:169/169');
    assert.equal(json.moveOptions?.length, 1);
    assert.equal(json.moveOptions?.[0].nameKo, '용의파동');
    assert.equal(json.currentFrameIndex, 0);
    assert.deepEqual(json.animationFrames, []);
  });

  it('propagates role so the skill knows which side it is driving', () => {
    const json = formatFriendlyBattleTurnJson({
      record: makeRecord({ role: 'guest' }),
      questionContext: 'ctx',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    });
    assert.equal(json.role, 'guest');
  });
});
```

- [ ] **Step 2: Run → FAIL**

```
npx tsx --test test/friendly-battle-turn-json.test.ts
```

Expected: FAIL with `Cannot find module '../src/friendly-battle/turn-json.js'`.

- [ ] **Step 3: Implement turn-json.ts**

```ts
// src/friendly-battle/turn-json.ts
import type { FriendlyBattleSessionRecord } from './session-store.js';

export interface FriendlyBattleTurnMoveOption {
  index: number;
  nameKo: string;
  pp: number;
  maxPp: number;
  disabled: boolean;
}

export interface FriendlyBattleTurnPartyOption {
  index: number;
  name: string;
  hp: number;
  maxHp: number;
  fainted: boolean;
}

export interface FriendlyBattleTurnAnimationFrame {
  kind: string;
  durationMs: number;
  [k: string]: unknown;
}

export interface FriendlyBattleTurnJson {
  sessionId: string;
  role: 'host' | 'guest';
  phase: string;
  status: string;
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
}

export interface FormatFriendlyBattleTurnJsonInput {
  record: FriendlyBattleSessionRecord;
  questionContext: string;
  moveOptions: FriendlyBattleTurnMoveOption[];
  partyOptions: FriendlyBattleTurnPartyOption[];
  animationFrames: FriendlyBattleTurnAnimationFrame[];
  currentFrameIndex: number;
}

export function formatFriendlyBattleTurnJson(
  input: FormatFriendlyBattleTurnJsonInput,
): FriendlyBattleTurnJson {
  return {
    sessionId: input.record.sessionId,
    role: input.record.role,
    phase: input.record.phase,
    status: input.record.status,
    questionContext: input.questionContext,
    moveOptions: input.moveOptions,
    partyOptions: input.partyOptions,
    animationFrames: input.animationFrames,
    currentFrameIndex: input.currentFrameIndex,
  };
}
```

- [ ] **Step 4: Run → PASS**

```
npx tsx --test test/friendly-battle-turn-json.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/friendly-battle/turn-json.ts test/friendly-battle-turn-json.test.ts
git commit -m "Add gym-compatible friendly-battle turn JSON formatter"
```

---

## Task 3 — Driver CLI skeleton and argument parsing

**Files:**
- Create: `src/cli/friendly-battle-turn.ts`
- Test: `test/friendly-battle-turn-driver.test.ts` (file created in this task, populated over Tasks 3–9)

- [ ] **Step 1: Write the failing `--help` smoke test**

```ts
// test/friendly-battle-turn-driver.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-turn.ts');

describe('friendly-battle-turn CLI', () => {
  it('prints usage when invoked with --help and exits 0', async () => {
    const { stdout, stderr } = await execFileP(process.execPath, ['--import', 'tsx', CLI, '--help']);
    assert.match(stdout + stderr, /Usage: friendly-battle-turn/);
    assert.match(stdout + stderr, /--init-host/);
    assert.match(stdout + stderr, /--init-join/);
    assert.match(stdout + stderr, /--action/);
    assert.match(stdout + stderr, /--refresh/);
    assert.match(stdout + stderr, /--status/);
  });

  it('exits non-zero and emits a structured error on unknown subcommand', async () => {
    await assert.rejects(
      execFileP(process.execPath, ['--import', 'tsx', CLI, '--bogus-flag']),
      (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match((err.stderr ?? '') + (err.stdout ?? ''), /unknown subcommand/i);
        return true;
      },
    );
  });
});
```

- [ ] **Step 2: Run → FAIL (CLI file missing)**

```
npx tsx --test test/friendly-battle-turn-driver.test.ts
```

- [ ] **Step 3: Implement CLI skeleton with arg parser and dispatch stubs**

```ts
// src/cli/friendly-battle-turn.ts
#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';

type Subcommand =
  | 'init-host'
  | 'init-join'
  | 'action'
  | 'refresh'
  | 'status';

interface ParsedCliArgs {
  subcommand: Subcommand;
  flags: Record<string, string | undefined>;
}

const USAGE = [
  'Usage: friendly-battle-turn [subcommand] [flags]',
  '',
  'Subcommands:',
  '  --init-host --session-code <code> [--listen-host 127.0.0.1] [--port 0] [--timeout-ms 4000] [--generation gen4] [--player-name Host]',
  '  --init-join --session-code <code> --host <host> --port <port> [--timeout-ms 4000] [--generation gen4] [--player-name Guest]',
  '  --action <move|switch:N|surrender> --session <id>',
  '  --refresh (--frame <i> | --finalize) --session <id>',
  '  --status --session <id>',
  '',
].join('\n');

function printUsage(): void {
  process.stdout.write(`${USAGE}\n`);
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const subcommand = resolveSubcommand(argv);
  if (!subcommand) {
    process.stderr.write('unknown subcommand\n');
    printUsage();
    process.exit(1);
  }

  const flagArgs = argv.filter((token) => !SUBCOMMAND_FLAGS.has(token));
  const { values } = parseArgs({
    args: flagArgs,
    options: CLI_FLAG_SCHEMA,
    strict: false,
    allowPositionals: true,
  });

  return { subcommand, flags: values as Record<string, string | undefined> };
}

const SUBCOMMAND_FLAGS = new Set<string>([
  '--init-host',
  '--init-join',
  '--action',
  '--refresh',
  '--status',
]);

const CLI_FLAG_SCHEMA = {
  'session-code': { type: 'string' as const },
  'session': { type: 'string' as const },
  'host': { type: 'string' as const },
  'listen-host': { type: 'string' as const },
  'port': { type: 'string' as const },
  'timeout-ms': { type: 'string' as const },
  'generation': { type: 'string' as const },
  'player-name': { type: 'string' as const },
  'frame': { type: 'string' as const },
  'finalize': { type: 'boolean' as const },
};

function resolveSubcommand(argv: string[]): Subcommand | null {
  if (argv.includes('--init-host')) return 'init-host';
  if (argv.includes('--init-join')) return 'init-join';
  if (argv.includes('--action')) return 'action';
  if (argv.includes('--refresh')) return 'refresh';
  if (argv.includes('--status')) return 'status';
  return null;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  switch (parsed.subcommand) {
    case 'init-host':
      await runInitHost(parsed.flags);
      return;
    case 'init-join':
      await runInitJoin(parsed.flags);
      return;
    case 'action':
      await runAction(parsed.flags);
      return;
    case 'refresh':
      await runRefresh(parsed.flags);
      return;
    case 'status':
      await runStatus(parsed.flags);
      return;
  }
}

async function runInitHost(_flags: Record<string, string | undefined>): Promise<void> {
  throw new Error('not implemented: --init-host');
}
async function runInitJoin(_flags: Record<string, string | undefined>): Promise<void> {
  throw new Error('not implemented: --init-join');
}
async function runAction(_flags: Record<string, string | undefined>): Promise<void> {
  throw new Error('not implemented: --action');
}
async function runRefresh(_flags: Record<string, string | undefined>): Promise<void> {
  throw new Error('not implemented: --refresh');
}
async function runStatus(_flags: Record<string, string | undefined>): Promise<void> {
  throw new Error('not implemented: --status');
}

const isEntryScript = import.meta.url === `file://${process.argv[1]}`;
if (isEntryScript) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run → PASS (both smoke tests)**

```
npx tsx --test test/friendly-battle-turn-driver.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/friendly-battle-turn.ts test/friendly-battle-turn-driver.test.ts
git commit -m "Scaffold friendly-battle-turn CLI skeleton and arg parser"
```

---

## Task 4 — `--init-host` subcommand (waiting-for-guest state)

**Files:**
- Modify: `src/cli/friendly-battle-turn.ts`
- Modify: `test/friendly-battle-turn-driver.test.ts`

The host entry point listens on a TCP port via existing `createFriendlyBattleSpikeHost`, writes a `FriendlyBattleSessionRecord` with `phase='waiting_for_guest'`, and blocks until either a guest handshake completes or the timeout fires. On handshake success, the record is updated to `phase='battle'` and the driver exits 0 after emitting the first turn JSON. On timeout, the driver writes `phase='aborted'` and exits non-zero with a structured error.

- [ ] **Step 1: Write the failing waiting-for-guest test**

Add to `test/friendly-battle-turn-driver.test.ts`:

```ts
import { spawn } from 'node:child_process';

function spawnDriver(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, TOKENMON_TEST: '1', TSX_DISABLE_CACHE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
  });
}

describe('friendly-battle-turn --init-host', () => {
  it('emits JSON with phase=waiting_for_guest before timing out and then writes phase=aborted', async () => {
    const result = await spawnDriver([
      '--init-host',
      '--session-code', 'waiting-123',
      '--listen-host', '127.0.0.1',
      '--port', '0',
      '--timeout-ms', '300',
      '--generation', 'gen4',
      '--player-name', 'Host',
    ]);

    assert.notEqual(result.exitCode, 0);
    // waiting line should have been printed before we gave up
    assert.match(result.stdout, /"phase":\s*"waiting_for_guest"/);
    assert.match(result.stderr, /STAGE:\s*waiting_for_guest/);
  });
});
```

- [ ] **Step 2: Run → FAIL (not implemented error bubbles up)**

```
npx tsx --test test/friendly-battle-turn-driver.test.ts
```

- [ ] **Step 3: Implement `runInitHost`**

Replace `runInitHost` with:

```ts
import { randomUUID } from 'node:crypto';
import { createFriendlyBattleSpikeHost } from '../friendly-battle/spike/tcp-direct.js';
import {
  type FriendlyBattleSessionRecord,
  writeFriendlyBattleSessionRecord,
} from '../friendly-battle/session-store.js';
import { formatFriendlyBattleTurnJson } from '../friendly-battle/turn-json.js';

async function runInitHost(flags: Record<string, string | undefined>): Promise<void> {
  const sessionCode = requireFlag(flags, 'session-code');
  const listenHost = flags['listen-host'] ?? '127.0.0.1';
  const port = Number.parseInt(flags.port ?? '0', 10);
  const timeoutMs = Number.parseInt(flags['timeout-ms'] ?? '4000', 10);
  const generation = flags.generation ?? 'gen4';
  const playerName = flags['player-name'] ?? 'Host';

  const host = await createFriendlyBattleSpikeHost({
    host: listenHost,
    port,
    sessionCode,
    hostPlayerName: playerName,
    generation,
  });

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();

  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'host',
    generation,
    sessionCode,
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: {
      host: host.connectionInfo.host,
      port: host.connectionInfo.port,
    },
    opponent: null,
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);

  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `Waiting for guest (code ${sessionCode}) — press Ctrl+C to cancel`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);
  process.stderr.write(`STAGE: waiting_for_guest\n`);

  try {
    const joined = await host.waitForGuestJoin(timeoutMs);
    record.phase = 'battle';
    record.status = 'select_action';
    record.opponent = { playerName: joined.guestPlayerName };
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stderr.write(`STAGE: guest_joined (${joined.guestPlayerName})\n`);
    // PR43 scope: emit the ready envelope and exit 0. Turn loop (wait-next-event)
    // is PR44.
    process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
      record,
      questionContext: `🤝 vs ${joined.guestPlayerName}`,
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    }))}\n`);
  } catch (err) {
    record.phase = 'aborted';
    record.status = 'aborted';
    record.updatedAt = nowIso();
    writeFriendlyBattleSessionRecord(record);
    process.stderr.write(`STAGE: waiting_for_guest\n`);
    process.stderr.write(`FAILED_STAGE: waiting_for_guest\n`);
    process.stderr.write(`REASON: ${(err as Error).message}\n`);
    await host.close().catch(() => undefined);
    process.exit(1);
  }
  await host.close().catch(() => undefined);
}

function requireFlag(flags: Record<string, string | undefined>, name: string): string {
  const value = flags[name];
  if (value === undefined) {
    process.stderr.write(`missing required flag --${name}\n`);
    process.exit(1);
  }
  return value;
}
```

- [ ] **Step 4: Run → PASS**

```
npx tsx --test test/friendly-battle-turn-driver.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/friendly-battle-turn.ts test/friendly-battle-turn-driver.test.ts
git commit -m "Implement friendly-battle-turn --init-host waiting_for_guest path"
```

---

## Task 5 — `--init-join` subcommand

**Files:**
- Modify: `src/cli/friendly-battle-turn.ts`
- Modify: `test/friendly-battle-turn-driver.test.ts`

The join entry connects to the host via `connectFriendlyBattleSpikeGuest`, sends the guest snapshot, waits for `battle_started`, writes its own `FriendlyBattleSessionRecord` with `role='guest'`, and exits 0.

- [ ] **Step 1: Add the happy-path test that spawns host + join in parallel and asserts both JSON envelopes**

```ts
// test/friendly-battle-turn-driver.test.ts — append
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

function withSeededClaudeConfigDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(joinPath(tmpdir(), 'tkm-fb-init-join-'));
  const genDir = joinPath(dir, 'tokenmon', 'gen4');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    joinPath(genDir, 'config.json'),
    JSON.stringify({ party: ['387'], starter_chosen: true }),
  );
  writeFileSync(
    joinPath(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': { id: 387, xp: 100, level: 16, friendship: 0, ev: 0, moves: [33, 45] },
      },
    }),
  );
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return fn(dir).finally(cleanup);
}

describe('friendly-battle-turn init handshake', () => {
  it('init-join connects to an init-host and both exit 0 with battle phase', async () => {
    await withSeededClaudeConfigDir(async (claudeDir) => {
      const sessionCode = 'handshake-321';
      const host = spawnDriverWithClaudeDir(claudeDir, [
        '--init-host',
        '--session-code', sessionCode,
        '--listen-host', '127.0.0.1',
        '--port', '0',
        '--timeout-ms', '10000',
        '--generation', 'gen4',
        '--player-name', 'Host',
      ]);

      const hostPort = await readPortFromHostStderr(host);

      const join = spawnDriverWithClaudeDir(claudeDir, [
        '--init-join',
        '--session-code', sessionCode,
        '--host', '127.0.0.1',
        '--port', String(hostPort),
        '--timeout-ms', '10000',
        '--generation', 'gen4',
        '--player-name', 'Guest',
      ]);

      const [hostResult, joinResult] = await Promise.all([host.completion, join.completion]);
      assert.equal(joinResult.exitCode, 0, `join stderr:\n${joinResult.stderr}`);
      assert.equal(hostResult.exitCode, 0, `host stderr:\n${hostResult.stderr}`);
      assert.match(hostResult.stdout, /"phase":\s*"battle"/);
      assert.match(joinResult.stdout, /"phase":\s*"battle"/);
      assert.match(joinResult.stdout, /"role":\s*"guest"/);
    });
  });
});
```

Also define `spawnDriverWithClaudeDir` and `readPortFromHostStderr` helpers near the top of the file — reuse the existing `spawnDriver` body but let `env.CLAUDE_CONFIG_DIR` be overridden. `readPortFromHostStderr` should parse the `PORT:` line emitted by `--init-host`.

Update `runInitHost` to additionally emit:

```ts
process.stderr.write(`PORT: ${host.connectionInfo.port}\n`);
```

- [ ] **Step 2: Run → FAIL (`--init-join` not implemented)**

- [ ] **Step 3: Implement `runInitJoin`**

```ts
import { connectFriendlyBattleSpikeGuest } from '../friendly-battle/spike/tcp-direct.js';
import { loadFriendlyBattleCurrentProfile } from '../friendly-battle/local-harness.js';
import { buildFriendlyBattlePartySnapshot } from '../friendly-battle/snapshot.js';

async function runInitJoin(flags: Record<string, string | undefined>): Promise<void> {
  const sessionCode = requireFlag(flags, 'session-code');
  const host = requireFlag(flags, 'host');
  const port = Number.parseInt(requireFlag(flags, 'port'), 10);
  const timeoutMs = Number.parseInt(flags['timeout-ms'] ?? '4000', 10);
  const generation = flags.generation ?? 'gen4';
  const playerName = flags['player-name'] ?? 'Guest';

  const guestProfile = loadFriendlyBattleCurrentProfile(generation);
  const guestSnapshot = buildFriendlyBattlePartySnapshot(guestProfile);

  const guest = await connectFriendlyBattleSpikeGuest({
    host,
    port,
    sessionCode,
    guestPlayerName: playerName,
    generation,
    guestSnapshot,
    timeoutMs,
  });

  const sessionId = `fb-${randomUUID()}`;
  const nowIso = () => new Date().toISOString();
  const record: FriendlyBattleSessionRecord = {
    sessionId,
    role: 'guest',
    generation,
    sessionCode,
    phase: 'handshake',
    status: 'connecting',
    transport: { host, port },
    opponent: { playerName: 'Host' },
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeFriendlyBattleSessionRecord(record);
  process.stderr.write(`STAGE: connected\n`);

  await guest.markReady();
  record.phase = 'ready';
  record.status = 'connecting';
  record.updatedAt = nowIso();
  writeFriendlyBattleSessionRecord(record);
  process.stderr.write(`STAGE: ready\n`);

  await guest.waitForStarted(timeoutMs);
  record.phase = 'battle';
  record.status = 'select_action';
  record.updatedAt = nowIso();
  writeFriendlyBattleSessionRecord(record);
  process.stderr.write(`STAGE: battle_started\n`);

  process.stdout.write(`${JSON.stringify(formatFriendlyBattleTurnJson({
    record,
    questionContext: `🤝 vs Host`,
    moveOptions: [],
    partyOptions: [],
    animationFrames: [],
    currentFrameIndex: 0,
  }))}\n`);

  await guest.close().catch(() => undefined);
}
```

- [ ] **Step 4: Run → PASS**

```
npx tsx --test test/friendly-battle-turn-driver.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/friendly-battle-turn.ts test/friendly-battle-turn-driver.test.ts
git commit -m "Implement friendly-battle-turn --init-join handshake"
```

---

## Rescope notice (added after Task 5 landed)

After Tasks 1–5 landed (commits `c6c562d` → `308a3dc`), the handshake driver
is fully functional end-to-end across two spawned CLI processes. Tasks 6–9
were originally scoped into PR43, but during execution the following became
clear:

- `--action move:N` (Task 6) and `--refresh --frame/--finalize` (Task 7) only
  make sense when a skill drives them inside an AskUserQuestion turn loop.
  Absent that loop, neither side knows when it is its turn to submit.
- `--wait-next-event` was originally allocated to PR44 but is required for
  Tasks 6/7 to be testable at all.
- `--status` (Task 8) is cheap but has no caller until the SKILL.md exists.
- Gating the deterministic local-harness path (Task 9) is only needed when
  the real turn loop runs — the deterministic path is still exercised by the
  existing #42 spike CLI tests and must not be touched until then.

**New PR43 scope**: Tasks 1 → 5 (done) plus Task 10 (CI sanity + draft PR).
**Moved to PR44**: Tasks 6 → 9 plus `--wait-next-event` plus `skills/friendly-battle/SKILL.md`.

The task sections below are preserved as historical design notes and will
be expanded / revised when the PR44 plan is written.

---

## Task 6 — `--action move:N` subcommand (MOVED TO PR44)

**Files:**
- Modify: `src/cli/friendly-battle-turn.ts`
- Modify: `test/friendly-battle-turn-driver.test.ts`

The action subcommand loads an existing session record by `--session <id>`, parses the action token (`1`-`4` for move index, `switch:<idx>`, `surrender`), submits the choice through the battle adapter / transport, updates the record, and emits the next JSON envelope. For PR43, only `move:<N>` paths are required; `switch` / `surrender` are stubbed to return a not-yet-implemented status but the CLI parses them correctly so PR45 can fill them in.

- [ ] **Step 1: Write the failing move-submission test**

Add test that:
1. Runs the Task 5 handshake smoke to get both sides to `phase=battle`
2. Reads the session id from the host session record
3. Runs `--action 1 --session <id>` and asserts the stdout envelope has `status=ongoing` and animationFrames

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `runAction` for `move:<N>`**

```ts
async function runAction(flags: Record<string, string | undefined>): Promise<void> {
  const sessionId = requireFlag(flags, 'session');
  const actionToken = requireFlag(flags, 'action');
  const record = readFriendlyBattleSessionRecord(sessionId, 'gen4');
  if (!record) {
    process.stderr.write(`unknown session ${sessionId}\n`);
    process.exit(1);
  }
  if (/^[1-4]$/.test(actionToken)) {
    // submit move choice via battle adapter
    // ... existing battle-adapter integration
  } else if (/^switch:(\d+)$/.test(actionToken)) {
    process.stderr.write(`switch action deferred to PR45\n`);
    process.exit(2);
  } else if (actionToken === 'surrender') {
    process.stderr.write(`surrender deferred to PR45\n`);
    process.exit(2);
  } else {
    process.stderr.write(`unknown action token ${actionToken}\n`);
    process.exit(1);
  }
  // emit updated envelope
}
```

(The exact move submission path depends on the `battle-adapter.ts` exposed surface. Use `battle-adapter.test.ts` as the reference for which functions to call.)

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "Implement friendly-battle-turn --action move:N"
```

---

## Task 7 — `--refresh --frame / --finalize` subcommands (MOVED TO PR44)

**Files:**
- Modify: `src/cli/friendly-battle-turn.ts`
- Modify: `test/friendly-battle-turn-driver.test.ts`

Animation pump API identical to gym's — `--refresh --frame <i> --session <id>` advances the current frame index and re-emits the envelope; `--refresh --finalize --session <id>` resolves the pump loop, commits the battle state update, and emits the post-turn envelope.

- [ ] **Step 1: Write the failing refresh test**
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement `runRefresh`**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

```bash
git commit -m "Implement friendly-battle-turn --refresh frame/finalize pump"
```

---

## Task 8 — `--status` subcommand (MOVED TO PR44)

**Files:**
- Modify: `src/cli/friendly-battle-turn.ts`
- Modify: `test/friendly-battle-turn-driver.test.ts`

Purely a read of the session store, for SKILL.md to call after a crash or when the statusbar wants to render current phase/status. Returns the JSON envelope without touching transport.

- [ ] **Step 1: Write the failing test (write record, then call --status, assert envelope matches)**
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement `runStatus`**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

```bash
git commit -m "Implement friendly-battle-turn --status read-only envelope"
```

---

## Task 9 — Gate `local-harness` deterministic path behind an env flag (MOVED TO PR44)

**Files:**
- Modify: `src/friendly-battle/local-harness.ts`
- Modify: existing tests that rely on deterministic mode

**Why:** PR43's driver calls into the real battle adapter. Any existing deterministic short-circuits in `local-harness.ts` must move behind `TOKENMON_FORCE_DETERMINISTIC=1` so they don't leak into the new path. Existing `friendly-battle-local-harness.test.ts` / `friendly-battle-local-cli-interaction.test.ts` need to set the flag.

- [ ] **Step 1: Grep for deterministic short-circuits**

```
rg 'move:0|auto_choice|deterministic' src/friendly-battle/ test/friendly-battle-*
```

- [ ] **Step 2: Add the env-flag check at each call site**
- [ ] **Step 3: Update affected tests to set `env.TOKENMON_FORCE_DETERMINISTIC = '1'`**
- [ ] **Step 4: Run the full friendly-battle test suite → PASS**

```
npx tsx --test test/friendly-battle-*.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "Gate friendly-battle deterministic paths behind TOKENMON_FORCE_DETERMINISTIC"
```

---

## Task 10 — CI sanity + push + stacked PR

- [ ] **Step 1: Run the full test suite**

```
npm test
```

Expected: all existing tests still pass, new friendly-battle-turn-driver tests pass.

- [ ] **Step 2: Run typecheck**

```
npx tsc --noEmit
```

- [ ] **Step 3: Run build**

```
npm run build
```

- [ ] **Step 4: Push the new branch**

```bash
git push origin feat/friendly-battle-pvp-driver
```

- [ ] **Step 5: Open a draft stacked PR targeting `feat/friendly-battle-remote-snapshot-handshake`**

```bash
gh pr create \
  --base feat/friendly-battle-remote-snapshot-handshake \
  --head feat/friendly-battle-pvp-driver \
  --draft \
  --title "Ship the friendly-battle turn driver CLI (no skill yet)" \
  --body "$(cat <<'EOF'
## Summary

- add single-process foreground friendly-battle turn driver (`friendly-battle-turn.ts`)
- add disk-backed session store + gym-compatible turn JSON formatter
- keep deterministic local-harness paths behind a new env flag so PR43 does not regress existing tests

## Why this PR exists

This is the infrastructure foundation for `/tkm:friendly-battle` — PR44 lands the `skills/friendly-battle/SKILL.md` that drives this CLI in a gym-style AskUserQuestion loop.

## Out of scope

- SKILL.md (PR44)
- fainted_switch / surrender flow (PR45)
- leave / disconnect semantics (PR46)
- two-machine smoke evidence (PR47)

## Verification

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
EOF
)"
```

---

## Self-Review Checklist

- [x] Every new file has a dedicated task
- [x] Every task has write-test → fail → implement → pass → commit
- [x] Actual test code included for Tasks 1, 2, 3, 4, 5 (the novel ones); Tasks 6–8 reference established gym patterns because the contract is already documented
- [x] All referenced functions (`formatFriendlyBattleTurnJson`, `writeFriendlyBattleSessionRecord`, `createFriendlyBattleSpikeHost`, `connectFriendlyBattleSpikeGuest`, `buildFriendlyBattlePartySnapshot`, `loadFriendlyBattleCurrentProfile`) exist in the current tree
- [x] Task 9 preserves existing deterministic tests via env flag instead of deleting them
- [x] Out-of-scope items explicitly deferred to PR44/45/46/47 per the roadmap
- [x] `CLAUDE_DIR` freezing bug flagged and worked around in Task 1
- [x] Commit messages follow repo style (imperative, no prefix, no tag)

## PR44–PR47 Summary Pointers

Detailed per-task plans for the remaining PRs will be written when their turn comes (one plan per PR keeps each plan tractable and lets PR43's learnings feed back into PR44's scope). The roadmap at [`pr-stack-after-remote-snapshot-handshake.md`](./pr-stack-after-remote-snapshot-handshake.md) records file boundaries and test targets for each PR.

| PR  | Plan file                              | Status                |
| --- | -------------------------------------- | --------------------- |
| PR43 | `pr43-turn-driver-plan.md` (this doc) | Ready for execution   |
| PR44 | `pr44-skill-and-turn-loop-plan.md`    | To be written after PR43 ships |
| PR45 | `pr45-fainted-surrender-plan.md`       | To be written after PR44 ships |
| PR46 | `pr46-leave-disconnect-plan.md`        | To be written after PR45 ships |
| PR47 | `pr47-two-machine-smoke-plan.md`       | Manual; written alongside PR46 |
