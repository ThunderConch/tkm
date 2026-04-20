---
description: "Tokenmon friendly battle. Real PvP turn loop against another player on the same network. Korean: 친선전, 친선 배틀, 배틀, 대전, friendly battle"
---

Open a friendly battle session and fight another player in real-time turn-based combat. One player opens a room (`open`), shares the session code + host:port with their opponent, who then joins (`join`). Switch, surrender, and leave are now supported (PR45, PR46).

## Execute

### Step 0 — Parse `$ARGUMENTS`

Read the first token of `$ARGUMENTS`:

- `open` → go to **Step 1a** (open flow). **Default is LAN mode** — bind `0.0.0.0` and advertise the machine's detected LAN IP. If the **second** token is `local`, run in loopback mode instead — bind `127.0.0.1` (same-machine only).
- `join` → go to **Step 1b** (join flow); the second token must be `<code>@<host>:<port>`
- `resume` → go to **Step 1c** (resume flow — picks up the turn loop after `open` detaches while waiting for the guest)
- `status` → go to **Step 7** (status flow)
- `leave` → go to **Step 9** (leave flow)
- `help` or empty → go to **Step 8** (help flow)
- anything else → print `알 수 없는 명령어: <token>` and go to **Step 8**

---

### Step 1a — Open flow (host)

**Pick listen mode from the second `$ARGUMENTS` token:**

- Default (no second token, or anything besides `local`): **LAN mode** — bind `0.0.0.0`, advertise the machine's detected LAN IP. Works for two players on the **same local network** (e.g. same WiFi). The host's firewall must allow inbound TCP on the chosen port.
- Second token `local`: **loopback mode** — bind `127.0.0.1`, advertise `127.0.0.1:<port>`. Only works when host and guest are on the **same machine**.

**Resolve plugin root, generation, and — in LAN mode — the machine's LAN IP first:**

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
SESSION_CODE=$(node -e "process.stdout.write(require('crypto').randomBytes(3).toString('hex'))")
LAN_IP=$(node -e "const i=require('os').networkInterfaces();for(const k of Object.keys(i))for(const a of i[k]||[])if(a.family==='IPv4'&&!a.internal){process.stdout.write(a.address);process.exit(0)}process.stdout.write('127.0.0.1')")
```

**Initialize the host daemon.** In LAN mode (default) bind `0.0.0.0` and advertise the detected `LAN_IP` via `--join-host` so guests learn the concrete address to connect to. In loopback mode (`local`) bind `127.0.0.1` and omit `--join-host`.

```bash
# LAN mode (default):
"$P/bin/run-friendly-battle-turn.sh" --init-host --session-code "$SESSION_CODE" --generation "$GEN" --listen-host 0.0.0.0 --join-host "$LAN_IP" --port 0 --timeout-ms 300000 --player-name Host

