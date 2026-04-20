---
description: "Dev-only: E2E test harness for the evolution AskUserQuestion flow via tmux. Runs 6 scenarios in isolated Claude Code sessions and reports 3-layer verify results."
---

Run the dev-only `test-evolve` E2E harness. This is NOT shipped in the released plugin — it exercises the Stop-hook evolution block path end-to-end by spawning real Claude Code sessions inside tmux panes.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" ${ARGUMENTS}
```

## Usage

| Command | Description |
|---------|-------------|
| `/tkm:test-evolve` | Run all 6 scenarios sequentially (tmux + real LLM cost) |
| `/tkm:test-evolve --scenario branch-eevee` | Run a single scenario by name |
| `/tkm:test-evolve --dry-run` | Validate scenarios + tmux, no LLM cost |
| `/tkm:test-evolve --restore` | Restore from latest backup and exit |

## What it does

1. Backs up the user's live `state.json`, `config.json`, and installed `hooks/hooks.json` to `.tokenmon/test-backup/<timestamp>/`.
2. Rewrites `hooks.json` so hooks point at the worktree under test (dual-format: baked absolute OR `${CLAUDE_PLUGIN_ROOT}` template).
3. For each scenario: spawns a tmux pane with an isolated `CLAUDE_CONFIG_DIR`, seeds party state, launches `claude`, detects the AskUserQuestion UI, injects the expected choice via `tmux send-keys`, and runs 3-layer verification (UI regex + tool-call match + state diff).
4. On completion (or crash, or Ctrl+C) restores the backup byte-for-byte.

Show the output table to the user. Any `FAIL` rows include the failing layer and diff detail.
