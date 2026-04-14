# Local Two-Terminal Visual QA Guide — Friendly Battle PvP

상태: Draft
대상 PR 스택: #40 → #42 → #43 → #44 → #45 → #46
작성 목적: PR #44~#46 이 머지 전에 실제 `/tkm:friendly-battle` 플로우가 한 머신의 두 터미널에서 어떻게 보이고 동작하는지 누구든 직접 재현할 수 있도록 한다.

이 가이드는 **두 대의 머신을 준비하지 않아도** PvP 친선전의 UI/UX 전 구간 (대기 → 핸드셰이크 → 턴 입력 → 기절 교체 → 항복 → leave) 을 눈으로 확인할 수 있는 절차를 담고 있다. 진짜 LAN 건너 두 머신 smoke 는 PR#47 에서 따로 다룬다.

---

## 1. 무엇을 테스트하는지

현재 친선전 PR 스택은 6단계로 쌓여 있다. 각 PR 이 무엇을 추가하는지와 visual QA 에서 봐야 할 포인트는 다음과 같다.

| PR | 브랜치 | 추가하는 것 | Visual QA 체크 포인트 |
|---|---|---|---|
| #40 | `feat/serverless-friendly-battle` | 친선전 foundation (transport, snapshot, session state) | (이 가이드 범위 밖 — 이미 머지된 기반) |
| #42 | `feat/friendly-battle-remote-snapshot-handshake` | remote 핸드셰이크 에러 포맷, local interactive loop | STAGE / FAILED_STAGE / REASON 메시지 포맷 |
| #43 | `feat/friendly-battle-pvp-driver` | `friendly-battle-turn` CLI (init-host / init-join) | 아직 skill 없음 — CLI 단계만 존재 |
| #44 | `feat/friendly-battle-pvp-skill` | `/tkm:friendly-battle` skill + daemon + turn loop | **open / join / 기본 턴 AskUserQuestion** |
| #45 | `feat/friendly-battle-pvp-fainted` | fainted forced switch + 항복 confirm | **기절 후 교체 메뉴 / 항복 확인 창** |
| #46 | `feat/friendly-battle-pvp-leave` | `/tkm:friendly-battle leave` + peer disconnect 정리 | **내가 떠나기 / 상대가 떠남** 메시지 |

**결과적으로 테스트할 것**: 한 머신의 두 Claude Code 세션이 서로 친선전을 열고, 턴을 주고받고, 기절 교체와 항복을 처리하고, 중간에 leave 로 빠져나오는 전체 흐름.

---

## 2. 사전 준비물

1. **이 리포지토리 체크아웃** (어느 위치든 OK) 또는 **tkm 플러그인 install 경로** (`~/.claude/plugins/marketplaces/tkm/` 가 git clone 이면 그대로 재사용 가능)
2. **Claude Code CLI** 설치됨 (`claude --version` 으로 확인)
3. **Node.js 22+** (`node --version`)
4. **tokenmon 플러그인이 이미 한 번 이상 실행되어 party 가 준비된 상태**. 아직 한 번도 안 돌렸다면:
   - 한 번 Claude Code 를 열고 `/tkm:setup` 실행해서 스타터 포켓몬 선택 + party 최소 1마리 이상 확보
   - 가능하면 2마리 이상 (fainted forced switch 테스트하려면 백업 포켓몬 필요)

### 선택: fainted 테스트를 위한 2마리 party 구성

기절 교체 플로우를 보려면 파티에 최소 2마리가 필요하다. Claude Code 에서:

```
/tkm:tkm party add <pokemon-name>   # 두 번째 포켓몬 추가
```

또는 수동으로 `~/.claude/tokenmon/gen4/config.json` 의 `"party": [...]` 에 두 개의 progression key 를 넣어둔다.

---

## 3. PR 스택을 플러그인에 적용하기

플러그인 install 경로 (`~/.claude/plugins/marketplaces/tkm/`) 가 **git clone** 인지 먼저 확인한다.

```bash
ls ~/.claude/plugins/marketplaces/tkm/.git 2>/dev/null && echo "git clone ✅" || echo "NOT a git clone ❌"
```