# Loopback mode (second $ARGUMENTS token == local):
# "$P/bin/run-friendly-battle-turn.sh" --init-host --session-code "$SESSION_CODE" --generation "$GEN" --listen-host 127.0.0.1 --port 0 --timeout-ms 300000 --player-name Host
```

Parse the JSON envelope on stdout. Store `sessionId` — you MUST remember this for `/tkm:friendly-battle resume` and other subcommands later. Also read the `PORT:` line from stderr to get the bound port.

Set `ADVERTISED_HOST=$LAN_IP` in LAN mode, `ADVERTISED_HOST=127.0.0.1` in loopback mode.

Tell the user:
- "세션 코드: `<SESSION_CODE>`"
- "호스트 주소: `<ADVERTISED_HOST>:<PORT>`"
- "상대방에게 위 코드와 주소를 공유하고, 상대방이 `/tkm:friendly-battle join <code>@<ADVERTISED_HOST>:<port>` 를 실행하도록 안내하세요."
- **In LAN mode (default) only**, add: "⚠️ LAN 모드는 호스트 머신의 방화벽이 해당 TCP 포트(`<PORT>`)의 인바운드 연결을 허용해야 합니다. WSL2 호스트의 경우 Windows 방화벽도 확인하세요. 같은 WiFi/LAN 에 있는 상대방만 접속 가능합니다 (인터넷 경유 X). 같은 머신에서 두 터미널로 테스트하려면 `/tkm:friendly-battle open local` 을 사용하세요."
- "💡 친선전 턴 진행은 거의 mechanical 한 작업이니 Opus 대신 Sonnet 을 쓰면 훨씬 빠릅니다. 배틀 속도가 답답하면 `/model sonnet` 으로 전환하세요. (배틀 끝난 뒤 `/model` 로 원래 모델 복구. Haiku는 UI 입력 파싱이 불안정해서 비추천.)"
- "💤 게스트 접속 대기는 백그라운드 데몬이 알아서 처리합니다. (핸드셰이크 제한 시간은 5분이며, 그 전에 resume 하지 않으면 세션이 만료됩니다.)"

**Then immediately probe with `--status` once** (non-blocking, never fails) so that if the opponent has already connected we skip straight to the turn loop:

```bash
"$P/bin/run-friendly-battle-turn.sh" --status --session "$SESSION_ID" --generation "$GEN"
```

Dispatch on the returned envelope's `phase`:
- `phase === 'battle'` → transition to **Step 2** (turn loop) now.
- `phase === 'aborted'` → show `questionContext` (or REASON from stderr) and stop.
- anything else (`waiting_for_guest` / `handshake` / `connecting` / `ready`) → tell the user "아직 상대가 접속하지 않았습니다. 상대방이 붙었다 싶으면 `/tkm:friendly-battle resume` 을 실행하거나 저에게 '확인' / 'check' / 'resume' 이라고 말씀하세요. 그때 제가 다시 확인해서 배틀을 시작하겠습니다." and end your turn.

**Stand-by rule (follow-up turns in the same conversation):** while the session is in a pre-battle phase (sessionId still in scope but Step 2 not yet entered), treat any subsequent free-form user message that looks like a check request — exact matches or fuzzy Korean/English equivalents of `확인`, `상태`, `체크`, `check`, `status`, `resume`, `왔어`, `접속`, `들어왔`, `ready?`, `joined?` — as an explicit `/tkm:friendly-battle resume` invocation and run Step 1c. Do not treat unrelated chit-chat as a check request; in that case answer the user's actual message and remind them once that they can say `확인` to probe the session.

Do NOT poll or sleep-loop. Each status check is a single `--status` call that returns immediately.

---

### Step 1b — Join flow (guest)

Parse the second token of `$ARGUMENTS` as `<code>@<host>:<port>`. For example: `abc123@192.168.1.5:54321`.

If the format is missing or malformed, use AskUserQuestion to ask:
- Question: "접속 정보를 `<code>@<host>:<port>` 형식으로 입력해 주세요."
- Other only (no buttons)

Once you have the three parts (`SESSION_CODE`, `HOST`, `PORT`):

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
"$P/bin/run-friendly-battle-turn.sh" --init-join --session-code "$SESSION_CODE" --host "$HOST" --port "$PORT" --generation "$GEN" --timeout-ms 30000 --player-name Guest
```

Parse the JSON envelope on stdout. Store `sessionId`.

Tell the user:
- "호스트에 접속 중입니다... 잠시 기다려 주세요."
- "💡 친선전 턴 진행은 거의 mechanical 한 작업이니 Opus 대신 Sonnet 을 쓰면 훨씬 빠릅니다. 배틀 속도가 답답하면 `/model sonnet` 으로 전환하세요. (배틀 끝난 뒤 `/model` 로 원래 모델 복구. Haiku는 UI 입력 파싱이 불안정해서 비추천.)"
- "💤 호스트와의 핸드셰이크는 백그라운드 데몬이 처리합니다."

**Then immediately probe with `--status` once** (non-blocking, never fails):

```bash
"$P/bin/run-friendly-battle-turn.sh" --status --session "$SESSION_ID" --generation "$GEN"
```

Dispatch on the returned envelope's `phase`:
- `phase === 'battle'` → transition to **Step 2** (turn loop) now.
- `phase === 'aborted'` → show `questionContext` (or REASON from stderr) and stop.
- anything else (`handshake` / `connecting` / `ready`) → tell the user "호스트와의 핸드셰이크가 아직입니다. 배틀이 시작되었다 싶으면 `/tkm:friendly-battle resume` 을 실행하거나 저에게 '확인' / 'check' / 'resume' 이라고 말씀하세요. 그때 제가 다시 확인해서 배틀을 시작하겠습니다." and end your turn.

