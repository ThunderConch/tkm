# ISSUE-21 · session terminal CLI bootstrap

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-20 · live PvP session terminal runner](./ISSUE-20-session-terminal-runner.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

ISSUE-20에서 고정한 `PvpSessionTerminalRunner` 위에, 실제 live PvP 화면 루프가 곧바로 붙을 수 있는 **CLI bootstrap/orchestration layer**를 추가한다.

이번 단계의 목적은 `raw stdin/readline + stdout repaint`를 테스트 가능한 추상화 뒤에 배치하는 것이다. 아직 여기서 room create/join UX를 만들거나, WebSocket transport 생성/교체를 직접 담당하지는 않는다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-terminal-cli.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-terminal-cli.test.ts`

## 핵심 책임

1. 주입받은 `runner`를 기준으로 live CLI 루프의 시작/정지를 orchestration 한다.
2. `connect()` / `disconnect()` bootstrap 훅을 옵션으로 받아 session connect/disconnect를 상위에서 결정할 수 있게 한다.
3. 입력 소스와 화면 출력은 인터페이스로 분리한다.
   - 입력 소스는 토큰 스트림만 제공한다.
   - 출력은 최신 screen repaint만 책임진다.
4. runner state가 바뀌면 즉시 repaint를 수행한다.
5. 입력 토큰이 들어오면 `runner.submitInputToken(token)`을 호출한다.
6. stop 시점에는 input 구독 해제, runner 구독 해제, runner stop, disconnect 훅 정리를 순서대로 수행한다.
7. process exit/raw mode/stdout clear 같은 전역 부작용은 이 레이어 밖으로 밀어낸다.

## 설계 메모

- 이 레이어는 **CLI orchestration**만 담당한다.
  - transport를 직접 만들지 않는다.
  - room code 입력 UX도 아직 넣지 않는다.
  - 실제 `process.stdin.setRawMode(...)`, `readline.createInterface(...)`, `process.stdout.write(...)`는 이후 adapter issue에서 연결한다.
- 기본 입력 정규화는 `trim()`으로 두되, 필요하면 옵션으로 교체할 수 있게 한다.
- start 시퀀스는 다음 순서를 따른다.
  1. optional `connect()`
  2. `runner.start()`
  3. runner state 구독 및 초기 repaint
  4. input source 구독
- stop 시퀀스는 다음 순서를 따른다.
  1. input source 구독 해제
  2. runner state 구독 해제
  3. `runner.stop()`
  4. optional `disconnect()`
- start/stop은 deterministic test로 검증 가능해야 한다.

## 기대 public contract

- `createPvpSessionTerminalCli(...)`
- `cli.start()` / `cli.stop()`
- `cli.getState()`
- `PvpSessionTerminalCliInputSource`
- `PvpSessionTerminalCliScreenOutput`
- `PvpSessionTerminalCliBootstrapHooks`

## 완료 조건

- start 시 connect bootstrap → runner start → 초기 repaint가 안정적으로 실행된다.
- input source가 전달한 token이 runner submit contract로 이어진다.
- runner state update가 screen repaint로 반영된다.
- stop 이후에는 추가 입력/runner update가 더 이상 전달되지 않는다.
- 이후 issue는 이 contract 위에 실제 raw stdin/readline adapter와 room join/bootstrap UX만 얹으면 된다.