### 3-1. git clone 인 경우 (권장 경로)

```bash
# 1) 현재 HEAD 를 백업 (나중에 원상복구할 때 씀)
git -C ~/.claude/plugins/marketplaces/tkm rev-parse HEAD > ~/tkm-plugin-old-head.txt
cat ~/tkm-plugin-old-head.txt

# 2) feat/* 브랜치를 fetch 할 수 있도록 fetch refspec 을 확장
#    (plugin clone 은 기본적으로 master 만 tracking 하는 경우가 많음)
git -C ~/.claude/plugins/marketplaces/tkm fetch origin '+refs/heads/feat/*:refs/remotes/origin/feat/*'

# 3) 최종 PR46 브랜치로 체크아웃 (이 한 줄이 PR42→#43→#44→#45→#46 전부 반영)
git -C ~/.claude/plugins/marketplaces/tkm checkout -b feat/friendly-battle-pvp-leave origin/feat/friendly-battle-pvp-leave

# 4) 적용 확인
git -C ~/.claude/plugins/marketplaces/tkm log --oneline -5
ls ~/.claude/plugins/marketplaces/tkm/skills/friendly-battle/SKILL.md
ls ~/.claude/plugins/marketplaces/tkm/src/friendly-battle/daemon.ts
```

마지막 두 `ls` 명령이 파일 경로를 출력하면 플러그인이 새 코드에 붙어 있는 것이다.

### 3-2. git clone 이 아닌 경우

플러그인 install 이 tarball/cache 형태면 디렉토리 전체를 수동으로 교체해야 한다.

```bash
# 임시로 리포지토리를 fresh clone
git clone https://github.com/ThunderConch/tkm.git /tmp/tkm-visualqa
git -C /tmp/tkm-visualqa checkout feat/friendly-battle-pvp-leave

# 기존 plugin 디렉토리 백업
mv ~/.claude/plugins/marketplaces/tkm ~/.claude/plugins/marketplaces/tkm.backup.$(date +%s)

# 새 체크아웃으로 교체 (또는 symlink)
cp -r /tmp/tkm-visualqa ~/.claude/plugins/marketplaces/tkm

# 확인
ls ~/.claude/plugins/marketplaces/tkm/skills/friendly-battle/SKILL.md
```

---

## 4. Claude Code 세션 재시작이 필요한 이유

SKILL.md 파일은 **Claude Code 세션이 시작될 때 한 번만 읽는다**. 플러그인을 새 브랜치로 옮겨도 **지금 돌고 있는 Claude Code 세션은 구버전 친선전 skill 을 물고 있다.** 그러니까:

1. 플러그인 checkout 은 **세션 바깥에서** 먼저 끝낸다.
2. 그 다음에 새 Claude Code 터미널을 연다 (또는 기존 세션 종료 후 재실행).
3. 새 세션에서 `/tkm:friendly-battle` 을 치면 새 skill 이 잡힌다.

**Tip**: 스킬이 업데이트됐는지 빠르게 확인하려면 새 세션에서 `/tkm:friendly-battle help` 치면 usage 표 맨 아래에 `leave` 명령이 들어있는지 확인하면 된다. 없으면 플러그인이 여전히 구버전.

---

## 5. 두 터미널 준비하기

같은 머신의 두 Claude Code 세션이 같은 `CLAUDE_CONFIG_DIR` 을 쓰면 session-store 파일과 tokenmon state 를 공유해서 간헐적으로 race 가 난다. **게스트 쪽만 격리된 프로필**로 돌리면 깔끔하다.

### 5-1. 게스트용 격리 프로필 만들기

```bash
# 호스트의 tokenmon 데이터를 게스트 전용 dir 로 복사
mkdir -p ~/.claude-fb-guest/tokenmon/gen4

cp ~/.claude/tokenmon/gen4/config.json ~/.claude-fb-guest/tokenmon/gen4/ 2>/dev/null
cp ~/.claude/tokenmon/gen4/state.json  ~/.claude-fb-guest/tokenmon/gen4/ 2>/dev/null
cp ~/.claude/tokenmon/global-config.json ~/.claude-fb-guest/tokenmon/ 2>/dev/null

# 확인
cat ~/.claude-fb-guest/tokenmon/gen4/config.json | head
```

