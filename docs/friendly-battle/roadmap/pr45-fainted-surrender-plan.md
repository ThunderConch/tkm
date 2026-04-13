# PR45 — Fainted Forced-Switch + Surrender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Activate the `switch:N` and `surrender` paths that PR44 intentionally stubbed, so `/tkm:friendly-battle` can resolve a full battle including forced switches after a faint and explicit user surrender.

**Parent branch:** `feat/friendly-battle-pvp-skill` (PR #44)
**This branch:** `feat/friendly-battle-pvp-fainted`
**Target PR base:** PR #44

---

## Good news: most of the machinery is already wired

Investigation of the PR44 daemon surface shows that `battle-adapter.ts` already handles all three `TurnAction` variants (`move`, `switch`, `surrender`), and `daemon.ts:eventStatus` already maps `choices_requested{phase: 'awaiting_fainted_switch'}` → `'fainted_switch'` status. The gaps are purely at the **user-input surface**:

- `DaemonAction` union in `daemon-protocol.ts` is move-only
- `serializeDaemonAction` in `daemon.ts` has only a `move` case
- `runAction` in `friendly-battle-turn.ts` rejects `switch:N` / `surrender` with a "PR45 deferred" error
- `skills/friendly-battle/SKILL.md` has no switch menu flow, no surrender confirm, no forced-switch handling
- `eventToEnvelopeFields` emits moveOptions even on `choices_requested{phase:'awaiting_fainted_switch'}`, which confuses the skill's AskUserQuestion logic

This PR is much smaller than PR44 — mostly surface exposure + 1 integration test with a 2-pokemon party fixture.

---

## File structure

**Modify:**
- `src/friendly-battle/daemon-protocol.ts` — extend `DaemonAction` union
- `src/friendly-battle/daemon.ts` — `serializeDaemonAction` switch/surrender cases + `eventToEnvelopeFields` zero-out moveOptions on fainted_switch
- `src/cli/friendly-battle-turn.ts` — `runAction` parses `switch:N` (1-based) and `surrender`, forwards to daemon via IPC
- `skills/friendly-battle/SKILL.md` — switch-menu AskUserQuestion flow (mirror gym Step 4), surrender-confirm AskUserQuestion flow (gym Step 5), forced-switch flow (gym Step 6)
- `test/friendly-battle-daemon-protocol.test.ts` — expand to cover new action variants
- `test/friendly-battle-turn-driver.test.ts` — remove the "PR45 deferred" assertions, add real switch/surrender tests
- `test/friendly-battle-skill-contract.test.ts` — the regex for accepted `--action` tokens must now accept `switch:<N>` and `surrender`

**New:**
- `test/friendly-battle-daemon-fainted-switch.test.ts` — integration test. Seeds a 2-pokemon party fixture (host + guest both), runs a battle turn that knocks out one side's active pokemon, asserts the fainted envelope is delivered, submits a switch:2 action, asserts the battle continues to turn 2.
- `test/friendly-battle-daemon-surrender.test.ts` — integration test. Seeds a 1-pokemon party, runs handshake, one side submits `surrender`, asserts both daemons see `battle_finished{winner: other_side, reason: 'surrender'}` and exit cleanly.

---

## Tasks

### Task 1 — Extend `DaemonAction` union

**Files**: `src/friendly-battle/daemon-protocol.ts`, `test/friendly-battle-daemon-protocol.test.ts`

Add `switch` and `surrender` variants:

```ts
export type DaemonAction =
  | { kind: 'move'; index: number }
  | { kind: 'switch'; pokemonIndex: number }
  | { kind: 'surrender' };
```

Extend the protocol test to round-trip each new variant through `encodeDaemonMessage` / `decodeDaemonMessage`.

Commit message: `Add switch and surrender variants to friendly-battle DaemonAction`

### Task 2 — Daemon `serializeDaemonAction` handles new variants

**Files**: `src/friendly-battle/daemon.ts`, `test/friendly-battle-daemon-turn-loop.test.ts` (no change expected; just verify)

Extend the switch statement:

```ts
function serializeDaemonAction(action: DaemonAction): string {
  switch (action.kind) {
    case 'move': return `move:${action.index}`;
    case 'switch': return `switch:${action.pokemonIndex}`;
    case 'surrender': return 'surrender';
  }
}
```

Verify the daemon turn-loop test still passes (move path unchanged).

Commit: `Serialize switch and surrender DaemonActions for the TCP transport`

### Task 3 — Daemon `eventToEnvelopeFields` zeros moveOptions on fainted_switch

**Files**: `src/friendly-battle/daemon.ts`

In the `choices_requested` case, check `event.phase`:

```ts
case 'choices_requested': {
  const isFaintedSwitch = event.phase === 'awaiting_fainted_switch';
  const moveOptions = isFaintedSwitch
    ? []
    : (runtime
        ? buildMoveOptionsFromRuntime(runtime, role)
        : (ownSnapshot ? buildMoveOptionsFromSnapshot(ownSnapshot) : []));
  // partyOptions stays populated either way
  return {
    questionContext: isFaintedSwitch
      ? 'Your Pokémon fainted — pick a replacement'
      : `Turn ${event.turn}: Choose your action`,
    moveOptions,
    partyOptions,
    animationFrames: [],
    currentFrameIndex: 0,
  };
}
```

No test change needed — the integration test in Task 6 verifies the envelope shape.

Commit: `Zero out moveOptions on fainted_switch envelopes`

### Task 4 — `runAction` accepts `switch:N` / `surrender`

**Files**: `src/cli/friendly-battle-turn.ts`, `test/friendly-battle-turn-driver.test.ts`

Replace the PR45-deferred error branches with real parsing:

- `switch:N` where N in 1..6 → `{kind: 'switch', pokemonIndex: N - 1}` (1-based SKILL.md token → 0-based battle adapter index, matching move handling)
- `surrender` → `{kind: 'surrender'}`
- Any other token → `REASON: unknown action token`, exit 1

Update the two existing "PR45 not-implemented" tests in `friendly-battle-turn-driver.test.ts` to expect success instead. They'll need a live daemon to submit to — reuse the pattern from the `--wait-next-event returns the first choices_requested envelope` test, but after submitting a real move first so the action queue makes sense.

Commit: `Implement friendly-battle-turn --action switch:N and --action surrender`

### Task 5 — Skill contract regex accepts new action tokens

**Files**: `test/friendly-battle-skill-contract.test.ts`

Update the `accepted` predicate to also accept `switch:<N>` and `surrender`:

```ts
const accepted = (token: string): boolean => {
  if (/^move:[\d<$]/.test(token) || token === 'move:') return true;
  if (/^switch:[\d<$]/.test(token) || token === 'switch:') return true;
  if (token === 'surrender') return true;
  return false;
};
```

Commit: `Allow switch and surrender tokens in the friendly-battle skill contract test`

### Task 6 — SKILL.md adds switch menu + surrender confirm + forced-switch flows

**Files**: `skills/friendly-battle/SKILL.md`

Mirror `skills/gym/SKILL.md` Steps 4, 5, 6:

- **Switch menu** (Step 4): When the user types `교체` or `switch` in AskUserQuestion's "Other" field during a normal turn, open a second AskUserQuestion listing live party members from `partyOptions`. On pick: `--action switch:<N>`. On invalid: re-ask.
- **Surrender confirm** (Step 5): When the user types `항복` or `surrender`, show a yes/no AskUserQuestion. On confirm: `--action surrender`. On cancel: return to the move AskUserQuestion.
- **Forced switch** (Step 6): When `wait_next_event` returns an envelope with `status === 'fainted_switch'`, immediately open the switch-menu AskUserQuestion (no move menu). Cancel is NOT allowed — the user must pick a live party member. Empty party or all-fainted → status should already be `defeat` from the adapter, not this branch.

Commit: `Add switch menu, surrender confirm, and forced-switch flows to SKILL.md`

### Task 7 — Integration test: fainted forced switch

**Files**: `test/friendly-battle-daemon-fainted-switch.test.ts` (new)

Spawn host + guest daemons with a 2-pokemon party seeded on both sides (one low-HP pokemon that will faint on a single strong hit, one healthy backup). Send `move:1` from both sides via IPC `submit_action`. Drain events via `wait_next_event` until one side's `status === 'fainted_switch'`. On that side, send `{op: 'submit_action', action: {kind: 'switch', pokemonIndex: 1}}`. Drain events again; expect the next `choices_requested` to have `status === 'select_action'` and the non-fainted side to have moveOptions for the next turn.

Keep the test time-bounded to 15s total. Clean up daemons in afterEach.

For the seed: use pokemon id 387 with `moves: [33, 45]` (tackle-ish) and id 155 as backup. Or simpler: both sides get [387, 155] and one of the moves is strong enough to KO.

If finding real damage values is hard, use `TOKENMON_FORCE_DETERMINISTIC` or similar injection to force a one-shot KO. If no such hook exists, either create one via a daemon env flag or accept that the test is a two-turn setup (turn 1 weakens, turn 2 kills).

Commit: `Add integration test for fainted forced-switch end-to-end`

### Task 8 — Integration test: explicit surrender

**Files**: `test/friendly-battle-daemon-surrender.test.ts` (new)

Simpler than Task 7. Spawn host + guest with 1-pokemon parties. After handshake reaches `status === 'select_action'`, one side sends `{op: 'submit_action', action: {kind: 'surrender'}}`. The other side sends any `move:1`. Drain events; expect `battle_finished` with `winner` = the non-surrendering side and `reason: 'surrender'`.

Commit: `Add integration test for explicit surrender end-to-end`

### Task 9 — CI sanity + push + draft PR

- `npm test` (full suite, 1195+N passes)
- `npx tsc --noEmit`
- `npm run build`
- `git push origin feat/friendly-battle-pvp-fainted`
- `gh pr create --draft --base feat/friendly-battle-pvp-skill --head feat/friendly-battle-pvp-fainted ...`

Visual QA handoff note in PR body: the new switch-menu and surrender-confirm are AskUserQuestion UIs and require `visual-verdict` review before merge, same as PR44.

---

## Out of scope (still)

- `--leave` clean disconnect → PR46
- Two-machine smoke evidence → PR47
- Daemon authentication beyond PR44's UNIX-socket 0600 perms
- `TOKENMON_FORCE_DETERMINISTIC` gate for local-harness (deferred hygiene)

## Known risks

1. **One-shot KO test reliability**: depends on real battle damage math. If the damage roll is non-deterministic, the "knocks out on one hit" assumption may flake. Mitigation: use `TOKENMON_TEST=1` + a fixed PRNG seed if the test harness supports one; otherwise stage a two-turn setup where the second turn is the guaranteed KO.
2. **Partial-state race**: if the fainted side's CLI calls `--wait-next-event` before the daemon has pushed the fainted_switch envelope, the shift times out. Mitigation: generous timeouts (5s+) and explicit polling for the right envelope type in the test.
3. **Switch index off-by-one**: SKILL.md uses 1-based labels, daemon uses 0-based indexes. PR44 already handled this for `move:N`; same subtraction applies to `switch:N`. Tests must be explicit.
