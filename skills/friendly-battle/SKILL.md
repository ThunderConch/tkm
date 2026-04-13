---
description: "Tokenmon friendly battle. Real PvP turn loop against another player on the same network. Korean: 친선전, 친선 배틀, 배틀, 대전, friendly battle"
---

Open a friendly battle session and fight another player in real-time turn-based combat. One player opens a room (`open`), shares the session code + host:port with their opponent, who then joins (`join`). Switch / surrender / leave are not yet available (coming in PR45/46).

## Execute

### Step 0 — Parse `$ARGUMENTS`

Read the first token of `$ARGUMENTS`:

- `open` → go to **Step 1a** (open flow)
- `join` → go to **Step 1b** (join flow); the second token must be `<code>@<host>:<port>`
- `status` → go to **Step 3** (status flow)
- `help` or empty → go to **Step 4** (help flow)
- anything else → print `알 수 없는 명령어: <token>` and go to **Step 4**

---

### Step 1a — Open flow (host)

**Initialize the host daemon:**

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
SESSION_CODE=$(node -e "process.stdout.write(require('crypto').randomBytes(3).toString('hex'))")
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --init-host --session-code "$SESSION_CODE" --generation "$GEN" --listen-host 127.0.0.1 --port 0 --timeout-ms 300000 --player-name Host
```

Parse the JSON envelope on stdout. Store `sessionId` and `questionContext`. Also read the `PORT:` line from stderr to get the bound port.

Tell the user:
- "세션 코드: `<SESSION_CODE>`"
- "호스트 주소: `127.0.0.1:<PORT>`"
- "상대방에게 위 코드와 주소를 공유하고, 상대방이 `/tkm:friendly-battle join <code>@127.0.0.1:<port>` 를 실행하도록 안내하세요."
- "게스트가 접속할 때까지 잠시 기다립니다..."

Then enter the **wait-for-guest polling loop**:

All subsequent friendly-battle-turn invocations use the same launcher:
`"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" <flags>` — keep `$P`, `GEN`, and `sessionId` in scope.

Poll loop:

```bash
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --wait-next-event --session "$SESSION_ID" --generation "$GEN" --timeout-ms 60000
```

- If the returned envelope has `phase === 'battle'`: transition to **Step 2** (turn loop).
- If the returned envelope has `phase === 'aborted'`: read the REASON from stderr, show it to the user, and stop.
- Otherwise (still `waiting_for_guest`): repeat the poll (up to 5 times total, then stop with a "게스트가 응답하지 않습니다" message).

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
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --init-join --session-code "$SESSION_CODE" --host "$HOST" --port "$PORT" --generation "$GEN" --timeout-ms 30000 --player-name Guest
```

Parse the JSON envelope on stdout. Store `sessionId`.

Tell the user: "호스트에 접속 중입니다... 잠시 기다려 주세요."

Then poll with `--wait-next-event` (same loop as Step 1a) until `phase === 'battle'`, then transition to **Step 2**.

If `phase === 'aborted'`: show the REASON from stderr and stop.

---

### Step 2 — Turn loop (shared after handshake)

**Non-negotiable input rule:** ALWAYS use **AskUserQuestion** for action selection. Never parse actions from plain chat. If the user types `1`, `공격`, `교체`, `항복`, or anything else in free chat during battle, ignore it as a battle command and re-open the correct AskUserQuestion UI.

**Turn loop:**

1. Call `--wait-next-event`:

```bash
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --wait-next-event --session "$SESSION_ID" --generation "$GEN" --timeout-ms 60000
```

2. Parse the returned envelope. Dispatch on `status`:

   - **`select_action`**: build a move-select AskUserQuestion (see below).
   - **`victory`**: show "승리! 배틀이 끝났습니다." and stop.
   - **`defeat`**: show "패배... 배틀이 끝났습니다." and stop.
   - **`aborted`**: read REASON from stderr, show it, and stop.
   - Anything else: loop back to step 1.

3. **Move-select AskUserQuestion** (when `status === 'select_action'`):

   Show the `questionContext` as the question text. Build buttons from `moveOptions` only:
   - Show exactly `min(moveOptions.length, 4)` buttons.
   - Label each: `{index}. {nameKo} ({pp}/{maxPp})` — indexes are 1-based as provided.
   - If a move has `disabled: true`, keep the slot visibly unavailable; do not replace with another action.
   - Never add switch or surrender as buttons.
   - Rely on the auto-provided `Other` field for non-move intents.

   Parse the AskUserQuestion answer:
   - Button 1-4 on a shown move slot: call `--action`:

```bash
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --action "move:$N" --session "$SESSION_ID" --generation "$GEN"
```

   - `Other` text matching `/^(교체|switch|change)$/i`: respond with "교체는 PR45에서 추가됩니다. 기술 버튼을 선택해 주세요." and re-ask the same AskUserQuestion.
   - `Other` text matching `/^(항복|surrender|quit|gg)$/i`: respond with "항복은 PR45에서 추가됩니다. 기술 버튼을 선택해 주세요." and re-ask the same AskUserQuestion.
   - Anything else in `Other`: show "알아들을 수 없어. 기술 버튼을 눌러줘." and re-ask.

4. After `--action` returns an ack envelope, parse `animationFrames`:
   - If `animationFrames.length === 0`: loop back to step 1 immediately.
   - If frames exist: display each frame's description as a message (no sleep loop for PR44). After displaying all frames, loop back to step 1.

---

### Step 3 — Status flow

Requires a stored `sessionId` from the current session. If no session is active, tell the user to run `/tkm:friendly-battle open` or `/tkm:friendly-battle join` first and stop.

```bash
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
GEN=$(node -e "try{const g=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude/tokenmon/global-config.json'),'utf-8'));console.log(g.active_generation||'gen1')}catch{console.log('gen1')}")
"$P/bin/tsx-resolve.sh" "$P/src/cli/friendly-battle-turn.ts" --status --session "$SESSION_ID" --generation "$GEN"
```

Parse the JSON envelope and report `phase` and `status` to the user. This command never fails — if the daemon is dead it returns a frozen snapshot from disk.

---

### Step 4 — Help flow

Show:

```
/tkm:friendly-battle open                       — 방을 열고 게스트를 기다림
/tkm:friendly-battle join <code>@<host>:<port>  — 호스트 방에 참가
/tkm:friendly-battle status                     — 현재 세션의 phase / status 확인
/tkm:friendly-battle help                       — 이 도움말 표시

/open 실행 후 출력된 세션 코드와 host:port 를 상대방과 공유하세요.
교체 / 항복 / 나가기는 PR45/46에서 추가됩니다.
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
| `/tkm:friendly-battle open` | Open a friendly battle room |
| `/tkm:friendly-battle join <code>@<host>:<port>` | Join an open room |
| `/tkm:friendly-battle status` | Check current session phase |
| `/tkm:friendly-battle help` | Show this help |
