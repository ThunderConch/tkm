# PR47 — Two-machine smoke evidence (Option A)

> Status: plan drafted, implementation delegated to Codex
> Base branch: `feat/friendly-battle-pvp-leave` (PR46, already contains LAN mode)
> Head branch (new): `feat/friendly-battle-two-machine-smoke-evidence`

## 1. Purpose

PR42 의 `docs/friendly-battle/roadmap/current-gap-after-remote-snapshot-handshake.md` §4-4 가 명시적으로 요구한 **"실제 두 머신에서의 수동 smoke 로그"** 를 산출물로 남긴다. 이 PR 은 **문서 + 편의 스크립트 전용** — 본 코드 기능은 전부 PR43-PR46 에 들어있다. PR47 이 완료되면 PR42 의 gap §4-4 체크박스를 지울 수 있다.

## 2. Non-goals

- LAN mode 구현 (이미 PR46 의 `8631e4c` 에 포함됨)
- WSL2 portproxy 자동화 (별도 PR48+ 로 분리)
- Internet PvP / NAT traversal / relay (별도 PR 로 분리)
- 새 CLI 플래그, 새 subcommand 없음
- 자동화된 two-machine 테스트 (두 머신이 필요한 특성상 불가)

## 3. Deliverables

### 3-1. `docs/friendly-battle/validation/two-machine-smoke.md` (NEW)

표준 sections:

#### §1. Purpose
- PR42 gap §4-4 를 만족시키는 evidence 문서
- 이 파일이 존재한다는 사실이 "실제 두 머신에서 LAN PvP 가 검증됐다" 는 서명

#### §2. Prerequisites
- 두 머신이 같은 L2/L3 네트워크 (동일 WiFi, 동일 subnet)
- 양쪽에 tkm 플러그인 설치됨 (`~/.claude/plugins/marketplaces/tkm` 또는 cache 경로)
- 양쪽에 `tokenmon` 초기화 완료 (파티 세팅 포함)
- (선택) 양쪽 `~/.claude/tokenmon/global-config.json` 의 `language` 가 의도한 로케일로 설정
- 호스트 머신의 방화벽이 해당 포트 인바운드 TCP 허용

#### §3. LAN IP discovery

OS 별 command:

- **Linux (Ubuntu / Debian)**: `hostname -I | awk '{print $1}'`
- **Linux (범용)**: `ip -4 addr show | grep inet | grep -v 127 | awk '{print $2}' | cut -d/ -f1 | head -1`
- **WSL2 inside**: `hostname -I | awk '{print $1}'` (주의: 이건 WSL2 내부 IP 이지 Windows LAN 노출 IP 아님)
- **WSL2 Windows 호스트 쪽**: PowerShell 에서 `(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi*' | Where-Object { $_.IPAddress -notlike '169.*' }).IPAddress | Select-Object -First 1`
- **macOS**: `ipconfig getifaddr en0` (Wi-Fi) 또는 `en1` (Ethernet)

#### §4. Firewall setup

- **Linux ufw**: `sudo ufw allow <port>/tcp`
- **Linux iptables**: `sudo iptables -A INPUT -p tcp --dport <port> -j ACCEPT`
- **macOS**: Application-level PF — `pfctl` 은 cli 가 복잡하므로 "시스템 설정 → 네트워크 → 방화벽 → node 허용" 권장
- **Windows Defender Firewall**: `New-NetFirewallRule -DisplayName "tkm friendly battle" -Direction Inbound -LocalPort <port> -Protocol TCP -Action Allow`
- **WSL2 주의**: Windows 호스트 방화벽 + WSL2 mirrored networking 권장 (`.wslconfig` 에 `networkingMode=mirrored` 추가)

#### §5. Walkthrough — host + guest step-by-step

Host 머신에서:
```bash
# Claude Code 세션 열고
/tkm:friendly-battle open
```
→ 출력된 `세션 코드` + `호스트 주소` 메모

Guest 머신에서:
```bash
/tkm:friendly-battle join <code>@<host-lan-ip>:<port>
```

이후 양쪽 AskUserQuestion 으로 기술 선택 → 배틀 진행.

#### §6. Success log sample

실제 두 머신에서 successful smoke 로그 1개. 다음을 캡처:
- 호스트 쪽의 `{ "phase": "waiting_for_guest", ... }` envelope
- 게스트 쪽의 `{ "phase": "battle", "status": "select_action", ... }` envelope
- 첫 턴 `turn_resolved` 양쪽 로그
- 배틀 종료 시점의 `battle_finished` envelope + skill 의 최종 메시지

