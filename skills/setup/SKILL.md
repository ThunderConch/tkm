---
description: "Tokenmon initial setup. Install dependencies, StatusLine integration, starter Pokémon selection. Korean: 초기 설정, 설치, 시작, tokenmon"
---

Run Tokenmon plugin initial setup in order.

## Step 0: Resolve Plugin Root

```bash
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
echo "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}" && test -n "${CLAUDE_PLUGIN_ROOT}" && test -f "${CLAUDE_PLUGIN_ROOT}/package.json" && echo "OK" || echo "FAIL"
```

- `OK` → proceed to Step 1.
- `FAIL` → inform the user:
  > `CLAUDE_PLUGIN_ROOT` could not be resolved. Install tokenmon first via `/plugin install tkm@tkm`.

## Step 1: Install Dependencies

```
cd "${CLAUDE_PLUGIN_ROOT}" && npm install
```

On success proceed to Step 1.3. On failure show the error.

## Step 1.3: Multi-Generation Migration Check

Verify multi-gen migration completed successfully:

```bash
TSX="${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh"
node -e "
const fs = require('fs');
const home = process.env.HOME || require('os').homedir();
const dataDir = (process.env.CLAUDE_CONFIG_DIR || home + '/.claude') + '/tokenmon';
const globalCfg = dataDir + '/global-config.json';
const gen4Dir = dataDir + '/gen4';
const rootState = dataDir + '/state.json';
const rootConfig = dataDir + '/config.json';

// Check if legacy root files need migration
const hasLegacy = fs.existsSync(rootState) || fs.existsSync(rootConfig);
const hasMigrated = fs.existsSync(gen4Dir + '/state.json') || fs.existsSync(gen4Dir + '/config.json');
const hasGlobalCfg = fs.existsSync(globalCfg);

if (hasLegacy && !hasMigrated) {
  console.log('NEEDS_MIGRATION');
} else if (!hasGlobalCfg && hasMigrated) {
  console.log('NEEDS_GLOBAL_CONFIG');
} else {
  console.log('OK');
}
"
```

- `OK` → proceed to Step 1.5.
- `NEEDS_MIGRATION` → Run postinstall to trigger migration:
  ```
  "${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/setup/postinstall.ts"
  ```
- `NEEDS_GLOBAL_CONFIG` → Create global config:
  ```bash
  node -e "
  const fs = require('fs');
  const home = process.env.HOME || require('os').homedir();
  const dataDir = (process.env.CLAUDE_CONFIG_DIR || home + '/.claude') + '/tokenmon';
  const globalCfg = dataDir + '/global-config.json';
  let lang = 'en';
  try {
    const cfg = JSON.parse(fs.readFileSync(dataDir + '/gen4/config.json', 'utf-8'));
    lang = cfg.language || 'en';
  } catch {}
  fs.writeFileSync(globalCfg, JSON.stringify({ active_generation: 'gen4', language: lang }, null, 2));
  console.log('Created ' + globalCfg);
  "
  ```

## Step 1.5: Generation Selection

Use AskUserQuestion:

> Which generation would you like to play?

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" gen list
```

Options (show available generations from output):
1. Gen 1 — Kanto (Bulbasaur / Charmander / Squirtle)
2. Gen 4 — Sinnoh (Turtwig / Chimchar / Piplup) (default for existing users)

If user picks a different generation than current active:
```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" gen switch <gen_id>
```

## Step 1.7: Language Selection

Use AskUserQuestion to let the user choose their preferred language:

> Which language would you like to use?

Options:
1. English (default)
2. 한국어 (Korean)

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set language <en|ko>
```

## Step 2: StatusLine Integration

Handles coexistence with other plugins that may already use StatusLine.

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/setup/setup-statusline.ts"
```

- No existing statusLine: registers tokenmon directly.
- Existing statusLine found: creates a wrapper at `~/.claude/tokenmon/status-wrapper.mjs` and updates settings.json.
- Already configured: skips.

Show any errors to the user.

## Step 3: Check for Starter Pokémon

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" status
```

If the party already has a Pokémon, skip to Step 4.5.