### 5-2. tmux 또는 두 터미널창 레이아웃

#### tmux (권장)

```bash
tmux new -s fbqa

# 세션 안에서 Ctrl-b, " (수평 분할) 또는 Ctrl-b, % (수직 분할)
# 위: 호스트용 터미널
# 아래: 게스트용 터미널
```

#### 그냥 두 터미널창

터미널 앱의 새 창 / 새 탭을 두 개 띄우기만 해도 된다.

### 5-3. 각 터미널에서 Claude Code 실행

**터미널 1 — 호스트**

```bash
cd ~/.claude/plugins/marketplaces/tkm   # 어디든 상관 없음, 그냥 기준점
claude
```

Claude Code 프롬프트에서:

```
/tkm:friendly-battle open
```

skill 이 다음과 같이 진행된다:
1. `$P/bin/tsx-resolve.sh` 로 `friendly-battle-turn.ts --init-host` 를 forking 해서 데몬을 띄움
2. 데몬이 TCP 소켓을 `--listen-host 127.0.0.1 --port 0` (ephemeral) 으로 listen
3. DAEMON_READY 가 찍히고 parent 는 exit
4. Claude Code 가 session code + port 를 출력하고 상대 입장을 기다리는 상태가 됨

이 때 출력되는 **session code** 와 **port** 를 메모해둔다. 예를 들면:
```
🤝 Session code: 9a3f7c
Port: 43817
Waiting for guest (ctrl+c to cancel) ...
```

**터미널 2 — 게스트 (격리 프로필)**

```bash
CLAUDE_CONFIG_DIR=~/.claude-fb-guest claude
```

Claude Code 프롬프트에서:

```
/tkm:friendly-battle join 9a3f7c@127.0.0.1:43817
```

(session code 와 port 를 터미널 1 에서 본 값으로 바꿔 입력)

두 세션이 handshake 를 끝내면 양쪽 모두 첫 턴의 move-select AskUserQuestion 이 뜬다.

---

## 6. 기능별 Visual QA 체크리스트

### 6-1. PR #44 — 기본 턴 루프

- [ ] 호스트 터미널: `/tkm:friendly-battle open` 후 "waiting for guest" 상태가 AskUserQuestion 이 아닌 **대기 텍스트**로 렌더링되는지 확인
- [ ] 게스트 터미널: `/tkm:friendly-battle join ...` 후 연결 → 핸드셰이크 → 첫 move-select AskUserQuestion 이 뜨는지 확인
- [ ] 양쪽 모두 `moveOptions` 4개 (또는 보유 기술 수만큼) 버튼이 표시되는지 확인
- [ ] 한 턴 주고받기: 양쪽 모두 move 버튼 1을 눌러서 턴 resolution message 가 양쪽 화면에 표시되는지 확인
- [ ] 다음 턴으로 넘어가는지 (choices_requested 재렌더링) 확인

**스크린샷 대상**:
- 호스트의 waiting state
- 게스트의 첫 move AskUserQuestion
- 양쪽의 turn_resolved 메시지

### 6-2. PR #45 — Forced switch (기절 교체)

포켓몬 HP 가 낮을 때 상대의 공격을 맞고 기절하면 `status='fainted_switch'` 가 뜬다. 이걸 재현하려면:

1. 호스트 party 에 HP 낮은 포켓몬 (Lv.5 정도) 과 백업 포켓몬 (Lv.20+) 두 마리 이상이 있어야 한다. 위 §2 의 2마리 party 구성을 참고.
2. 게스트는 강한 포켓몬 (가능하면 레벨 차이가 많이 나는) 한 마리 이상.
3. 게스트의 게스트 프로필에서 강한 move 를 선택해서 호스트의 약한 포켓몬을 KO.
4. 그 다음 턴에서 **호스트 쪽**에 `fainted_switch` 메뉴가 뜬다.

