# PR2 Transport Gate Report

상태: Complete

이 문서는 PR2 transport feasibility spike의 **실제 실행 결과** 를 기록한 canonical gate artifact다.
이 단계의 구현은 throwaway spike 성격을 유지하며, 후속 PR에서 정식 session/battle/CLI 레이어로 재정리될 수 있다.

## 1. Verdict

- 판정: **A 유지**
- 실행 날짜: 2026-04-12
- 실행자: Codex CLI + Claude Code plugin 환경

## 2. Environment

- host OS / shell: Linux 6.6.87.2-microsoft-standard-WSL2 / zsh
- guest OS / shell: Linux 6.6.87.2-microsoft-standard-WSL2 / zsh
- repo revision: `dcb64cc` + PR2 working tree changes
- 사용한 명령 surface: `node --import tsx src/cli/friendly-battle-spike.ts host|join`

## 3. Successful path

- host 명령:

  ```bash
  node --import tsx src/cli/friendly-battle-spike.ts host --session-code alpha-123 --timeout-ms 10000
  ```

- guest 명령:

  ```bash
  node --import tsx src/cli/friendly-battle-spike.ts join --host 127.0.0.1 --port 38709 --session-code alpha-123 --timeout-ms 10000
  ```

- ready/start/action exchange 결과:
  - host 출력

    ```text
    JOIN_INFO: {"host":"127.0.0.1","port":38709,"sessionCode":"alpha-123","joinHint":"tokenmon friendly-battle spike join --host 127.0.0.1 --port 38709 --session-code alpha-123"}
    JOIN_COMMAND: node --import tsx src/cli/friendly-battle-spike.ts join --host 127.0.0.1 --port 38709 --session-code alpha-123 --timeout-ms 10000
    STAGE: guest_joined (Guest)
    STAGE: battle_started
    GUEST_ACTION: move:1
    HOST_ACTION: move:1
    SUCCESS: first_action_exchange_completed
    ```

  - guest 출력

    ```text
    STAGE: connected
    STAGE: ready
    STAGE: battle_started
    GUEST_ACTION: move:1
    HOST_ACTION: move:1
    SUCCESS: first_action_exchange_completed
    ```

- 첫 action exchange까지의 명시적 사용자 명령 수: **2개**
  - 1: host 실행
  - 2: guest join 실행
- host의 battle 시작 조건은 고정 sleep이 아니라 host/guest ready 상태 동기화(`waitUntilCanStart`)로 검증했다.

## 4. Failure samples

### Case 1 — 잘못된 session code 후 재시도

- 단계: handshake
- 증상: guest가 잘못된 session code로 join 시도하면 연결은 거절되지만 host는 계속 살아 있으며, 올바른 code로 재시도 가능했다.
- CLI 메시지:

  ```text
  FAILED_STAGE: handshake
  NEXT_ACTION: host가 보여준 session code를 다시 확인한 뒤 다시 join 하세요.
  INPUT_HINT: host=127.0.0.1 port=43847 sessionCode=wrong-code
  RETRY_HINT: node --import tsx src/cli/friendly-battle-spike.ts join --host 127.0.0.1 --port 43847 --session-code alpha-123 --timeout-ms 2000
  세션 코드가 일치하지 않습니다. host가 보여준 session code(alpha-123)를 다시 확인하세요.
  ```

- 잘못됐을 가능성이 높은 입력값: `--session-code wrong-code`
- 재시도 힌트(명령/옵션): `RETRY_HINT`에 올바른 `--session-code alpha-123`가 포함된 완전한 명령을 출력했다.
- 사용자가 취한 다음 액션:

  ```bash
  node --import tsx src/cli/friendly-battle-spike.ts join --host 127.0.0.1 --port 43847 --session-code alpha-123 --timeout-ms 10000
  ```

- 재시도 결과:

  ```text
  STAGE: connected
  STAGE: ready
  STAGE: battle_started
  GUEST_ACTION: move:1
  HOST_ACTION: move:1
  SUCCESS: first_action_exchange_completed
  ```