**Stand-by rule (same as Step 1a):** while pre-battle, treat fuzzy check keywords (`확인` / `상태` / `체크` / `check` / `status` / `resume` / `왔어` / `접속` / `들어왔` / `ready?` / `joined?`) from the user as an implicit `/tkm:friendly-battle resume` invocation and run Step 1c. Do not sleep-loop.

---

### Step 1c — Resume flow (host/guest, after `open`/`join` detached)

**Recover `sessionId` first.** If you already have `sessionId` in conversation scope (from the same Step 1a / Step 1b call), use it and skip this block. Otherwise — e.g. the conversation was compacted, handed off, or simply a while ago — ask the CLI which sessions are still alive:

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
"$P/bin/run-friendly-battle-turn.sh" --list-active --generation "$GEN"
```

The output is a JSON array (possibly empty) of non-terminal sessions whose daemon PID is still alive, sorted by `updatedAt` descending. Each entry includes `sessionId`, `role`, `phase`, `status`, `transport`, `updatedAt`. Dispatch on the array size:
- `[]` (empty) → tell the user "현재 활성화된 friendly-battle 세션이 없습니다. 먼저 `/tkm:friendly-battle open` 또는 `/tkm:friendly-battle join` 을 실행하세요." and stop.
- one entry → adopt its `sessionId` and proceed with the `--status` probe below.
- two or more → use AskUserQuestion to let the user pick which session to resume, labelling each option as `role=<role> code=<sessionCode> updated=<updatedAt>`. After the pick, adopt that `sessionId`.

**Then probe the daemon with `--status`** — this never blocks and never fails, so we can decide whether to enter the turn loop without waiting on an empty event queue.

```bash
"$P/bin/run-friendly-battle-turn.sh" --status --session "$SESSION_ID" --generation "$GEN"
```

Parse the JSON envelope on stdout. Dispatch on `phase`:

- `phase === 'battle'` → the peer has joined and the battle is live. Transition to **Step 2** (turn loop) — call `--wait-next-event` with the normal 60000ms timeout and continue as usual.
- `phase === 'waiting_for_guest'`, `phase === 'handshake'`, `phase === 'connecting'`, or `phase === 'ready'` → the peer is not fully connected yet. Tell the user "아직 상대가 접속하지 않았습니다. 상대방에게 접속을 부탁하고, 잠시 후 다시 '확인' / `/tkm:friendly-battle resume` 으로 확인해 주세요. 상태가 바뀌면 바로 배틀을 시작하겠습니다." and stop. (Same stand-by rule as Step 1a/1b — treat fuzzy check keywords in the next user message as another implicit resume.)
- `phase === 'aborted'` → the session failed (timeout, handshake error, or `leave`). Show `questionContext` if informative, else tell the user "세션이 종료되었습니다. `/tkm:friendly-battle open` 또는 `/tkm:friendly-battle join` 으로 새 세션을 여세요." and stop.
- `phase === 'finished'` → the battle already ended. Show `questionContext` (e.g. "You won!" / "You lost!" / "Battle ended.") and stop.

---

### Step 2 — Turn loop (shared after handshake)

**Non-negotiable input rule:** ALWAYS use **AskUserQuestion** for action selection. Never parse actions from plain chat. If the user types `1`, `공격`, `교체`, `항복`, or anything else in free chat during battle, ignore it as a battle command and re-open the correct AskUserQuestion UI.

**Turn loop:**

1. Call `--wait-next-event`:

```bash
"$P/bin/run-friendly-battle-turn.sh" --wait-next-event --session "$SESSION_ID" --generation "$GEN" --timeout-ms 60000
```

2. Parse the returned envelope. Dispatch on `status` (also check `phase`):

   - **`select_action`**: build a move-select AskUserQuestion (see **Step 3** below).
   - **`fainted_switch`**: go directly to **Step 6** (forced switch — no move menu).
   - **`victory`**: show "승리! 배틀이 끝났습니다." and stop.
   - **`defeat`**: show "패배... 배틀이 끝났습니다." and stop.
   - **`aborted`** (or `phase === 'aborted'`): the daemon now marks voluntary leave and peer disconnect with distinct `questionContext` strings so you can branch without sniffing stderr:
     - `questionContext === 'You left the battle.'` → show "배틀을 떠났습니다." and stop.
     - `questionContext === 'Opponent left the battle.'` → show "상대방이 배틀을 떠났습니다. (Opponent left the battle.)" and stop.
     - Any other `aborted` envelope (timeout, handshake failure, etc.) → read REASON from stderr, show it, and stop.
   - Anything else: loop back to step 1.

3. **Move-select AskUserQuestion** (when `status === 'select_action'`):

   Show the `questionContext` as the question text. Build buttons from `moveOptions` only:
   - Show exactly `min(moveOptions.length, 4)` buttons.
   - Label each: `{index}. {nameKo} ({pp}/{maxPp})` — indexes are 1-based as provided.
   - If a move has `disabled: true`, keep the slot visibly unavailable; do not replace with another action.
   - Never add switch or surrender as buttons.
   - Rely on the auto-provided `Other` field for non-move intents.

   **Non-negotiable input rule:** ALWAYS use **AskUserQuestion** for action selection. Never parse actions from plain chat. If the user types `1`, `공격`, `교체`, `항복`, or anything else in free chat during battle, ignore it as a battle command and re-open the correct AskUserQuestion UI.

   Parse the AskUserQuestion answer:
   - Button 1-4 on a shown move slot: call `--action`:

```bash
"$P/bin/run-friendly-battle-turn.sh" --action "move:$N" --session "$SESSION_ID" --generation "$GEN"
```

   - `Other` text matching `/^(교체|switch|change|s)$/i`: enter **Step 4** (switch menu).
   - `Other` text matching `/^(항복|surrender|quit|giveup|gg)$/i`: enter **Step 5** (surrender confirm).
   - Anything else in `Other`: show "알아들을 수 없어. 기술 버튼을 누르거나 \"교체\" / \"항복\" 을 입력해줘." and re-ask.

3a. After `--action` returns an ack envelope, parse `animationFrames`:
   - If `animationFrames.length === 0`: loop back to step 1 immediately.
   - If frames exist: display each frame's description as a message. After displaying all frames, loop back to step 1.

---

### Step 4 — Switch flow (user opens switch menu during a normal turn)

If the user's AskUserQuestion Other response matches `/^(교체|switch|change|s)$/i`, open a SECOND AskUserQuestion listing live party members from `partyOptions`:

- Label each live option as `{index}. {name} HP:{hp}/{maxHp}`
- Mark fainted members as unavailable (label with `기절`)
- Show up to 4 party members; more via Other text match by name

On button pick (index N, 1-based): run:

```bash
"$P/bin/run-friendly-battle-turn.sh" --action "switch:$N" --session "$SESSION_ID" --generation "$GEN"
```

On invalid Other (no name match): re-ask the switch AskUserQuestion.
On cancel or no live members available: return to the move AskUserQuestion.

After `--action switch:$N` returns an ack, loop back to Step 2 (wait-next-event).

---

### Step 5 — Surrender flow

Show a confirm AskUserQuestion:

- Question: `정말 항복할거야? 상대에게 승리가 돌아갑니다.`
- Options: `항복 확정`, `취소`

On `항복 확정`: run:

```bash
"$P/bin/run-friendly-battle-turn.sh" --action surrender --session "$SESSION_ID" --generation "$GEN"
```

On `취소`: return to the move AskUserQuestion (Step 3).

After `--action surrender` returns an ack, loop back to Step 2 (wait-next-event).

---

### Step 6 — Forced switch flow (after a Pokémon faints)

When `--wait-next-event` returns an envelope with `status === 'fainted_switch'`, skip the move AskUserQuestion entirely and go straight to the party AskUserQuestion from Step 4 — but with cancel disabled. The user MUST pick a live party member.

- Show `questionContext` (e.g. "Your Pokémon fainted — pick a replacement") as the question text.
- List all party members from `partyOptions`. Mark fainted members as unavailable.
- Do NOT offer a cancel option.
- On pick (index N, 1-based): run:

```bash
"$P/bin/run-friendly-battle-turn.sh" --action "switch:$N" --session "$SESSION_ID" --generation "$GEN"
```

After `--action switch:$N` returns an ack, loop back to Step 2. The daemon handles the forced switch without an extra AI turn.

---

### Step 7 — Status flow

Requires a stored `sessionId` from the current session. If no session is active, tell the user to run `/tkm:friendly-battle open` or `/tkm:friendly-battle join` first and stop.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
"$P/bin/run-friendly-battle-turn.sh" --status --session "$SESSION_ID" --generation "$GEN"
```