**Note**: gen4 damage math 는 결정적이지 않아서 매번 KO 는 아닐 수 있다. 2~3턴 안에 KO 되도록 HP/레벨 차이를 크게 잡는 게 좋다.

- [ ] 기절 직후 호스트 화면에 **move 버튼 없이** 파티 버튼만 있는 AskUserQuestion 이 뜨는지 확인 (moveOptions 가 비어야 함, partyOptions 만 채워져야 함)
- [ ] Forced switch 는 **cancel 버튼이 없어야 한다** — 유저는 무조건 살아있는 파티원 중 하나를 선택해야 함
- [ ] 백업 포켓몬 선택 후 배틀이 이어지는지 확인 (`choices_requested {phase: waiting_for_choices}` 로 복귀)

**스크린샷 대상**:
- Forced switch AskUserQuestion (move 없음, 파티만)
- 교체 후 이어지는 다음 턴의 move AskUserQuestion

### 6-3. PR #45 — 항복 (surrender)

- [ ] move AskUserQuestion 에서 **Other 필드**에 `항복` 또는 `surrender` 입력
- [ ] 별도의 **항복 확인 다이얼로그**가 뜨는지 확인 ("정말 항복할거야? 상대에게 승리가 돌아갑니다.")
- [ ] 옵션: `항복 확정` / `취소` 두 개 버튼
- [ ] `취소` 선택 시 원래 move AskUserQuestion 으로 돌아가는지 확인
- [ ] `항복 확정` 선택 시 배틀이 즉시 끝나고 상대에게 승리 메시지가 뜨는지 확인

**스크린샷 대상**:
- 항복 확인 다이얼로그
- 양쪽의 battle_finished 메시지 (승자: 상대, reason: surrender)

### 6-4. PR #46 — Leave / 중도 이탈

이건 배틀 중 어느 순간에나 할 수 있다. 한 턴 정도 주고받은 후 시도하는 걸 추천.

- [ ] 호스트 터미널에서 `/tkm:friendly-battle leave` 입력
- [ ] 호스트 쪽 출력: `"You left the battle."` 메시지가 깨끗하게 뜨는지 확인 (timeout / hang 없음)
- [ ] 게스트 터미널: 다음 `--wait-next-event` 루프가 자동으로 깨어나서 **`"Opponent left the battle."`** 메시지를 보여주고 루프가 종료되는지 확인
- [ ] 게스트가 자동으로 stop 되는지 (새 AskUserQuestion 이 안 뜸)

**스크린샷 대상**:
- 호스트의 "You left the battle." 출력
- 게스트의 "Opponent left the battle." 출력

**Note**: 게스트가 `/tkm:friendly-battle leave` 를 먼저 실행해도 동일한 플로우가 반대로 재현된다 (게스트가 "you left", 호스트가 "opponent left"). 여유 있으면 양방향 모두 확인.

---

## 7. `visual-verdict` 에 스크린샷 넘기기

모든 스크린샷을 한 폴더에 모은 후:

```
/oh-my-claudecode:visual-verdict
# 프롬프트에서 스크린샷 경로를 넘기면 각 화면을 비교 리뷰해준다.
```

리뷰 결과가 통과면 대응하는 PR 을 GitHub 에서 draft → ready 로 전환.

---

## 8. 돌아가기 (원상 복구)

QA 끝나고 플러그인을 이전 상태로 되돌리려면:

```bash
OLD=$(cat ~/tkm-plugin-old-head.txt)
git -C ~/.claude/plugins/marketplaces/tkm checkout master
# 또는 정확히 이전 HEAD 로 hard reset
# git -C ~/.claude/plugins/marketplaces/tkm reset --hard "$OLD"

# 게스트 프로필 정리
rm -rf ~/.claude-fb-guest

# 혹시 데몬 세션 파일이 남았다면
rm -f ~/.claude/tokenmon/gen*/friendly-battle/sessions/*.json
rm -f ~/.claude/tokenmon/gen*/friendly-battle/sessions/*.sock
rm -rf ~/.claude-fb-guest/tokenmon/gen*/friendly-battle/sessions 2>/dev/null
```