### Case 2 — host listen 실패

- 단계: listen
- 증상: 이미 사용 중인 포트로 host를 띄우면 즉시 실패하고, raw stack 대신 복구 가능한 CLI 메시지를 출력했다.
- CLI 메시지 예시:

  ```text
  FAILED_STAGE: listen
  NEXT_ACTION: 입력한 host/port를 확인하거나 이미 같은 포트를 쓰는 프로세스를 종료한 뒤 다시 host 하세요.
  INPUT_HINT: host=127.0.0.1 port=43957 sessionCode=alpha-123
  RETRY_HINT: node --import tsx src/cli/friendly-battle-spike.ts host --host 127.0.0.1 --port 43957 --session-code alpha-123 --timeout-ms 2000
  host가 127.0.0.1:43957에서 listen하지 못했습니다. 이미 사용 중인 포트인지, host 주소가 유효한지 확인하세요. (EADDRINUSE)
  ```

- 잘못됐을 가능성이 높은 입력값: `--port 43957`
- 재시도 힌트(명령/옵션): `RETRY_HINT`에 같은 host 명령을 그대로 출력해 사용자가 port 수정 또는 점유 프로세스 정리 후 바로 다시 실행할 수 있게 했다.
- 보조 검증:
  - `node --import tsx --test test/friendly-battle-transport-spike.test.ts` 의 listen failure 케이스로 회귀 방지
  - `node --import tsx --test test/friendly-battle-spike-cli.test.ts` 의 host listen failure 케이스로 CLI UX 회귀 방지

### Case 3 — guest가 join 후 ready를 보내지 않음

- 단계: ready
- 증상: guest가 `hello`까지만 보내고 `guest_ready`를 보내지 않으면 host는 `FAILED_STAGE: ready`로 종료하고, 문제를 ready 단계로 명확히 분류했다.
- CLI 메시지 예시:

  ```text
  STAGE: guest_joined (IdleGuest)
  FAILED_STAGE: ready
  NEXT_ACTION: guest가 join 후 ready 단계까지 완료했는지 확인한 뒤 다시 host 하세요.
  INPUT_HINT: host=127.0.0.1 port=0 sessionCode=alpha-123
  RETRY_HINT: node --import tsx src/cli/friendly-battle-spike.ts host --host 127.0.0.1 --port 0 --session-code alpha-123 --timeout-ms 500
  guest ready 대기 중 시간이 초과되었습니다.
  ```

- 잘못됐을 가능성이 높은 입력값/상태: guest가 join 후 ready 단계를 완료하지 않음
- 재시도 힌트(명령/옵션): `RETRY_HINT`에 동일한 host 명령을 유지하고, `NEXT_ACTION`에서 guest ready 완료를 먼저 요구했다.
- 보조 검증:
  - `node --import tsx --test test/friendly-battle-transport-spike.test.ts` 의 ready synchronization 케이스로 host가 sleep 없이 ready를 기다리는지 회귀 방지
  - `node --import tsx --test test/friendly-battle-spike-cli.test.ts` 의 ready failure 케이스로 CLI stage mapping 회귀 방지

### Case 4 — guest handshake acknowledgement가 오지 않음

- 단계: join
- 증상: TCP 연결은 됐지만 host가 `hello_ack`를 보내지 않으면 guest는 `--timeout-ms`로 지정한 범위 안에서 join 단계 실패로 종료한다.
- CLI 메시지 예시:

  ```text
  FAILED_STAGE: join
  NEXT_ACTION: host 프로세스와 입력한 host/port/session code를 다시 확인하세요.
  INPUT_HINT: host=127.0.0.1 port=39091 sessionCode=alpha-123
  RETRY_HINT: node --import tsx src/cli/friendly-battle-spike.ts join --host 127.0.0.1 --port 39091 --session-code alpha-123 --timeout-ms 200
  hello acknowledgement 대기 중 시간이 초과되었습니다.
  ```

