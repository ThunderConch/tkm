# ISSUE-20 · live PvP session terminal runner

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-19 · PvP session terminal controller / input token bridge](./ISSUE-19-session-terminal-controller.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

ISSUE-19에서 고정한 terminal controller contract 위에, 실제 상위 consumer가 곧바로 붙일 수 있는 **live session terminal runner**를 추가한다.

이 이슈는 아직 `src/cli` 진입점이나 raw stdin/node readline 구현을 직접 넣는 단계가 아니다. 대신 `PvpSessionClient`의 live state 변화와 `PvpSessionTerminalController`의 input token submit contract를 하나의 작은 orchestration layer로 묶어서, 이후 battle-tui/CLI가 여기에 stdin loop/room join/bootstrap만 얹으면 되도록 만드는 것이 목적이다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-terminal-runner.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-terminal-runner.test.ts`

## 핵심 책임

1. `PvpSessionClient`의 live state를 구독하고, 최신 `PvpSessionTerminalSnapshot`을 항상 유지한다.
2. 상위 consumer가 즉시 렌더할 수 있는 runner state를 제공한다.
   - 최신 `screen`
   - 최신 `availableInputTokens`
   - 마지막 submit 결과
   - render revision / update sequence 같은 deterministic 갱신 기준
3. `submitInputToken(token)`을 노출해 controller submit contract를 그대로 재사용한다.
4. session state가 바뀌면 자동으로 새 snapshot을 계산하고 listener에게 전달한다.
5. 이 레이어는 여전히 ANSI/raw stdin/process exit을 직접 다루지 않는다.

## 설계 메모

- runner는 transport lifecycle을 완전히 소유하지 않는다.
  - `connect()` / `disconnect()` 같은 session bootstrapping은 상위 entrypoint가 선택한다.
  - runner는 기본적으로 `sessionClient.subscribe(...)` 위에서만 동작한다.
- `start()`는 subscribe를 설치하고 즉시 현재 snapshot을 계산한다.
- `stop()`은 구독만 정리하며, process 종료나 stdin cleanup까지 책임지지 않는다.
- 동일한 최신 state를 기준으로 submit한 결과가 있으면, runner state의 `lastSubmitResult`를 갱신하고 listener에게 재방출한다.
- deterministic 테스트를 위해 실제 clock, stdin, stdout 없이도 state transition을 검증할 수 있어야 한다.
- 이후 battle-tui/CLI는 이 runner 위에 다음만 얹으면 된다.
  - room join / connect bootstrap
  - stdin token 수집
  - screen clear / repaint 정책

## 기대 public contract

- `createPvpSessionTerminalRunner(...)`
- `runner.start()` / `runner.stop()`
- `runner.getState()`
- `runner.subscribe(listener)`
- `runner.submitInputToken(token)`

runner state는 최소 다음 정보를 포함한다.

- `running`
- `revision`
- `snapshot`
- `screen`
- `availableInputTokens`
- `lastSubmitResult`

## 완료 조건

- start 직후 최신 snapshot을 한 번 계산하고 listener에게 안정적으로 전달한다.
- session-client state 변경 시 runner가 새 screen/token 목록을 반영한다.
- 유효 token 제출 시 `lastSubmitResult`와 snapshot이 함께 갱신된다.
- stop 이후에는 더 이상 session-client 업데이트를 전파하지 않는다.
- battle-tui/CLI가 raw stdin 없이도 이 runner 하나만으로 live PvP 화면 루프를 시작할 수 있는 상태가 된다.