> **🛠 USER ACTION REQUIRED**: 이 섹션에 실제 두 머신에서 돌린 로그를 붙여넣어야 한다. 자동화 스크립트(§9)로 캡처 가능.

#### §7. Failure scenarios (3 cases)

각 케이스마다 재현 절차 + 예상 로그 + 실제 캡처 로그.

**§7-1. Guest timeout** — Host 가 `open` 했지만 Guest 가 5분 내에 join 하지 않을 때
- 재현: 호스트에서 open, 게스트 쪽 아무 액션 안 함, 5분 대기
- 예상: 호스트 daemon 이 handshake timeout 으로 shutdown(1, aborted), skill 이 "게스트가 응답하지 않습니다" 메시지 표시
- 로그 캡처 포인트: 호스트 daemon 의 REASON stderr + session record phase/status

**§7-2. Bad session code** — Guest 가 잘못된 code 로 join
- 재현: 호스트 open → 세션 코드 `abc123` 받음 → 게스트가 `xxx999@<host>:<port>` 로 join
- 예상: 게스트 handshake 가 hello 교환 단계에서 `session_code_mismatch` 로 거부, guest daemon shutdown(1, aborted)
- 로그 캡처 포인트: 게스트 stderr + 호스트 stderr 양쪽

**§7-3. Mid-battle peer disconnect** — 배틀 중 한쪽이 Claude Code 세션 강제 종료 (Ctrl+C / 터미널 닫음)
- 재현: 정상 open/join → 배틀 시작 → 3-4 턴 진행 → 한쪽 터미널에서 `Ctrl+C` 또는 터미널 창 닫기
- 예상: 살아있는 쪽은 `battle_finished { reason: 'disconnect' }` 수신 → skill 이 "상대방이 배틀을 떠났습니다" 표시
- 로그 캡처 포인트: 살아있는 쪽의 최종 envelope + 떠난 쪽의 daemon crash log

> **🛠 USER ACTION REQUIRED**: 각 케이스를 실제로 재현해서 로그를 붙여넣어야 한다.

#### §8. Troubleshooting

- **"connection refused"**: 방화벽 차단 또는 잘못된 host:port. §4 firewall setup 재확인.
- **"ENOENT on socket"**: 이미 끝난 daemon 에 접근 — PR46 에서 CLI 가 fallback envelope 을 반환하도록 수정됨. 발생하면 tkm 버전 확인.
- **"host binding to 127.0.0.1"**: `/tkm:friendly-battle open local` 을 실수로 사용. `open` 만 쓰면 LAN 모드가 기본.
- **WSL2 → 다른 머신 접속 실패**: WSL2 내부 IP 는 LAN 에서 안 보임. Windows portproxy 설정 또는 mirrored networking 모드 필요. (상세 명령어)
- **"daemon dead" within seconds of open**: Node 버전 확인 (≥ 22 필요), CLAUDE_PLUGIN_ROOT 환경변수 확인

#### §9. Smoke script reference

`scripts/friendly-battle-smoke.sh` 의 usage 와 예시 output.

---

### 3-2. `scripts/friendly-battle-smoke.sh` (NEW)

목적: 두 머신에서 수동 smoke 할 때 복붙 실수를 줄이는 편의 래퍼. **자동화가 아니라 편의 one-liner**.

```sh
#!/usr/bin/env bash
# Usage:
#   scripts/friendly-battle-smoke.sh host           # LAN 모드로 open, 세션 코드 + 주소 출력
#   scripts/friendly-battle-smoke.sh host local     # loopback 모드로 open (같은 머신 테스트)
#   scripts/friendly-battle-smoke.sh guest <code>@<host>:<port>
#   scripts/friendly-battle-smoke.sh lan-ip         # 이 머신의 LAN IP 출력 (hostname -I 기반)
```

설계 원칙:
- 순수 bash (추가 의존 없음)
- tkm 플러그인 루트를 `CLAUDE_PLUGIN_ROOT` 또는 marketplace/cache 경로 자동 감지
- `run-friendly-battle-turn.sh` 를 wrapping — 프로토콜 재발명 없음
- 실패 경로에서 선명한 stderr + 비영 exit code
- shellcheck-clean

구현 스켈레톤 (Codex 가 실제로 작성):
```sh
set -euo pipefail
P="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/marketplaces/tkm 2>/dev/null || ls -d ~/.claude/plugins/cache/tkm/tkm/*/ 2>/dev/null | sort -V | tail -1)}"
[ -n "${P:-}" ] || { echo "error: tkm plugin root not found" >&2; exit 1; }
# ... dispatch logic
```

