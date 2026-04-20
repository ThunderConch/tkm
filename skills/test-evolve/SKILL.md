---
description: "Dev-only: manual test harness for the evolution AskUserQuestion flow. Backs up state, seeds a scenario party, and lets the user trigger the Stop-hook evolution prompt in their live session."
---

Dev-only test harness for the evolution AskUserQuestion flow. No tmux, no spawning — the user triggers the evolution prompt manually in this live session.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
```

## Dispatch

- If `$ARGUMENTS` is `--list` or `--verify` or `--restore` or `--help`:
  run `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" ${ARGUMENTS}`, show output, stop.

- Otherwise treat `$ARGUMENTS` as a scenario name and run setup:
  `"$P/bin/tsx-resolve.sh" "$P/src/cli/test-evolve.ts" --setup ${ARGUMENTS}`

  After setup succeeds, tell the user:

  > Party seeded for scenario **${ARGUMENTS}**. Send any short message to trigger the evolution prompt. When done:
  > - `/tkm:test-evolve --verify` — check state vs expected_after
  > - `/tkm:test-evolve --restore` — restore backup and clean up

## Usage

| Command | Description |
|---------|-------------|
| `/tkm:test-evolve branch-eevee` | Seed Eevee branch-evolution scenario |
| `/tkm:test-evolve --list` | List all 6 scenarios |
| `/tkm:test-evolve --verify` | Compare live state vs expected_after |
| `/tkm:test-evolve --restore` | Restore backup, remove current.json |
