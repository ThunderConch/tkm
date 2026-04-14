# Two-Machine Friendly Battle Smoke

상태: Draft
대상 PR: PR47 Option A
선행 계획 문서: [`../roadmap/pr47-smoke-evidence-plan.md`](../roadmap/pr47-smoke-evidence-plan.md)

## 1. Purpose

이 문서는 PR42 gap 문서 `current-gap-after-remote-snapshot-handshake.md` §4-4 가 요구한 "실제 두 머신에서의 수동 smoke 로그"를 남기기 위한 evidence scaffold 이다. PR47 자체는 LAN mode 구현 PR 이 아니라, PR46 (`8631e4c`) 에서 LAN mode 가 이미 landed 한 뒤 실제 두 머신 검증 로그를 정리할 자리와 재현 절차를 제공하는 문서 + helper script 범위로 제한된다.

이 파일이 실제 로그로 채워지면 "같은 네트워크의 두 머신에서 `/tkm:friendly-battle open` / `join` 흐름이 검증됐다"는 증거 문서가 된다.

## 2. Prerequisites

- 두 머신이 같은 L2/L3 네트워크에 있어야 한다. 같은 Wi-Fi 또는 같은 subnet 이 권장된다.
- 양쪽에 tkm 플러그인이 설치되어 있어야 한다. 일반 경로는 `~/.claude/plugins/marketplaces/tkm`, cache 설치라면 `~/.claude/plugins/cache/tkm/tkm/<version>/` 이다.
- 양쪽에 tokenmon 초기화가 완료되어 있어야 한다. 최소한 파티 구성이 끝나 있어야 친선전이 진행된다.
- 필요하다면 양쪽 `~/.claude/tokenmon/global-config.json` 의 `language` 값이 원하는 로케일인지 확인한다.
- 호스트 머신 방화벽은 선택된 포트의 inbound TCP 를 허용해야 한다.
- Node.js 22+ 와 Claude Code 세션이 정상 동작해야 한다. daemon 이 즉시 죽는 패턴은 대개 Node 버전 부족 또는 plugin root 해석 실패와 연결된다.

## 3. LAN IP discovery

호스트가 LAN mode 로 방을 열 때 게스트에게 전달할 주소는 `127.0.0.1` 이 아니라 실제 LAN IPv4 여야 한다.

- Linux (Ubuntu / Debian): `hostname -I | awk '{print $1}'`
- Linux (generic fallback): `ip -4 addr show | grep inet | grep -v 127 | awk '{print $2}' | cut -d/ -f1 | head -1`
- WSL2 inside: `hostname -I | awk '{print $1}'`
  WSL2 내부 IP 는 다른 물리 머신에서 바로 보이지 않을 수 있다. 이 값만 복사해서 전달하면 guest 쪽에서 `connection refused` 가 날 수 있다.
- WSL2 Windows host side (PowerShell): `(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi*' | Where-Object { $_.IPAddress -notlike '169.*' }).IPAddress | Select-Object -First 1`
- macOS Wi-Fi: `ipconfig getifaddr en0`
- macOS Ethernet: `ipconfig getifaddr en1`

Helper script 로 현재 머신의 기본 LAN IPv4 를 출력하려면:

```bash
scripts/friendly-battle-smoke.sh lan-ip
```

스크립트는 먼저 `hostname -I | awk '{print $1}'` 를 시도하고, 값이 비면 Node `os.networkInterfaces()` fallback 으로 첫 non-loopback IPv4 를 찾는다.

## 4. Firewall setup

호스트가 LAN mode 로 열면 TCP listen 은 `0.0.0.0:<ephemeral-port>` 에 바인딩된다. 게스트가 다른 머신이라면 호스트 방화벽이 해당 포트를 허용해야 한다.

- Linux ufw: `sudo ufw allow <port>/tcp`
- Linux iptables: `sudo iptables -A INPUT -p tcp --dport <port> -j ACCEPT`
- macOS: 시스템 설정에서 `node` 또는 Claude Code 가 inbound 연결을 허용하도록 설정하는 편이 가장 단순하다.
- Windows Defender Firewall: `New-NetFirewallRule -DisplayName "tkm friendly battle" -Direction Inbound -LocalPort <port> -Protocol TCP -Action Allow`
- WSL2: Windows 쪽 방화벽도 함께 열어야 한다. mirrored networking 을 쓰지 않는다면 `netsh interface portproxy` 로 Windows LAN 포트를 WSL2 IP 로 forward 해야 한다.

