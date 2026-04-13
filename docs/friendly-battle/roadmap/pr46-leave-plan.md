# PR46 — `/tkm:friendly-battle leave` Implementation Plan

**Goal:** User can explicitly abort a friendly battle mid-flow. Both daemons shut down cleanly with a `battle_finished{reason:'cancelled'}` or `{reason:'disconnect'}` event so the skill can render a "you left" / "opponent left" message instead of a timeout.

**Parent:** `feat/friendly-battle-pvp-fainted` (PR #45)
**This branch:** `feat/friendly-battle-pvp-leave`

## Scope

**New CLI surface:**
- `friendly-battle-turn --leave --session <id> --generation <gen>` — connects to the daemon via IPC, sends `{op: 'leave'}`, reads ack envelope, exits

**New daemon surface:**
- `DaemonRequest` adds `{op: 'leave'}`
- `DaemonResponse` already has `{op: 'ack', envelope}` — reuse
- Daemon IPC handler for `leave`: marks session `phase='aborted', status='aborted'`, pushes a synthetic `battle_finished{winner: null, reason: 'cancelled'}` event into `localEventQueue` (so any pending `wait_next_event` on the leaving side resolves), closes the transport (which triggers peer-side EOF), acks the IPC request, then initiates shutdown(0, 'finished')
- Peer daemon's in-flight transport read errors on EOF → existing catch path enters `shutdown(1, 'aborted')`. Modify this catch to ALSO push a synthetic `battle_finished{winner: null, reason: 'disconnect'}` into its local event queue BEFORE closing the IPC server, so the peer skill's next `wait_next_event` returns a clean "opponent left" envelope instead of hanging

**SKILL.md:**
- Update Step 7 (status) adjacent section / add Step 8 for `/tkm:friendly-battle leave` dispatch. Calls `--leave` via tsx, reads the ack envelope, prints "you left the battle". No AskUserQuestion needed.
- Also handle `status: 'aborted'` in the turn loop — when `wait_next_event` returns an envelope with `phase='aborted'` or `status='aborted'`, display "opponent left" and stop the loop.

**Integration test:**
- `test/friendly-battle-daemon-leave.test.ts` — spawn host + guest daemons, handshake, then host sends `{op: 'leave'}`. Assert:
  - host IPC response is `op: 'ack'` with envelope showing `phase='aborted'`, status 'aborted'
  - host's subsequent `wait_next_event` returns the synthetic `battle_finished` envelope (or times out cleanly — whichever the impl chooses)
  - guest's next `wait_next_event` returns an envelope with `phase='aborted'` or a `battle_finished{reason:'disconnect'}`
  - both daemons exit within 5s after leave

## Out of scope (deferred)

- Protocol-level `peer_left` TCP message (uses existing disconnect path instead)
- SIGTERM handler change in daemon (already cleanly handles signals from PR44)
- Two-machine manual smoke (PR47)

## Verification

- `npm test` → 1198 pass (1197 + 1 new leave test)
- `npx tsc --noEmit`
- `npm run build`
- CI green on stacked PR #46
