# PR Stack After Remote Snapshot Handshake (PR #42)

Status: Draft
기준 브랜치: `feat/friendly-battle-remote-snapshot-handshake` (PR #42)
선행 문서: [`current-gap-after-remote-snapshot-handshake.md`](./current-gap-after-remote-snapshot-handshake.md)

이 문서는 **#42가 머지된 뒤 친선전을 "완주 가능한 친선전 제품 1차"로 끌고 가기 위한 PR 스택**을 기록한다.
목표 유저 surface 는 **Claude Code slash command** — shell CLI 가 아니라 `/tkm:friendly-battle open` / `/tkm:friendly-battle join <code>` 이다.

---

## 1. 제품 요구 (유저 관점)

호스트 머신 A 에서:

```
/tkm:friendly-battle open
```

→ 룸 코드 + "상대가 join 할 때까지 기다리는 중… (Ctrl+C 로 취소)" 안내 출력

게스트 머신 B 에서:

```
/tkm:friendly-battle join alpha-123
```

→ 즉시 호스트와 handshake → 양쪽 Claude 모두 `AskUserQuestion` 기반으로 매 턴 기술/교체/항복 선택 → 배틀 종료 후 요약 출력

핵심: **두 Claude Code 세션이 각자 AskUserQuestion 루프로 실제 턴 입력을 주고받는다.** 지금의 deterministic/자동 선택 경로는 사라진다.

---

## 2. 아키텍처 결정: foreground-blocking 모델

### 2-1. 초기 직관이었던 daemon 모델의 문제

처음에는 "호스트가 게스트 기다리는 동안 Claude 세션도 같이 block 되면 안 되니까, 데몬을 detach 해서 slash command 는 즉시 return 해야 한다"고 생각했다. 하지만 이 전제는 실제로 필요하지 않다:

- **#42 의 gap 문서 §5 "의도적 비범위"** 는 reconnect / 세션 복구 / 지속성을 명시적으로 제외한다. 데몬의 주 이득(세션 수명 관리)은 이미 비범위다.
- `/tkm:gym` 은 single-player 로컬 배틀임에도 **전체 배틀을 foreground-blocking** 으로 돌린다. 유저는 gym 시작 → 한 Claude 세션이 배틀에 매이는 걸 자연스럽게 받아들인다. 친선전도 "지금 친선전 하자" 결심 순간 세션이 매이는 건 동일한 멘탈 모델.
- 데몬 모델은 PID / orphan / stale state / double-fork 호환성 / 디버깅 불투명성 같은 비용을 계속 낸다. 모두 #42 이전엔 없던 부담.
- Memory "Status bar + conversation hybrid, not TUI process" 원칙과도 맞지 않는다. 데몬은 사실상 background TUI 다.

### 2-2. foreground-blocking 모델

- `/tkm:friendly-battle open` 은 하나의 tsx 프로세스를 실행하고 **그 프로세스가 배틀 끝까지 foreground 로 block** 한다.
  - 프로세스 수명 = slash command 수명 = Claude 한 턴의 수명
  - "게스트 대기" 구간은 같은 프로세스가 계속 listen 한다. 유저가 취소하려면 Ctrl+C
  - 게스트 접속 후엔 같은 프로세스가 그대로 turn loop 로 전이
- `/tkm:friendly-battle join <code>` 도 동일하게 하나의 tsx 프로세스가 handshake → turn loop 끝까지 block
- **양쪽 SKILL.md** 는 `/tkm:gym` 의 "단발 CLI + AskUserQuestion 루프" 패턴을 그대로 복제한다
- 상태 파일은 `~/.claude/tokenmon/friendly-battle/sessions/<id>.json` 에 저장하되, **프로세스간 rendezvous 용이 아니라** 상태 디버깅 / 관찰 / statusbar 렌더용이다. Transport 는 여전히 TCP (#40 의 `tcp-direct.ts`) 를 쓴다.

### 2-3. `/tkm:gym` 재사용 매핑

`skills/gym/SKILL.md` 의 각 단계를 친선전으로 매핑:

| gym 단계 | 친선전 매핑 |
|---|---|
| Step 1 init | `friendly-battle-turn.ts --init-host` / `--init-join <code>` |
| Step 2 AskUserQuestion rule | 동일. 입력은 반드시 AskUserQuestion, chat parsing 금지 |
| Step 3 action-select | 동일. 기술 선택 |
| Step 4 switch-menu | 동일. 교체 |
| Step 5 surrender confirm | 동일. 친선전 항복 |
| Step 6 fainted_switch | 동일. 기절 후 강제 교체 |
| Step 7 animation pump | 동일. `--refresh --frame <i>` 루프 |
| Step 8 end | 동일. 요약 출력 |

친선전 전용으로 추가되는 것:
- **Step 0 waiting-for-guest** (호스트 전용): guest hello 가 도착할 때까지 idle. 타임아웃 시 stage=`waiting_for_guest` 에러 출력 후 exit 1.
- **Step 1.5 ready handshake**: #42 의 remote handshake 프로토콜을 거친 뒤 Step 2 진입.

---

## 3. PR 스택 (의존 순서)

각 PR 은 **이전 PR 이 merge 된 후** 그 머지 커밋 위에 brachn 을 따는 linear stack 이다.
base 는 최종적으로 모두 `master` 로 rebase 되지만, 리뷰 중에는 이전 PR 브랜치를 base 로 쓴다.

```
master
 └─ feat/serverless-friendly-battle           (PR #40)
     └─ feat/friendly-battle-remote-snapshot-handshake  (PR #42)
         └─ feat/friendly-battle-pvp-driver            (PR43)
             └─ feat/friendly-battle-pvp-skill         (PR44)
                 └─ feat/friendly-battle-pvp-fainted   (PR45)
                     └─ feat/friendly-battle-pvp-leave (PR46)
                         └─ docs/friendly-battle-smoke (PR47)
```

### PR43 — Turn driver CLI (skill 없음, 인프라 전용)

**목적**: 배틀을 foreground 에서 돌리는 단발 tsx 엔트리 포인트를 만든다. JSON 을 찍고 종료하는 gym 의 `battle-turn.ts` 와 대칭.

**새 파일**:
- `src/cli/friendly-battle-turn.ts` — 서브커맨드:
  - `--init-host --session-code <code> [--listen-host 127.0.0.1] [--port 0] [--timeout-ms N] [--generation gen4]`
  - `--init-join --session-code <code> --host <host> --port <port> [--timeout-ms N] [--generation gen4]`
  - `--action <N>` (move slot 1-4)
  - `--action switch:<idx>`
  - `--action surrender`
  - `--refresh --frame <i> --session <id>`
  - `--refresh --finalize --session <id>`
  - `--status --session <id>`
- `src/friendly-battle/session-store.ts` — `~/.claude/tokenmon/friendly-battle/sessions/<id>.json` read/write. 파일 포맷은 disk state 로 디버깅/관찰용. **Transport rendezvous 로 쓰지 않는다.**
- `src/friendly-battle/turn-json.ts` — gym 과 동일 계약의 JSON 출력 포맷터 (`sessionId`, `phase`, `status`, `questionContext`, `moveOptions`, `partyOptions`, `animationFrames`, `currentFrameIndex`)

**수정 파일**:
- `src/friendly-battle/local-harness.ts` — deterministic choice 경로를 `TOKENMON_FORCE_DETERMINISTIC` flag 뒤로 격리. 기본값은 실제 입력 대기.
- `src/friendly-battle/battle-adapter.ts` — `submitChoice` 가 한쪽이 제출하고 반대쪽이 `waitForChoice` 로 block 할 수 있도록 promise-based wait API 추가.

**테스트**:
- `test/friendly-battle-session-store.test.ts` — disk round-trip, stale session GC, 동시 쓰기 race
- `test/friendly-battle-turn-driver.test.ts` — `--init-host` + `--init-join` 두 프로세스를 spawn 해 TCP 너머로 `--action move:1` → `--action move:0` → `--refresh --finalize` 까지 JSON 계약 검증
- `test/friendly-battle-turn-json.test.ts` — gym JSON contract 와의 호환성

**Out of scope**:
- SKILL.md 파일 (PR44)
- `fainted_switch` / surrender flow (PR45)
- 정상 leave semantics (PR46)
- 실제 AskUserQuestion 레이어 (PR44)

**왜 이 PR 에만 scope 되어야 하나**: 드라이버 레이어 리뷰는 "프로세스 2개 스폰 → TCP 너머로 JSON 계약 지키는지" 만 본다. UX 혼선 없음. 리뷰어가 `friendly-battle-turn.ts` 가 gym 의 `battle-turn.ts` 와 계약적으로 등가인지만 확인하면 됨.

---

### PR44 — `skills/friendly-battle/SKILL.md` + 기본 turn loop

**의존**: PR43

**목적**: 유저가 처음으로 `/tkm:friendly-battle open` / `/tkm:friendly-battle join <code>` 을 실제로 쓸 수 있게 만든다. 기본 기술/교체 선택만. faint/surrender 는 PR45.

**새 파일**:
- `skills/friendly-battle/SKILL.md` — description frontmatter + Execute 섹션. gym SKILL.md 의 Step 1-4, Step 7-8 을 친선전 이벤트에 맞춰 복제. waiting-for-guest 상태(Step 0) 와 join-with-code 상태 추가.

**수정 파일**:
- `src/cli/friendly-battle-turn.ts` — `--wait-next-event --session <id> --timeout-ms N` 서브커맨드 추가. JSON 이벤트 pump 구현.
- `src/friendly-battle/battle-adapter.ts` — engine-authoritative turn resolution 을 친선전 프로토콜로 노출

**테스트**:
- `test/friendly-battle-turn-driver-interactive.test.ts` — 양쪽 tsx 를 spawn 해 `--wait-next-event` → `--action move:1` → animationFrames pump → 다음 `--wait-next-event` 루프를 실제 TCP 로 검증
- `test/friendly-battle-skill-contract.test.ts` — SKILL.md 가 참조하는 tsx 경로와 서브커맨드가 실제로 존재하는지 static 검증 (skill rot 방지)

**Visual QA**: ⚠️ **memory 기준 필수**. 로컬 두 터미널에서 실제 `/tkm:friendly-battle open` / `/tkm:friendly-battle join` 실행 → AskUserQuestion 화면 스크린샷 → `oh-my-claudecode:visual-verdict` 리뷰 통과가 merge 조건.

**Out of scope**:
- faint forced-switch (PR45)
- 명시적 surrender (PR45)
- 정상 leave semantics (PR46)

---

### PR45 — Faint forced-switch + surrender UX

**의존**: PR44

**목적**: gym Step 5 (surrender confirm) + Step 6 (`fainted_switch`) 를 친선전에 이식한다.

**수정 파일**:
- `src/cli/friendly-battle-turn.ts` — `status: fainted_switch` / `status: surrender_pending` JSON 상태 추가
- `src/friendly-battle/battle-adapter.ts` — faint 감지 → 강제 교체 요청 이벤트 발행
- `skills/friendly-battle/SKILL.md` — forced-switch 및 surrender confirm 섹션 추가

**테스트**:
- `test/friendly-battle-fainted-switch.test.ts` — 상대 포켓몬이 기절하면 `status==fainted_switch` 가 뜨고 `--action switch:<idx>` 만 받는지
- `test/friendly-battle-surrender.test.ts` — `--action surrender` → 상대에게 `battle_finished{winner:other, reason:surrender}` 전달 확인

**Visual QA**: forced-switch AskUserQuestion 화면 + surrender confirm 화면 스크린샷 필수.

---

### PR46 — Leave / disconnect cleanup

**의존**: PR45

**목적**: 양쪽 어디서 끊어져도 일관된 세션 종료.

**수정 파일**:
- `src/cli/friendly-battle-turn.ts` — SIGTERM / SIGINT handler 로 정상 leave 패킷 송신 후 exit
- `src/friendly-battle/session-store.ts` — stale PID reap 로직
- `skills/friendly-battle/SKILL.md` — `leave` 액션을 안내 스텁에서 실제 SIGTERM 송신 흐름으로 교체

**테스트**:
- `test/friendly-battle-leave.test.ts` — 한쪽에서 SIGINT 보내면 반대쪽이 `battle_aborted{reason: peer_left}` 로 깔끔하게 종료되는지
- `test/friendly-battle-mid-battle-disconnect.test.ts` — TCP 강제 절단 시 #42 의 stage-specific 에러 포맷터가 올바르게 stage/next_action/retry_hint 를 찍는지

**Out of scope**: reconnect (비범위)

---

### PR47 — Same-network two-machine smoke evidence

**의존**: PR46 (여기까지 머지돼야 실제로 smoke 할 가치 있음)

**목적**: #42 의 gap 문서 §4-4 가 명시적으로 요구한 "실제 서로 다른 두 머신에서의 수동 smoke 로그" 를 남긴다.

**새 파일**:
- `docs/friendly-battle/validation/two-machine-smoke.md` — LAN IP 찾기, 방화벽/포트 허용 체크, 성공 로그 샘플 1개, 실패 케이스 로그 샘플 3개 (guest timeout, bad session code, mid-battle peer disconnect)
- (선택) `scripts/friendly-battle-smoke.sh` — 호스트/게스트 one-liner

**검증**: 실제 두 머신(또는 WSL2 + 별도 Linux 박스)에서 성공 smoke 1회 + 실패 3케이스 재현 로그 캡처. 문서에 붙여넣기.

**자동화 불가**: 이 PR 은 본질적으로 **수동 검증 evidence** 다. autopilot 범위 밖.

---

## 4. 병렬화 가능성

- PR43 → PR44 는 순차 필수 (드라이버 없이 skill 이 붙을 수 없음)
- PR45 / PR46 은 PR44 위에서 병렬 가능 (서로 겹치지 않는 파일)
- PR47 은 PR46 까지 끝나야 의미 있음

## 5. 메모리 원칙 체크리스트

- ✅ **OMC-independent design**: SKILL.md 는 omc 의존 없음, 순수 Claude Code primitives (AskUserQuestion + Bash + 디스크 state file)
- ✅ **Source/install separation**: skills/ 는 소스, 설치 시 plugin 경로로 복사되는 기존 패턴 그대로
- ✅ **Real assets**: 테스트는 실제 TCP 로 (#42 CI fix 와 동일), mock 금지
- ⚠️ **Visual QA**: PR44 / PR45 는 screenshot + visual-verdict 필수. merge gate
- ✅ **No destructive ops**: git tag, ~/.claude-test, 유저 데이터 건드리지 않음
- ✅ **Version sync**: friendly-battle 자체는 package.json 버전 변경 없음 (릴리즈 PR 아님)
- ✅ **SKILL.md 영어 기반**: 설명은 영어, 필요한 한국어 라벨만 (gym SKILL.md 관례)
- ✅ **No auto release**: 이 스택은 릴리즈 / 태그 / GitHub release 금지
- ✅ **Codex execution**: 각 PR 실행 단계는 `codex:rescue` 활용 가능 (autopilot 이 executor 를 Claude 로 돌려도, 복잡한 단계만 Codex 로 위임)
- ✅ **Battle system backlog 와 충돌 없음**: friendly-battle 은 phase 1 / 상태이상 v2 와 다른 파일

## 6. 알려진 리스크

1. **gym JSON contract 호환성**: `friendly-battle-turn.ts` 의 JSON 출력을 gym 과 동일하게 유지해야 SKILL.md 가 그대로 재사용 가능. PR43 테스트에서 이 contract 를 고정한다.
2. **AskUserQuestion 2턴 race**: 두 Claude 세션이 "동시에" AskUserQuestion 을 띄우고, 한쪽이 먼저 제출하면 반대쪽이 `--wait-next-event` 로 block 돼야 함. choice-channel 의 wait 계약을 PR43 테스트에서 엄격히 검증.
3. **`TOKENMON_FORCE_DETERMINISTIC` 레거시 경로**: 기존 `friendly-battle-local.ts` deterministic 경로를 지우면 #42 의 기존 테스트가 깨질 수 있음. PR43 에서는 지우지 말고 flag 뒤로 격리.
4. **Two-machine smoke**: 로컬 WSL2 + 별도 머신 조합이 없으면 VM 두 개로 대체. PR47 미완 상태로 PR46 까지 머지하는 건 허용.

## 7. 한 줄 결론 (PR43 시점)

**데몬 없음. gym 패턴 그대로. PR43(드라이버) → PR44(skill) → PR45(faint/surrender) → PR46(leave) → PR47(smoke). PR44/PR45 는 visual QA 필수.**

> **⚠️ PR44에서 이 결론 일부가 수정됨** — §8 참고.

## 8. Architecture revision (PR44 daemon reversal)

## 9. PR47 scope narrowed after PR46 LAN mode merge

PR46 commit `8631e4c` already landed the LAN-mode host behavior itself, so **PR47 no longer carries network-mode implementation scope**. The remaining PR47 deliverable is evidence collection plus a small helper wrapper:

- `docs/friendly-battle/validation/two-machine-smoke.md`
- `scripts/friendly-battle-smoke.sh`
- loopback reference log captured locally, with real two-machine logs left as USER ACTION placeholders

Current source of truth for that narrowed scope: [`pr47-smoke-evidence-plan.md`](./pr47-smoke-evidence-plan.md).

In the stacked checklist, treat this as **PR47 Option A**: document the manual two-machine smoke procedure and collect evidence after LAN mode has already shipped.

PR43까지는 "데몬 없음, gym 패턴 그대로, 단일 프로세스 foreground-blocking" 을 전제로 작업했다. PR44 실행에 들어가자마자 이 전제가 깨졌다.

### 8-1. 발견한 모순
`src/friendly-battle/spike/tcp-direct.ts` 의 호스트/게스트 API 는 전부 **라이브 소켓 기반** 이다 (`waitForGuestJoin`, `markHostReady`, `waitUntilCanStart`, `startBattle`, `waitForGuestChoice`, `sendBattleEvents`, `submitChoice`, `waitForBattleEvent`). TCP 파일 디스크립터는 **tsx 프로세스 경계를 넘어갈 수 없다** — 디스크로 직렬화되지 않기 때문이다.

gym 의 "단발 CLI + 디스크 state" 패턴은 gym 의 모든 state 가 로컬이기 때문에 성립한다. 친선전은 state 의 절반이 상대 머신에 있고 TCP 소켓으로 묶여 있어서 이 패턴이 성립하지 않는다.

### 8-2. PR44 에서 반영한 최소 데몬 모델
- `--init-host` / `--init-join` 는 `src/friendly-battle/daemon.ts` 를 **detached 자식 프로세스로 fork** 한다. 이 자식(데몬)이 TCP 소켓과 배틀 런타임을 붙잡고 있는다.
- 데몬은 로컬 전용 UNIX 소켓을 `$CLAUDE_CONFIG_DIR/tokenmon/<gen>/friendly-battle/sessions/<id>.sock` 에 연다.
- 액션 서브커맨드 (`--wait-next-event`, `--action move:N`, `--status`) 는 **gym 과 똑같이 단발 tsx 호출** 이다 — UNIX 소켓 열어서 JSON 한 줄 쓰고 한 줄 읽고 닫는다.
- 세션 레코드가 PR43 의 `reapStaleFriendlyBattleSessions` 인프라를 그대로 쓰면서 `daemonPid` + `socketPath` 필드로 확장됐다. 고아 데몬은 다음 스캔 때 치워진다.
- **유저 관점에서는 바뀐 게 없다.** `/tkm:friendly-battle open` 은 여전히 한 번의 연속적인 배틀 세션처럼 보인다. 데몬은 쉘 파이프처럼 보이지 않는 구현 디테일이다.

### 8-3. 로드맵이 "데몬 금지"라고 말한 건 사실 이걸 말하는 게 아니었다
§2 의 데몬 반대는 실제로는 **유저에게 노출되는 persistence / reconnect / "방 열고 딴 데 가서 놀다 와"** 시맨틱을 겨냥한 것이었다. 이 세 가지는 PR44 에서도 그대로 비범위다 — reconnect 없음, "열어두고 나가기" 없음, 데몬은 배틀이 끝나면 스스로 종료한다. 데몬을 유저 관점의 서비스가 아니라 단일 배틀 세션의 수명과 정확히 일치하는 자식 프로세스로 제한했다.

### 8-4. 수정된 한 줄 결론
**PR44 에서 숨겨진 최소 데몬 도입. 유저 경험은 그대로 gym 패턴. PR43(드라이버) → PR44(daemon + skill) → PR45(faint/surrender) → PR46(leave) → PR47(smoke). PR44/PR45 는 visual QA 필수.**

### 8-5. 상세 계획 위치
PR44 의 task 별 TDD 계획은 `docs/friendly-battle/roadmap/pr44-skill-and-turn-loop-plan.md` 에 있다. Daemon lifecycle, IPC protocol, 각 task 의 파일/테스트 구성은 그 문서에서 확인할 것.

## 관련 문서

- [Friendly Battle 문서 인덱스](../README.md)
- [아키텍처 개요](../architecture/overview.md)
- [Current gap](./current-gap-after-remote-snapshot-handshake.md)
- [PR 로드맵](./pr-roadmap.md)
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)