Parse the JSON envelope and report `phase` and `status` to the user. This command never fails — if the daemon is dead it returns a frozen snapshot from disk.

---

### Step 9 — Leave flow (/tkm:friendly-battle leave)

Requires a stored `sessionId` from the current session. If no session is active, tell the user to run `/tkm:friendly-battle open` or `/tkm:friendly-battle join` first and stop.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
"$P/bin/run-friendly-battle-turn.sh" --leave --session "$SESSION_ID" --generation "$GEN"
```

Read the ack envelope. The daemon transitions to `phase='aborted'` and shuts down. The peer sees a `battle_finished{reason:'disconnect'}` envelope on its next `wait_next_event` and should stop its own turn loop.

Tell the user: "배틀을 떠났습니다. 상대방의 화면에 나갔다는 알림이 표시됩니다. (You left the battle. Your opponent's terminal will see that you left.)"

---

### Step 8 — Help flow

Show:

```
/tkm:friendly-battle open                       — LAN 모드로 방 열기 (같은 네트워크의 다른 머신에서 접속 가능)
/tkm:friendly-battle open local                 — loopback 모드 (같은 머신의 두 터미널 테스트용)
/tkm:friendly-battle join <code>@<host>:<port>  — 호스트 방에 참가
/tkm:friendly-battle resume                     — open/join 후 상대가 접속한 뒤 배틀 턴 진행 시작
/tkm:friendly-battle status                     — 현재 세션의 phase / status 확인
/tkm:friendly-battle leave                      — 배틀 도중 나가기 (상대방에게 통보)
/tkm:friendly-battle help                       — 이 도움말 표시