`git checkout master` 는 네가 원래 썼던 master HEAD 로 바로 복귀시킨다. 로컬 WIP 가 master 에 쌓여 있었다면 그대로 보존된다.

---

## 9. 트러블슈팅

### 9-1. `/tkm:friendly-battle` 치면 "Unknown command" 가 뜸

- 플러그인 checkout 이 안 됐거나 Claude Code 세션을 재시작 안 한 경우
- 확인: `ls ~/.claude/plugins/marketplaces/tkm/skills/friendly-battle/SKILL.md` 가 존재해야 함
- 재시도: Claude Code 완전 종료 후 새 세션에서 `/tkm:friendly-battle help` 로 스킬 로드 확인

### 9-2. `open` 이후 "Waiting for guest" 가 timeout 으로 실패함

- `--timeout-ms` 기본값은 300000 (5분). 5분 안에 게스트가 붙어야 함
- 게스트 쪽 session code 또는 port 가 다르면 handshake 실패로 귀결됨 — 호스트 터미널에 찍힌 값을 정확히 복사
- 방화벽이 loopback 을 막는 경우는 드물지만 WSL 등 특이 환경이라면 `127.0.0.1` 대신 `localhost` 로 시도

### 9-3. 게스트가 join 할 때 "bad session code" 에러

- session code 가 대소문자/공백까지 정확히 일치해야 함
- 호스트를 한 번 Ctrl+C 로 끈 다음 다시 `/tkm:friendly-battle open` 으로 새 code 를 받아서 재시도

### 9-4. 한 세션에서 데몬이 좀비로 남음

- `ps aux | grep friendly-battle` 로 확인
- 살아있으면 `kill <pid>` 로 종료
- session 파일도 함께 정리: `rm -rf ~/.claude/tokenmon/gen*/friendly-battle/sessions/`

### 9-5. 양쪽 다 `choices_requested` 가 왔는데 상대 move 를 무한 대기

- 대부분 한쪽 AskUserQuestion 을 닫지 않은 상태. 두 터미널 모두 move 버튼을 눌러야 turn 이 resolve 됨
- 5분 안에 둘 다 submit 안 하면 transport timeout 으로 종료됨 (정상 동작)

### 9-6. Fainted switch 가 안 재현됨

- party 포켓몬 두 마리 중 하나가 반드시 기절해야 함 (HP 0)
- 레벨 차이가 너무 작으면 OHKO 가 안 나서 여러 턴 공격해야 함
- 빠른 재현 팁: 수동으로 `~/.claude-fb-guest/tokenmon/gen4/state.json` 의 guest 포켓몬 level 을 50 쯤으로, 호스트 쪽 약한 포켓몬 level 을 3 쯤으로 설정하면 한 방에 기절

---

## 10. 체크리스트 요약

```
[ ] 플러그인이 feat/friendly-battle-pvp-leave 로 체크아웃됨
[ ] Claude Code 세션 재시작 후 /tkm:friendly-battle help 에 leave 가 보임
[ ] 호스트/게스트 격리 프로필 준비 (~/.claude-fb-guest)
[ ] 두 터미널에서 open / join 성공
[ ] PR44: 기본 턴 루프 스크린샷 (waiting / 첫 move / 턴 resolve)
[ ] PR45: forced switch 스크린샷 (기절 후 party-only AskUserQuestion)
[ ] PR45: surrender confirm 스크린샷 (yes/no 다이얼로그)
[ ] PR46: leave 스크린샷 (you left / opponent left)
[ ] visual-verdict 리뷰 통과
[ ] 플러그인 원복 (git checkout master + ~/.claude-fb-guest 정리)
```

---

## 관련 문서

- [PR stack roadmap](../roadmap/pr-stack-after-remote-snapshot-handshake.md)
- [PR44 plan](../roadmap/pr44-skill-and-turn-loop-plan.md)
- [PR45 plan](../roadmap/pr45-fainted-surrender-plan.md)
- [PR46 plan](../roadmap/pr46-leave-plan.md)
- [Friendly battle validation index](./README.md)