예시 WSL2 portproxy:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=<port> connectaddress=<wsl-ip> connectport=<port>
New-NetFirewallRule -DisplayName "tkm friendly battle <port>" -Direction Inbound -LocalPort <port> -Protocol TCP -Action Allow
```

## 5. Walkthrough — host + guest step-by-step

Host 머신:

```bash
/tkm:friendly-battle open
```

또는 helper script:

```bash
scripts/friendly-battle-smoke.sh host
```

호스트는 session code 와 host:port 를 출력한다. LAN mode 에서는 방화벽 경고와 함께 실제 LAN IP 를 공유해야 한다.

Guest 머신:

```bash
/tkm:friendly-battle join <code>@<host-lan-ip>:<port>
```

또는 helper script:

```bash
scripts/friendly-battle-smoke.sh guest <code>@<host-lan-ip>:<port>
```

정상 흐름:

1. Host 가 room 을 연다.
2. Guest 가 `<code>@<host>:<port>` 로 join 한다.
3. 양쪽 모두 `phase='battle'`, `status='select_action'` envelope 을 받는다.
4. 첫 턴 선택 이후 `turn_resolved` 관련 frame / envelope 이 양쪽에 찍힌다.
5. 배틀 종료 시 `battle_finished` 또는 terminal envelope 이 남는다.

## 6. Success log sample

실제 두 머신 successful smoke 로그 자리:

<!-- USER: paste real two-machine log here -->

### 6-1. Loopback reference capture

실제 2-머신 smoke 를 돌리기 전 sanity check 용. 아래 blob 은 `scripts/friendly-battle-smoke.sh` 를 `feat/friendly-battle-two-machine-smoke-evidence` 브랜치에서 실제로 돌려서 얻은 출력이다. daemon 이 loopback 모드에서 정상적으로 떴고 `waiting_for_guest` envelope 를 반환한다는 것이 확인된다.

```text
$ scripts/friendly-battle-smoke.sh lan-ip
192.168.125.30