/open 실행 후 출력된 세션 코드와 host:port 를 상대방과 공유하세요.
host/guest 모두 대기(handshake) 단계에서는 대화를 블로킹하지 않고 돌아옵니다 — 상대가 접속한 뒤 /tkm:friendly-battle resume 을 실행해 배틀을 시작하세요.
LAN 모드 (기본) 는 호스트 방화벽이 해당 포트의 인바운드 연결을 허용해야 합니다.
교체(switch) / 항복(surrender)은 배틀 중 기술 선택 AskUserQuestion의 Other에 입력하세요.
배틀 도중 나가려면 /tkm:friendly-battle leave 를 실행하세요.
```

---

## JSON Output Contract

```json
{
  "sessionId": "fb-<uuid>",
  "role": "host",
  "phase": "waiting_for_guest",
  "status": "waiting_for_guest",
  "questionContext": "Waiting for guest (code abc123) — see /tkm:friendly-battle status",
  "moveOptions": [
    { "index": 1, "nameKo": "용의파동", "pp": 10, "maxPp": 10, "disabled": false }
  ],
  "partyOptions": [
    { "index": 2, "name": "디아루가", "hp": 169, "maxHp": 169, "fainted": false }
  ],
  "animationFrames": [],
  "currentFrameIndex": 0
}
```

---

## Display Guidelines

- Show battle messages naturally in conversation, one per line.
- Keep prompts SHORT and UI-driven: `questionContext` plus the next AskUserQuestion.
- Respect `questionContext` when wording the question, but never use plain chat parsing instead of AskUserQuestion.
- Do NOT add strategy commentary or analysis.

## Usage

| Command | Description |
|---|---|
| `/tkm:friendly-battle open` | Open a friendly battle room (non-blocking — returns immediately after the daemon is ready) |
| `/tkm:friendly-battle join <code>@<host>:<port>` | Join an open room (non-blocking — returns after daemon handshake) |
| `/tkm:friendly-battle resume` | Pick up the turn loop once the peer has connected |
| `/tkm:friendly-battle status` | Check current session phase |
| `/tkm:friendly-battle leave` | Leave the battle mid-flow (opponent is notified) |
| `/tkm:friendly-battle help` | Show this help |

### Battle actions (via `--action` in bash blocks)

| Token | Description |
|---|---|
| `move:<N>` | Use move slot N (1-based, 1-4) |
| `switch:<N>` | Switch to party member N (1-based, 1-6) |
| `surrender` | Forfeit the battle (opponent wins) |