Otherwise, run this command and use its output **verbatim** for AskUserQuestion — do NOT use your own knowledge of Pokémon names:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" starter
```

The output lists starters with localized names (e.g. `1) 나오하 [#906] grass`). Present exactly those names to the user. Do not guess or substitute names from memory.

## Step 4: Initialize Starter

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" starter <pokemon_id>
```

Pass the Pokémon **ID number** shown in the `starter` command output (e.g. `906`, not the name).

## Step 4.5: Renderer Selection

Detect available renderers:

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/setup/detect-and-list-renderers.ts"
```

Example output:
```
1. [Recommended] Kitty Graphics Protocol (best quality, native PNG) (kitty)
2. Braille (classic, compatible with all terminals) (braille)
```

Use AskUserQuestion:

> How would you like to render Pokémon sprites?

Then run:
```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set renderer <kitty|sixel|iterm2|braille>
```

If the selected renderer is not `braille`, pre-generate sprites:
```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/generate-png-sprites.ts" --renderer <selected>
```

Skip generation if sprites already exist or `braille` was selected.

## Step 5: Status Bar Display Settings

Use AskUserQuestion for sprite mode:

> How would you like to display Pokémon in the Status Bar?

Options:
1. All sprites (default) — Braille sprite for every party member
2. Ace only sprite — sprite for ace only, others omitted
3. All emoji — compact type emoji (1 line)
4. Ace emoji only — emoji for ace only

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set sprite_mode <all|ace_only|emoji_all|emoji_ace>
```

Then use AskUserQuestion for info mode:

> How would you like to display Pokémon info?

Options:
1. Ace full info (default) — ace: name/level/XP bar, others: name/level
2. All name/level only — compact, no XP bar
3. All full info — XP bar for every Pokémon
4. Ace level, others name only — most compact

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set info_mode <ace_full|name_level|all_full|ace_level>
```

## Step 5.5: Sound Settings

Detect the environment and offer sound relay setup if remote.

```bash
node -e "
const fs = require('fs');
const env = {
  ssh: !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
  docker: fs.existsSync('/.dockerenv') || (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup','utf8').includes('docker')),
  wsl: false,
  remote_container: !!process.env.REMOTE_CONTAINERS,
};
try { env.wsl = /microsoft/i.test(fs.readFileSync('/proc/version','utf8')); } catch {}
env.is_remote = env.ssh || env.docker || env.remote_container;
env.is_local_wsl = env.wsl && !env.ssh;
console.log(JSON.stringify(env));
"
```

**If remote environment (SSH or Docker):**

Use AskUserQuestion:

> You're running in a **remote environment**. Tokenmon sounds won't play here.
> Enable **relay mode** to route sounds to your local machine?

Options:
1. **Enable relay (Recommended)** — Route sounds via peon-ping relay (localhost:19998)
2. **Skip** — Set up sound later with `/tkm:relay-setup`

If user picks "Enable relay":

```bash
TSX="${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh"
"${TSX}" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set relay_audio true
"${TSX}" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set relay_sound_root tkm-sounds
```

Then verify:
```bash
curl -sf --max-time 2 http://localhost:19998/health 2>/dev/null && echo "RELAY_OK" || echo "RELAY_FAIL"
```

- `RELAY_OK` → "Relay connected. Sounds will play on your local machine."
- `RELAY_FAIL` → "Relay not reachable. Run `/tkm:relay-setup` later for detailed setup instructions."

**If local environment (WSL, not SSH):**

Use AskUserQuestion:

> Would you like to enable Pokémon sounds?

Options:
1. **Enable sounds (Recommended)** — Cries and SFX play during battles and events
2. **Disable sounds** — Silent mode

```bash
TSX="${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh"
"${TSX}" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" config set cry_enabled <true|false>
```

## Step 6: Confirm Setup

```
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" status
```

Show the result to the user. If a Pokémon appears in the party, setup is complete.
Restart Claude Code to see tokenmon in the status bar.

## Uninstall Notice

Always inform the user after setup:

> **Note**: Before removing tokenmon later, run this first:
> ```
> /tkm:uninstall
> ```
> This cleans up statusLine config and data files.
> Skipping this step may leave errors in the status bar.
