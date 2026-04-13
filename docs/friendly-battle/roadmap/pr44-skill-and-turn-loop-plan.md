# PR44 — `skills/friendly-battle/SKILL.md` + Turn Loop (with daemon reversal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Ship the first playable `/tkm:friendly-battle open` / `/tkm:friendly-battle join <code>` experience — two Claude Code sessions drive a gym-style AskUserQuestion turn loop that actually resolves moves over the TCP transport from PR #40/#42/#43.

**Parent branch:** `feat/friendly-battle-pvp-driver` (PR #43)
**This branch:** `feat/friendly-battle-pvp-skill`
**Target PR base:** PR #43

---

## Architecture reversal notice

The roadmap at `docs/friendly-battle/roadmap/pr-stack-after-remote-snapshot-handshake.md` §2 committed to a "foreground-blocking, gym-style one-shot CLI" model and rejected a daemon. **That decision does not generalize to networked play.** Execution of PR43 and investigation of `src/friendly-battle/spike/tcp-direct.ts` revealed the concrete constraint:

- Gym's `battle-turn.ts` is single-shot per call because its entire battle state is on disk — each call reads state, applies the action, writes state, exits.
- Friendly-battle's `tcp-direct.ts` host/guest API is **entirely live-socket** (`waitForGuestJoin`, `markHostReady`, `waitUntilCanStart`, `startBattle`, `waitForGuestChoice`, `sendBattleEvents`, `submitChoice`, `waitForBattleEvent`). A TCP socket cannot survive across tsx invocations — file descriptors don't serialize to disk.
- Therefore: **the process holding the TCP socket must stay alive across multiple SKILL.md subcommand calls.** That is, by definition, a daemon.

This PR adopts a **minimal daemon model**:

- `--init-host` and `--init-join` fork a detached child process (the daemon) that holds the TCP socket and maintains battle state via `battle-adapter.ts`.
- The daemon exposes a local-only UNIX socket at `$CLAUDE_CONFIG_DIR/tokenmon/<gen>/friendly-battle/sessions/<id>.sock`.
- Per-action subcommands (`--wait-next-event`, `--action`, `--status`) are one-shot tsx calls that open the UNIX socket, send a single JSON command, read the single JSON response, and exit. Same ergonomics as gym's `battle-turn.ts` from SKILL.md's perspective.
- Session store already has PID + `reapStaleFriendlyBattleSessions` infra from PR43 — we extend the record with `daemonPid` and `socketPath`. Orphan daemons get reaped on the next session-store scan.
- `--leave` (PR46) will SIGTERM the daemon via PID. Until then, Ctrl+C on the `--init-*` caller still leaves a live daemon; reap handles eventual cleanup.

**Why this is not a full retreat from the roadmap**: the foreground-blocking mental model still holds from the **user's** perspective — running `/tkm:friendly-battle open` feels like one contiguous battle session, not a service. The daemon is an implementation detail invisible to the user, just like a shell pipe. The roadmap's rejection of daemons was specifically targeted at user-visible persistence / reconnect / "open a room and walk away" semantics — none of which we're adding.

The roadmap doc gets an appended "Architecture revision" section as part of this PR.

---

## File structure

**Create:**
- `src/friendly-battle/daemon.ts` — long-lived event loop. Single entry that accepts a role (`'host' | 'guest'`) and the init options, holds the tcp-direct transport, and pumps battle events through `battle-adapter.ts`. Listens on a UNIX socket for local commands. ~400 LOC.
- `src/friendly-battle/daemon-ipc.ts` — UNIX socket server (inside daemon) and client (for `--wait-next-event` / `--action` / `--status` subcommands). JSON-line protocol. ~180 LOC.
- `src/friendly-battle/daemon-protocol.ts` — shared command/response types (`DaemonRequest`, `DaemonResponse`) so server and client can't drift. ~80 LOC.
- `skills/friendly-battle/SKILL.md` — gym-style SKILL.md. Frontmatter, Execute section with dispatch for `open`/`join <code>`/`status`/`help`. Move-only turn loop in this PR; switch/surrender land in PR45. ~180 LOC.
- `test/friendly-battle-daemon-ipc.test.ts` — unit test for IPC round-trip. ~140 LOC.
- `test/friendly-battle-daemon-turn-loop.test.ts` — integration test: spawn two daemons, run a handshake + one full turn (both submit a move, receive resolved events), assert via real TCP + real UNIX sockets. ~280 LOC.
- `test/friendly-battle-skill-contract.test.ts` — static parse of `skills/friendly-battle/SKILL.md` to verify every Bash block references a real `src/cli/friendly-battle-turn.ts` subcommand and no stale paths. ~120 LOC.

**Modify:**
- `src/friendly-battle/session-store.ts` — extend `FriendlyBattleSessionRecord` with `daemonPid: number` and `socketPath: string`. Update shape guard. ~20 LOC.
- `src/cli/friendly-battle-turn.ts`:
  - Refactor `runInitHost` / `runInitJoin`: instead of running the transport inline in the main process, fork `daemon.ts` as a detached child, wait for its "daemon-ready" message on stdout, write the session record with `daemonPid` + `socketPath`, emit the first JSON envelope, exit.
  - Add `runWaitNextEvent` (`--wait-next-event --session <id> --timeout-ms N`): opens UNIX socket, sends `wait_next_event` request, reads single JSON response, prints, exits.
  - Add `runAction` (real body for `--action move:N`): opens UNIX socket, sends `submit_action` request with `{kind:'move', index:N}`, reads single JSON response (updated envelope), prints, exits. Switch / surrender paths still throw `not implemented` (PR45 scope).
  - Add `runStatus` (`--status --session <id>`): reads session store, optionally pings the daemon via UNIX socket for a fresh state snapshot, prints envelope. No transport side effects.
  - ~300 LOC touched.
- `src/friendly-battle/local-harness.ts` — gate deterministic choice paths behind `TOKENMON_FORCE_DETERMINISTIC=1`. Existing tests that rely on deterministic mode must set the flag. ~40 LOC touched.
- `docs/friendly-battle/roadmap/pr-stack-after-remote-snapshot-handshake.md` — append an "Architecture revision (PR44)" section that links to this plan and records the daemon reversal. ~25 LOC added.

**Out of scope:**
- `--action switch:N` / `--action surrender` (PR45)
- `--leave` clean disconnect (PR46)
- Two-machine smoke (PR47)
- Faint-forced-switch flow (PR45)

---

## IPC protocol (daemon-protocol.ts)

```ts
// Request sent from CLI subcommand to daemon UNIX socket.
export type DaemonRequest =
  | { op: 'wait_next_event'; timeoutMs: number }
  | { op: 'submit_action'; action: { kind: 'move'; index: number } }
  | { op: 'status' }
  | { op: 'ping' };

// Response from daemon, always one JSON line terminated with \n.
export type DaemonResponse =
  | { op: 'event'; envelope: FriendlyBattleTurnJson }
  | { op: 'ack'; envelope: FriendlyBattleTurnJson }
  | { op: 'status'; envelope: FriendlyBattleTurnJson }
  | { op: 'pong'; pid: number }
  | { op: 'error'; code: string; message: string };
```

- Line protocol: one JSON object per line (`JSON.stringify` + `\n`).
- Connection lifetime: one request, one response, close. No persistent client streams. Keeps the client side trivially stateless.
- Daemon accepts parallel connections (each CLI call is its own connection).

---

## Daemon lifecycle

1. `tsx friendly-battle-turn.ts --init-host ...` is invoked by the user (via SKILL.md).
2. Parent process `child_process.spawn('tsx', [daemon.ts, '--role', 'host', '--options-json', <json>], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`.
3. Parent reads one `DAEMON_READY <sessionId> <socketPath>` line from the child's stdout, then `child.unref()` so the parent can exit without waiting on the child.
4. Parent writes the session record (PID, socketPath, phase='waiting_for_guest'), emits the first JSON envelope, exits.
5. Daemon continues the transport handshake (`waitForGuestJoin` on host side). As phase transitions happen, daemon updates the session record on disk AND pushes events to a local event queue.
6. Subsequent CLI calls (`--wait-next-event`, `--action move:N`) connect to the UNIX socket, send one request, get one response. Daemon services them against the live transport + the internal event queue.
7. Battle ends: daemon sends final events, writes `phase='finished'`, closes UNIX socket, closes TCP transport, exits.
8. On crash / parent SIGKILL: daemon is still alive (detached). Next call to `reapStaleFriendlyBattleSessions` (e.g. on next `/tkm:friendly-battle open`) cleans up its record if its PID is dead. The daemon itself will exit when its TCP socket closes.

---

## Tasks

### Task 1 — Extend session-store record with daemonPid + socketPath

- Modify `src/friendly-battle/session-store.ts`:
  - Add `daemonPid: number` and `socketPath: string` to `FriendlyBattleSessionRecord`
  - Extend `isValidRecord` shape guard to require both (number > 0 for daemonPid, string passing `SAFE_SEGMENT`-like check for socketPath basename)
- Modify `test/friendly-battle-session-store.test.ts`:
  - Update `makeRecord` fixture to include the two new fields
  - Add one test that `readFriendlyBattleSessionRecord` returns null if `daemonPid` is missing on disk
- Run `npx tsx --test test/friendly-battle-session-store.test.ts` — all pre-existing tests must still pass, new test passes.
- Run `npx tsc --noEmit`.
- Commit: `Extend friendly-battle session record with daemonPid and socketPath`

### Task 2 — `daemon-protocol.ts` (types only, no runtime)

- Create `src/friendly-battle/daemon-protocol.ts` with `DaemonRequest` / `DaemonResponse` union types as specified above.
- Create `test/friendly-battle-daemon-protocol.test.ts` with a type-only smoke that imports both types and exercises each variant via a dummy function, catching any future shape drift.
- Run tests + tsc.
- Commit: `Add friendly-battle daemon IPC protocol types`

### Task 3 — `daemon-ipc.ts` (UNIX socket server + client)

- Create `src/friendly-battle/daemon-ipc.ts`:
  - `createDaemonIpcServer(socketPath, handler)` — creates `net.createServer` listening on a UNIX domain socket, accepts one JSON line per connection, calls `handler(req)`, writes response, closes. Cleans up the socket file on close.
  - `sendDaemonIpcRequest(socketPath, req, timeoutMs)` — opens a client `net.createConnection` to the socket, writes one JSON line, reads one JSON line, resolves, closes. Timeouts propagated as rejected promises.
- Create `test/friendly-battle-daemon-ipc.test.ts`:
  - Spin up a server in-process, send a `{ op: 'ping' }`, assert `{ op: 'pong', pid }` response
  - Send `{ op: 'status' }` to an echo handler, assert round-trip
  - Bad-path: server down → client rejects within timeout
  - Cleanup: `afterEach` unlinks the socket file
- Commit: `Add UNIX-socket IPC server/client for friendly-battle daemon`

### Task 4 — `daemon.ts` (long-lived event loop, host + guest)

- Create `src/friendly-battle/daemon.ts`:
  - `main(argv)` reads `--role host|guest`, `--options-json <b64>` (base64-encoded init options to keep them out of process listing), starts the tcp-direct transport via `createFriendlyBattleSpikeHost` / `connectFriendlyBattleSpikeGuest`
  - On host side: `waitForGuestJoin`, `markHostReady`, `waitUntilCanStart`, `startBattle`, then enter the turn loop.
  - On guest side: `markReady`, `waitForStarted`, then enter the turn loop.
  - Turn loop (both sides): pump events from the transport into a local `AsyncQueue<FriendlyBattleBattleEvent>`. The local player's choice comes in via a UNIX socket `submit_action` request. The daemon forwards it to the transport (`host.waitForGuestChoice` for host-waiting-on-guest; `guest.submitChoice` for guest-sending-to-host). When both choices are present, host resolves via `battle-adapter.ts` and `sendBattleEvents`. Events go into the local queue; `wait_next_event` IPC handler `.shift()`s them.
  - Prints `DAEMON_READY <sessionId> <socketPath>` to stdout as soon as the UNIX socket is listening.
  - On SIGTERM / transport error: close UNIX socket, close transport, write `phase='aborted'` to session record, exit.
- Do NOT write test yet — this module is exercised via the Task 6 integration test.
- Run tsc.
- Commit: `Add friendly-battle daemon long-lived event loop`

### Task 5 — Refactor `--init-host` / `--init-join` to fork the daemon

- Modify `src/cli/friendly-battle-turn.ts`:
  - `runInitHost` no longer runs the transport inline. Instead:
    - Build the options object (same fields as before).
    - `spawn(tsxPath, [daemonEntry, '--role', 'host', '--options-json', base64(optionsJson)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`
    - Read one line from the child stdout, parse `DAEMON_READY <sessionId> <socketPath>`.
    - `child.unref()`
    - Write session record (with `daemonPid: child.pid`, `socketPath: <path>`, `phase: 'waiting_for_guest'`).
    - Emit the first JSON envelope on stdout.
    - Exit 0.
  - `runInitJoin` does the symmetric thing for the guest side.
  - Both retain the input validation (SAFE_NAME, SAFE_CODE, SAFE_GEN) from PR43's fixup.
- Update `test/friendly-battle-turn-driver.test.ts`:
  - The existing handshake test must still pass — it spawns `--init-host` + `--init-join`. Now each one forks a daemon behind the scenes. The test asserts both exit 0 with `phase: 'battle'` in stdout, same as before. Additionally assert that the session record on disk contains a non-zero `daemonPid` and a socketPath that exists as a UNIX socket file.
  - Add teardown that sends SIGTERM to any daemons spawned (via session-store `listFriendlyBattleSessionRecords` + `process.kill(daemonPid, 'SIGTERM')`) so the test doesn't leak zombies.
- Run full test suite.
- Commit: `Fork the friendly-battle daemon from --init-host and --init-join`

### Task 6 — Integration test: full turn loop

- Create `test/friendly-battle-daemon-turn-loop.test.ts`:
  - Spawn host + join with seeded `CLAUDE_CONFIG_DIR` (reuse PR43's pattern).
  - Poll session records until both daemons have `phase='battle'` and `socketPath` exists.
  - Via the IPC client, send `{ op: 'wait_next_event', timeoutMs: 2000 }` to each daemon and expect an envelope with `status='select_action'` and `moveOptions`.
  - Via the IPC client, send `{ op: 'submit_action', action: { kind: 'move', index: 1 } }` to each daemon.
  - Via the IPC client, send another `wait_next_event` to each; expect the resolved turn events (hit / drain / etc.) to appear.
  - Continue until one side reports `status='victory'` or `status='defeat'`.
  - Assert daemons exit cleanly after the battle ends (PID goes away within 2s).
- This test is the single most important new test in PR44 — it proves the whole daemon + IPC + transport stack works end-to-end.
- Commit: `Add end-to-end turn loop integration test across two daemons`

### Task 7 — `--wait-next-event`, `--action move:N`, `--status` subcommands

- Extend `src/cli/friendly-battle-turn.ts`:
  - `runWaitNextEvent`: validates `--session <id>`, reads session record, `sendDaemonIpcRequest(record.socketPath, { op: 'wait_next_event', timeoutMs })`, prints the returned envelope to stdout, exits 0.
  - `runAction`: parses `--action move:<N>` (use regex `^move:([1-4])$`), sends `submit_action` with `kind: 'move', index: N`. switch / surrender tokens still error out with "not implemented: PR45".
  - `runStatus`: reads session record. If daemon is alive (PID check), `sendDaemonIpcRequest({ op: 'status' })` and prints that envelope. If daemon is dead, prints the last persisted session record as a frozen envelope. Never fails.
- Extend the existing driver test file (`test/friendly-battle-turn-driver.test.ts`) with:
  - One test per new subcommand. Each test spawns a minimal daemon via `--init-host` (alone — the waiting_for_guest phase is fine), then calls the new subcommand, asserts the expected JSON envelope, then SIGTERMs the daemon.
- Run tests + tsc.
- Commit: `Implement friendly-battle-turn --wait-next-event / --action move / --status`

### Task 8 — Gate deterministic local-harness path behind TOKENMON_FORCE_DETERMINISTIC

- Grep existing `src/friendly-battle/local-harness.ts` and `src/cli/friendly-battle-local.ts` for deterministic-choice short-circuits.
- Add an `isDeterministicMode()` helper reading `process.env.TOKENMON_FORCE_DETERMINISTIC === '1'`. Wrap every deterministic path behind it.
- Update `test/friendly-battle-local-harness.test.ts` / `test/friendly-battle-local-cli-interaction.test.ts` to set the env var on their spawn calls so they keep hitting the deterministic path.
- Run full suite — all PR #42 friendly-battle tests must still pass.
- Commit: `Gate friendly-battle deterministic paths behind TOKENMON_FORCE_DETERMINISTIC`

### Task 9 — `skills/friendly-battle/SKILL.md`

- Create `skills/friendly-battle/SKILL.md` with:
  - frontmatter `description:` containing English + Korean triggers
  - Execute section mirroring `skills/gym/SKILL.md` structure:
    - Step 0: parse `$ARGUMENTS`. If `open` → init-host. If starts with `join ` → init-join (next token is session code). If `status` → status. Otherwise print help.
    - Step 1: init via `$P/bin/tsx-resolve.sh $P/src/cli/friendly-battle-turn.ts --init-host ...` (or --init-join). Parse stdout JSON, read `sessionId`.
    - Step 2: if the JSON's `phase === 'waiting_for_guest'`, print the room code from `questionContext`, tell the user how to abort (Ctrl+C will not work — they need to run `/tkm:friendly-battle status` to see if anyone connected; this PR leaves the abort story to PR46).
    - Step 3: enter the turn loop: `--wait-next-event --session <id> --timeout-ms 60000` → parse envelope → if `status='select_action'` run gym-style AskUserQuestion over `moveOptions` → `--action move:<N>` → loop.
    - Step 4: handle terminal states: `status='victory'` / `status='defeat'` → show messages, stop.
  - Do NOT include switch / surrender paths — put a `# TODO(PR45)` comment in the stub where those flows would go.
  - English-first copy with necessary Korean labels only, per memory.
- Create `test/friendly-battle-skill-contract.test.ts`:
  - Parse `skills/friendly-battle/SKILL.md` as a string.
  - Extract every `$P/src/cli/friendly-battle-turn.ts` subcommand (`--init-host`, `--init-join`, `--wait-next-event`, `--action`, `--status`).
  - For each, spawn the real CLI with `--help` or a known-safe invocation and assert it at least accepts the flag (exit code semantics match expected).
- Run tests.
- Commit: `Add skills/friendly-battle/SKILL.md and contract test`

### Task 10 — Append roadmap architecture revision

- Edit `docs/friendly-battle/roadmap/pr-stack-after-remote-snapshot-handshake.md`: append an "Architecture revision (PR44)" section explaining the daemon reversal, pointing to this plan.
- Edit the PR stack diagram to indicate PR44 introduces the daemon.
- No test impact. Commit alone.
- Commit: `Document the PR44 daemon reversal in the friendly-battle roadmap`

### Task 11 — CI sanity + push + draft PR

- `npm test` — must be green with all new tests.
- `npx tsc --noEmit`.
- `npm run build`.
- `git push -u origin feat/friendly-battle-pvp-skill`.
- `gh pr create` against base `feat/friendly-battle-pvp-driver`, draft, include the daemon-reversal explanation and the visual-QA handoff note in the PR body.

---

## Visual QA handoff (merge gate)

Per project memory `feedback_visual_qa.md`: "Visual 요소는 실행→스크린샷→visual-verdict 리뷰 통과 필수". This PR introduces real `/tkm:friendly-battle open` / `join` with live AskUserQuestion UX. **Merge requires**:

1. Two terminals with seeded tokenmon data (one host, one guest) on the same machine or LAN.
2. Host runs `/tkm:friendly-battle open`, screenshot the waiting-for-guest AskUserQuestion state.
3. Guest runs `/tkm:friendly-battle join <code>`, screenshot the connection + first move-select AskUserQuestion.
4. Play through at least one full turn on both sides, screenshot the resolution display.
5. `oh-my-claudecode:visual-verdict` review of all screenshots.

This handoff is **not** autopilot scope. Autopilot will land the code, tests, and this plan, push the draft PR, and stop. The human operator runs the visual QA before flipping the PR from draft to ready.

---

## Known risks

1. **Daemon orphans on crash**: if a parent `tsx --init-host` dies between forking the daemon and writing the session record, the daemon is unreachable. `reapStaleFriendlyBattleSessions` only sees recorded sessions. Mitigation: write the session record with a placeholder PID BEFORE forking, then update after. Follow-up PR can add a pidfile directory scan.
2. **UNIX socket leftover files**: if a daemon crashes without unlinking its socket, the next `--init-*` reusing the same session id (unlikely due to UUID) would fail. Mitigation: always unlink the socket path before listen.
3. **Battle adapter engine symmetry**: currently only the host authoritative resolves turns. Guest trusts events from host. Test must verify guest's reported state stays in lockstep with host's. If drift is found, that's a `battle-adapter.ts` bug and belongs in a separate fix.
4. **`waitForGuestChoice` vs `submitChoice` timing**: if the guest submits before the host enters `waitForGuestChoice`, the choice queue buffers it (already handled by `AsyncQueue` in `tcp-direct.ts`). Verify this is still the case — a regression would cause turn-1 deadlock.

---

## Self-review

- [x] Architecture reversal justified from concrete evidence in tcp-direct.ts
- [x] Session store extensions match PR43's existing patterns (validation, shape guard, reap)
- [x] Daemon lifecycle specified — spawn, ready signal, unref, reap
- [x] IPC protocol typed end-to-end
- [x] SKILL.md follows gym prior art (AskUserQuestion only, no chat parsing)
- [x] Visual QA merge gate called out, not handwaved
- [x] Out-of-scope items explicit (switch, surrender, leave, smoke)
- [x] Tests are real TCP + real UNIX socket, no mocks (memory)
- [x] OMC-independent (no OMC imports in skill file or daemon)