---

### 3-3. `docs/friendly-battle/roadmap/pr-stack-after-remote-snapshot-handshake.md` (UPDATE)

이 파일 §8 이후에 §9 또는 notes 블록 추가:
- "LAN mode landed in PR46 (`8631e4c`) — PR47 scope narrowed to evidence collection + smoke helper only"
- PR47 의 deliverable 리스트를 현재 계획 파일로 포인터
- §6 의 체크리스트에 "PR47 Option A" 표기

`pr47-smoke-evidence-plan.md` (이 파일) 을 정식 plan doc 으로 인정.

---

### 3-4. (Optional) `docs/friendly-battle/validation/local-two-terminal-visual-qa.md` (UPDATE)

기존의 local QA 가이드에 "two-machine smoke 는 §9 로" pointer 추가. **선택사항**. Codex 가 시간 남으면.

---

## 4. Task list (for Codex executor)

Codex 에게 넘길 task 순서:

1. **T1**: `scripts/friendly-battle-smoke.sh` 작성 — 위의 CLI 계약대로. 실행 권한 +x. shellcheck 통과.
2. **T2**: `docs/friendly-battle/validation/two-machine-smoke.md` 작성 — §1-§9 전체. §6 과 §7 의 실제 로그 자리에는 `<!-- USER: paste real two-machine log here -->` 주석 블록으로 placeholder. §9 의 smoke script usage 는 실제 T1 결과와 일치.
3. **T3**: roadmap `pr-stack-after-remote-snapshot-handshake.md` 업데이트 — PR47 scope narrowed note 추가.
4. **T4**: (local smoke capture) — 이 머신에서 `/tkm:friendly-battle open local` 을 실제로 돌려서 host/guest 양쪽 envelope 1턴치를 캡처. 이걸 §6 의 "loopback-only reference log" 로 붙여넣음 (실제 two-machine 로그 자리는 placeholder 로 유지). 시뮬레이션 이상의 증거가 되므로 doc 의 가치가 올라감.
5. **T5**: `npm run build` + `CI=1 npm test` 돌려서 회귀 없음 확인 (docs/script 만 바꿨으니 당연히 pass 해야 함).
6. **T6**: 새 브랜치 `feat/friendly-battle-two-machine-smoke-evidence` 생성, commit, push. **PR 자동 생성 금지** — autopilot 끝난 뒤 사용자가 PR 열지 결정.

## 5. Out of scope (explicitly)

- 실제 두 머신에서 돌린 로그 캡처 — 사용자가 나중에 직접 채워야 함 (autopilot 범위 밖, placeholder 만 남김)
- PR 자동 생성 — 사용자가 PR stack 구조 검토 후 수동으로
- LAN mode 코드 수정 — 이미 merged
- 기존 skill/daemon 파일 수정 — 건드리면 안 됨

## 6. Success criteria

- [ ] `scripts/friendly-battle-smoke.sh` 실행 가능, `host local` 모드로 로컬 smoke 한 번 성공
- [ ] `docs/friendly-battle/validation/two-machine-smoke.md` 가 8 sections 모두 작성됨 + USER ACTION 자리 표시
- [ ] roadmap doc 가 PR47 narrow scope 반영
- [ ] tests 1200/1200 pass, build clean
- [ ] 새 브랜치 push 완료, 원격에 존재
- [ ] 사용자가 PR 올릴 준비 완료 상태

## 7. 예상 소요

Codex 에게 전체 위임 시 ~15-25분 추정 (docs 작성 + script + 로컬 smoke 캡처 + 빌드/테스트).

---

## Appendix: Reference paths for Codex

- Worktree root: the checkout of `feat/friendly-battle-pvp-leave` where PR47 is stacked
- Current branch: `feat/friendly-battle-pvp-leave` (PR46 head, where LAN mode lives)
- Plugin source install: `~/.claude/plugins/marketplaces/tkm`
- Plugin cache install: `~/.claude/plugins/cache/tkm/tkm/0.6.2/`
- Existing roadmap docs: `docs/friendly-battle/roadmap/pr{43,44,45,46}-*-plan.md`
- Existing validation doc: `docs/friendly-battle/validation/local-two-terminal-visual-qa.md`
- Friendly-battle SKILL: `skills/friendly-battle/SKILL.md` — **do not modify**
- Helper script for reference: `bin/run-friendly-battle-turn.sh`
- Session record dir: `~/.claude/tokenmon/<gen>/friendly-battle/sessions/` (for smoke log capture)