$ scripts/friendly-battle-smoke.sh host local
MODE: local
SESSION_CODE: c4f3b7
HOST: 127.0.0.1
PORT: 44185
JOIN: c4f3b7@127.0.0.1:44185
{"sessionId":"fb-48bcce07-4146-434f-bc5f-e66c00c8b1f3","role":"host","phase":"waiting_for_guest","status":"waiting_for_guest","questionContext":"Waiting for guest (code c4f3b7) — see /tkm:friendly-battle status","moveOptions":[],"partyOptions":[],"animationFrames":[],"currentFrameIndex":0}
```

확인 가능한 것:
- daemon 이 ephemeral 포트(44185)에 bind 성공
- session code 가 6-hex 형식으로 정상 생성
- 초기 envelope 의 phase / status 가 `waiting_for_guest` 로 정확히 세팅
- helper script 가 session_code / host / port / JOIN 문자열을 구조화해서 stdout 에 출력

loopback 모드는 의도적으로 다른 머신 게스트가 접속할 수 없다 — 이 캡처는 "네가티브 컨트롤" 역할. 실제 LAN smoke 에서는 위 `HOST` 값이 `127.0.0.1` 대신 머신의 실제 LAN IP 로 나와야 한다.

**Script bug fixed during this capture**: 최초 시도에서 `scripts/friendly-battle-smoke.sh host local` 이 `PORT: 44185` 를 daemon stderr 에 찍었는데도 helper script 의 PORT 파서가 `failed to parse host port` 로 실패했다. 원인은 `--init-host` 가 detached daemon fork 직후 즉시 종료되기 때문에 `while kill -0 $init_pid` 루프가 `PORT:` 라인이 stderr 파일에 flush 되기 전에 빠져나가는 race. fix 는 `wait $init_pid` 로 child 를 완전히 수거한 뒤 파싱을 한 번 더 시도하는 것. 같은 커밋에 포함.

## 7. Failure scenarios (3 cases)

### 7-1. Guest timeout

재현:

1. Host 에서 `/tkm:friendly-battle open` 또는 `scripts/friendly-battle-smoke.sh host` 실행
2. Guest 쪽은 아무 것도 하지 않고 5분 이상 대기

예상:

- Host daemon 이 handshake timeout 으로 shutdown 된다.
- Host 쪽은 `phase='aborted'` 와 함께 대기 실패를 보여주거나 REASON stderr 를 남긴다.

실제 로그 자리:

<!-- USER: paste real two-machine log here -->

### 7-2. Bad session code

재현:

1. Host 에서 정상적으로 open
2. Guest 가 실제 code 대신 임의의 잘못된 code 로 `join`

예상:

- Guest handshake 는 hello/hello_ack 단계에서 `session_code_mismatch` 또는 동급 거절로 종료된다.
- Guest daemon 은 aborted 로 종료되고, Host 쪽에도 거절 흔적이 남는다.

실제 로그 자리:

<!-- USER: paste real two-machine log here -->

### 7-3. Mid-battle peer disconnect

재현:

1. 정상 open / join
2. 1~3턴 진행
3. 한쪽 Claude Code 세션을 `Ctrl+C` 또는 터미널 종료로 끊는다

예상:

- 살아남은 쪽은 `battle_finished { reason: 'disconnect' }` 또는 `phase='aborted'` terminal envelope 을 본다.
- 떠난 쪽은 daemon shutdown 로그 또는 CLI 종료 흔적을 남긴다.

실제 로그 자리:

<!-- USER: paste real two-machine log here -->

## 8. Troubleshooting

- `connection refused`
  보통 잘못된 host:port 이거나 방화벽 차단이다. `host` 가 `127.0.0.1` 로 잘못 공유되지 않았는지 확인하고, §4 방화벽 규칙과 실제 bound port 를 다시 확인한다.
- `ENOENT` on socket / daemon unreachable
  이미 끝난 daemon 의 UNIX socket 에 붙으려는 경우다. 현재 `friendly-battle-turn --wait-next-event` 와 `--status` 는 ENOENT / ECONNREFUSED 시 record snapshot 기반 fallback envelope 을 반환하도록 되어 있으므로, raw crash 대신 terminal 상태를 확인해야 한다. 여전히 ENOENT crash 가 보인다면 PR46 이후 버전이 맞는지 확인한다.
- host binding to `127.0.0.1`
  `/tkm:friendly-battle open local` 또는 `scripts/friendly-battle-smoke.sh host local` 을 실수로 사용한 경우다. 같은 머신 테스트가 아니라면 `open` / `host` 기본 모드를 사용해야 한다.
- WSL2 guest cannot connect from another machine
  WSL2 내부 IP 는 외부 LAN 머신에 바로 노출되지 않는다. Windows 쪽 실제 LAN IP 를 전달하고, 필요하면 `netsh interface portproxy` 또는 mirrored networking (`.wslconfig` 의 `networkingMode=mirrored`) 을 사용한다.
- daemon dies within seconds of open
  실제 코드베이스에서 자주 맞는 패턴은 Node 버전 부족(22 미만), `CLAUDE_PLUGIN_ROOT` 가 잘못 잡혀 `run-friendly-battle-turn.sh` 가 엉뚱한 트리를 보는 경우, 또는 plugin 설치 경로에서 deps 가 누락된 경우다. `node -v`, `echo "$CLAUDE_PLUGIN_ROOT"`, `test -f "$CLAUDE_PLUGIN_ROOT/package.json"` 으로 먼저 확인한다.
- daemon death after handshake with no obvious UI
  `~/.claude/tokenmon/<generation>/friendly-battle/sessions/` 아래 session record 를 보면 `phase`, `status`, `daemonPid`, `updatedAt` 로 frozen state 를 확인할 수 있다. 종료 직후 `phase='finished'` 또는 `phase='aborted'` 로 굳어 있으면 CLI fallback envelope 으로도 동일 상태를 재현할 수 있다.

## 9. Smoke script reference

`scripts/friendly-battle-smoke.sh` 는 manual smoke 때 복붙 실수를 줄이는 thin wrapper 다. protocol 을 재구현하지 않고 기존 `bin/run-friendly-battle-turn.sh` 를 그대로 감싼다.

Usage:

```bash
scripts/friendly-battle-smoke.sh host
scripts/friendly-battle-smoke.sh host local
scripts/friendly-battle-smoke.sh guest <code>@<host>:<port>
scripts/friendly-battle-smoke.sh lan-ip
```

동작 요약:

- `host`
  LAN mode (`--listen-host 0.0.0.0`) 로 room 을 열고 `SESSION_CODE`, `HOST`, `PORT`, `JOIN` 안내를 출력한 뒤, handshake 완료 후 첫 턴의 battle / action / result envelope 1세트를 자동으로 찍는다.
- `host local`
  loopback mode (`--listen-host 127.0.0.1`) 로 동일한 흐름을 수행한다. 같은 머신에서 두 터미널 smoke 를 캡처할 때 사용한다.
- `guest <code>@<host>:<port>`
  지정된 host 에 join 한 뒤 첫 턴의 battle / action / result envelope 1세트를 자동으로 찍는다.
- `lan-ip`
  이 머신에서 공유해야 할 기본 LAN IPv4 를 출력한다.
