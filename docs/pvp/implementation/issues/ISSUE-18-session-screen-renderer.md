# ISSUE-18 · deterministic PvP session terminal renderer

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-17 · PvP session-level screen 읽기 모델](./ISSUE-17-session-screen-view.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`createPvpSessionScreenView(state, payloadOverride?)` 결과를 battle-tui나 Claude Code 명령 루프가 바로 소비할 수 있도록, **ANSI 없이도 테스트 가능한 deterministic plain-text terminal renderer**를 추가한다.

이 이슈는 아직 `battle-tui/game-loop`, stdin, WebSocket 입출력 결합까지는 가지 않는다. 오직 `src/pvp` 경계 안에서, 이미 만들어진 상위 screen view contract를 사람이 읽기 쉬운 멀티라인 문자열로 내리는 첫 consumer layer만 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-screen-renderer.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-screen-renderer.test.ts`

## 핵심 책임

1. `PvpSessionScreenView | null` 을 deterministic한 plain-text layout으로 렌더한다.
2. 상위 consumer 편의를 위해 `PvpSessionClientState | null` 에서 곧바로 화면 문자열을 만드는 wrapper를 함께 제공한다.
   - `renderPvpSessionScreen(view)`
   - `renderPvpSessionClientScreen(state, payloadOverride?)`
3. 다음 섹션을 고정 순서로 포함한다.
   - transport
   - session
   - action request
   - command status
   - turn result
4. request/result가 비어 있을 때 placeholder 문구를 일관되게 유지한다.
5. 하위 view model contract는 바꾸지 않고, 표현 계층만 추가한다.

## 설계 메모

- 출력은 한국어 plain-text 멀티라인 문자열이며, ANSI/색상/커서 이동을 포함하지 않는다.
- renderer는 순수 함수이며 외부 I/O에 의존하지 않는다.
- `renderPvpSessionClientScreen` 는 내부에서 `createPvpSessionScreenView` 를 호출하고, 실제 layout 규칙은 `renderPvpSessionScreen` 한 곳에 모은다.
- 메뉴 entry는 항상 같은 순서와 같은 구분자(`|`)를 써서 line-by-line 테스트가 가능해야 한다.
- transport/session/action/request/result 각 섹션은 battle-tui 없이도 상위 consumer가 그대로 출력할 수 있는 최소 정보를 포함한다.
- 이후 ISSUE-19 이상에서 TUI frame/command loop를 붙이더라도, 문자열 레이아웃 contract는 이 renderer를 기준으로 점진 확장한다.

## 완료 조건

- null/empty state, awaiting input, reconnecting, terminal 시나리오가 테스트로 검증된다.
- 상위 consumer가 `session-client` snapshot 하나만 넘겨도 즉시 출력 가능한 deterministic terminal 문자열을 얻는다.
- `src/pvp` 바깥 의존성 없이도 session-level UI first consumer가 준비된다.