- 잘못됐을 가능성이 높은 입력값/상태: host가 연결은 받았지만 handshake 응답을 돌려주지 못함
- 재시도 힌트(명령/옵션): `RETRY_HINT`에 동일한 join 명령과 사용자가 입력한 `--timeout-ms`를 유지해 바로 재현/재시도할 수 있게 했다.
- 보조 검증:
  - `node --import tsx --test test/friendly-battle-spike-cli.test.ts` 의 join timeout regression 케이스로 guest timeout contract 회귀 방지
  - guest transport는 내부 고정 1초 대기가 아니라 CLI에서 받은 timeout 값을 사용하도록 수정했다.

### Case 5 — battle 시작 직후 guest가 종료됨

- 단계: battle
- 증상: host는 `battle_started`까지 정상 진행했지만, 첫 action을 받기 전에 guest가 연결을 끊으면 `FAILED_STAGE: battle`로 종료한다.
- CLI 메시지 예시:

  ```text
  STAGE: guest_joined (BattleDropGuest)
  STAGE: battle_started
  FAILED_STAGE: battle
  NEXT_ACTION: battle 시작 후 상대 행동이 도착하는지 확인하고, 필요하면 다시 host 하세요.
  INPUT_HINT: host=127.0.0.1 port=0 sessionCode=alpha-123
  RETRY_HINT: node --import tsx src/cli/friendly-battle-spike.ts host --host 127.0.0.1 --port 0 --session-code alpha-123 --timeout-ms 500
  guest 연결이 종료되었습니다.
  ```

- 잘못됐을 가능성이 높은 입력값/상태: battle 시작 직후 guest 프로세스가 종료되었거나 연결이 끊김
- 재시도 힌트(명령/옵션): 동일한 host 명령을 유지하고, `NEXT_ACTION`에서 battle 단계의 상대 action 도착 여부를 먼저 확인하게 한다.
- 보조 검증:
  - `node --import tsx --test test/friendly-battle-spike-cli.test.ts` 의 host battle-stage disconnect 케이스로 host-side `FAILED_STAGE: battle` 매핑 회귀 방지

## 5. Evidence

- 실행 로그:
  - success path: `.omx/logs/pr2-transport-gate-20260412T100021Z/success/`
  - failure + retry path: `.omx/logs/pr2-transport-gate-20260412T100021Z/failure-retry/`
  - listen failure path: `.omx/logs/pr2-transport-gate-20260412T101445Z/listen-failure/`
  - ready timeout path: `.omx/logs/pr2-transport-gate-20260412T102648Z/ready-timeout/`
- 스크린샷/터미널 캡처 경로: 별도 스크린샷 없음, 위 로그 디렉터리에 raw terminal output 저장
- 보조 메모:
  - targeted tests
    - `node --import tsx --test test/friendly-battle-transport-spike.test.ts` → 7 passed
    - `node --import tsx --test test/friendly-battle-spike-cli.test.ts` → 8 passed
  - project verification
    - `npm run typecheck` → pass
    - `npm run build` → pass
    - `git diff --check` → pass

## 6. Decision rationale

- A 유지 또는 B 전환 이유:
  - same-machine 2-terminal 기준으로 host/join/ready/start/action exchange가 안정적으로 성립했다.
  - 첫 action exchange까지 명시적 사용자 명령이 2개라서 gate 기준(<= 5)을 넉넉히 만족했다.
  - join 정보가 한 줄 `JOIN_INFO` / `JOIN_COMMAND`로 복사 가능했다.
  - 실패 UX가 `FAILED_STAGE`, `NEXT_ACTION`, `INPUT_HINT`, `RETRY_HINT`를 모두 포함해 사용자가 바로 복구 행동을 취할 수 있었다.
  - backend 없이도 Claude Code 내부 명령 surface만으로 재현 가능하므로, friendly battle의 장기 방향(A안)과 맞는다.
- 후속 PR에 미치는 영향:
  - PR3부터는 spike transport를 정식 session/state contract로 흡수한다.
  - PR4~PR7에서는 spike CLI를 그대로 제품화하지 않고, session/battle/party/UX 레이어를 분리한 제품용 surface로 재구성한다.
