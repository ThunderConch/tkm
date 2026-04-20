---
description: "Dev-only: manual test harness for the evolution AskUserQuestion flow. Backs up state, seeds a scenario party, auto-verifies + auto-restores after the user completes the evolution prompt."
---

Dev-only test harness for the evolution AskUserQuestion flow. No tmux, no spawning — the user triggers the evolution prompt manually in this live session. Verify and restore run automatically once the evolution cycle completes; the user only has to pick the scenario and click through the `AskUserQuestion` UI.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
```

## Dispatch for flag arguments

- `--list` → `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --list`, show output, stop.
- `--restore` → same, `--restore`. Emergency cleanup when an earlier cycle did not auto-restore (e.g. the session was killed mid-test).
- `--help` → same, `--help`.
- `--verify` is present in the CLI but should not be invoked directly by users; it is called automatically as part of the lifecycle below.

## Scenario lifecycle (when `$ARGUMENTS` is a scenario name)

### Step 1 — setup (this turn)

1. Run: `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --setup ${ARGUMENTS}`
2. Show the setup output verbatim.
3. Tell the user, verbatim:

   > Party seeded for **${ARGUMENTS}**. Send any short message to trigger the Stop-hook evolution prompt. After you click an option (or `Refuse`), I'll auto-verify and auto-restore.

4. Stop the turn here. Do **not** pre-run verify or restore.

### Step 2 — user-triggered evolution turn

When the user sends any message after setup, the Stop hook emits `{"decision":"block", "reason": ...}` and Claude Code feeds the block's `reason` field back as the next turn's instruction. **Within that same turn you MUST complete the entire cycle below without stopping early** — do not wait for another user turn between steps, do not acknowledge and stop before the cycle finishes.

**In order, without pausing:**

1. Render the evolution prompt. Call `AskUserQuestion` exactly as the block reason directs (one subquestion per pokemon; question text copied verbatim; up to 4 buttons with the 3-eligible-plus-Refuse rule; remaining targets listed inline).
2. When the user answers:
   - **Button picking a target** → resolve the button label to its target id if needed, then run `"$P/bin/tsx-resolve.sh" "$P/src/cli/tokenmon.ts" evolve <pokemon> <target>` in a single Bash call.
   - **`Refuse` button** or **Other containing `refuse`/`no`/`cancel`/`거부`** → skip the evolve call.
   - **Other containing a pokemon name** → validate it against the candidate's `All evolution targets` list; if it matches, run evolve with the resolved target; if it does not match, reply with a short "I didn't recognize that" and re-invoke the same `AskUserQuestion` (max two re-prompts, then treat as Refuse).
3. After the evolve call returns (or after the refuse path settles), print a one-line summary to the user that names the pokemon and its new form (or says "refused") so they see that their pick took effect.
4. **Immediately**, in the same turn, run:
   1. `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --verify`
   2. `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --restore`
5. Show a compact final report: scenario name, user's pick, verify verdict (PASS / FAIL with any failing fields), and restore confirmation.

**Critical:** `--restore` must run even when `--verify` reports FAIL. The user's real state/config/hooks.json only become safe again after the restore completes.

## Usage

| Command | Behavior |
|---------|---------|
| `/tkm:test-evolve branch-eevee` | Setup → user triggers → auto verify + auto restore |
| `/tkm:test-evolve --list` | List all 6 scenarios |
| `/tkm:test-evolve --restore` | Emergency restore (only needed if auto-restore was skipped) |

## Scenarios (see `src/test-scenarios/*.json`)

- `branch-eevee` — full 8-way branch, 3 eligible via stones + 2 via friendship; exercises the overflow rule
- `single-charmander` — single-chain, expect Charmeleon
- `multi-3` — 3 pokemon ready, batch in one `AskUserQuestion`
- `overflow-5` — 5 pokemon ready, first 4 this turn, 5th deferred
- `refuse-persist` — user refuses, verify `evolution_prompt_shown` is set
- `accept-clear-reprompt` — accept → flag cleared on the new pokemon key
