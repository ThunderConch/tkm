---
description: "Dev-only: manual test harness for the evolution AskUserQuestion flow. Backs up state, seeds a scenario party, auto-verifies + auto-restores after the user completes the evolution prompt."
---

Dev-only test harness for the evolution AskUserQuestion flow. No tmux, no spawning — the user triggers the evolution prompt manually in this live session. Verify and restore run automatically; the user only has to pick the scenario and click through the `AskUserQuestion` UI.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
```

## Lifecycle (one scenario, auto verify + restore)

When `$ARGUMENTS` is a scenario name (not a flag starting with `--`), execute this **multi-turn** protocol.

### Turn 1 — setup (this turn)

1. Run: `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --setup ${ARGUMENTS}`
2. Show the setup output.
3. Remember (carry into the next turn): a test cycle is active for scenario `${ARGUMENTS}`. The CLI wrote `.tokenmon/test-backup/current.json` as a persistent marker — checking for its existence confirms the cycle is still mid-flight.
4. Tell the user, verbatim:

   > Party seeded for **${ARGUMENTS}**. Send any short message to trigger the Stop-hook evolution prompt. After you click an option (or `Refuse`), I'll auto-verify and auto-restore.

5. Stop the turn. Do **not** run verify or restore yet.

### Turn N — user-triggered evolution event

The user sends a message. The Stop hook emits `{"decision":"block", "reason": ...}` which arrives back as Claude-visible feedback, with instructions to call `AskUserQuestion` for each evolution candidate. Render the question(s) exactly as instructed by the block reason. For each user selection:

- If the user picked a target, run: `tokenmon evolve <pokemon> <target>`
- If the user refused, do nothing (the `evolution_prompt_shown` flag already gates re-prompting)

### Turn N+1 — auto verify + auto restore (MANDATORY)

Immediately after the `tokenmon evolve` call(s) succeed (or the refuse path completes), and **before responding with anything else**, run these two commands in order:

1. `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --verify`
2. `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --restore`

Restore **always** runs, even if verify reports FAIL. The user's live state/config/hooks.json are only safe once `--restore` completes.

Show the combined output to the user as a compact summary: scenario name, verify verdict (PASS / FAIL + failing fields), restore confirmation.

## Dispatch for flag arguments

- `--list` → `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --list`, show output, stop.
- `--restore` → same, `--restore`. For emergency cleanup when an earlier cycle did not auto-restore (e.g. the session was killed mid-test).
- `--help` → same, `--help`.
- `--verify` is present in the CLI but should not be invoked directly by users; it is called automatically as part of the lifecycle above.

## Usage

| Command | Behavior |
|---------|---------|
| `/tkm:test-evolve branch-eevee` | Setup → user triggers → auto verify + auto restore |
| `/tkm:test-evolve --list` | List all 6 scenarios |
| `/tkm:test-evolve --restore` | Emergency restore (only needed if auto-restore was skipped) |

## Scenarios (see `src/test-scenarios/*.json`)

- `branch-eevee` — 8-way branch, expect Vaporeon
- `single-charmander` — single-chain, expect Charmeleon
- `multi-3` — 3 pokemon ready, batch in one `AskUserQuestion`
- `overflow-5` — 5 pokemon ready, first 4 this turn, 5th deferred
- `refuse-persist` — user refuses, verify `evolution_prompt_shown` is set
- `accept-clear-reprompt` — accept → flag cleared on the new pokemon key
