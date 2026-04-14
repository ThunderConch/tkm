#!/bin/sh
# Pick the fastest available entry point for friendly-battle-turn.
# - If a precompiled dist/cli/friendly-battle-turn.js exists, use plain
#   `node` so per-action calls skip the ~700ms tsx compile cold start.
# - Otherwise fall back to tsx on the source so dev iteration still works
#   without a build step.
set -e
P="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -f "$P/dist/cli/friendly-battle-turn.js" ]; then
  exec node "$P/dist/cli/friendly-battle-turn.js" "$@"
fi
exec "$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" "$@"
