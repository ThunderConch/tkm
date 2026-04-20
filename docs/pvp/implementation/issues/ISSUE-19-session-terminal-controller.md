# ISSUE-19 · PvP session terminal controller / input token bridge

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-18 · deterministic PvP session terminal renderer](./ISSUE-18-session-screen-renderer.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

ISSUE-18에서 고정한 deterministic plain-text renderer를 실제 상위 consumer가 바로 붙일 수 있도록, `PvpSessionClient` snapshot과 사용자 입력 토큰 사이를 잇는 **terminal-facing controller layer**를 추가한다.

이 이슈의 목적은 아직 `battle-tui/game-loop` 전체를 PvP용으로 갈아엎는 것이 아니다. 대신 battle-tui, Claude Code command loop, 이후 CLI entrypoint가 공통으로 재사용할 수 있는 작은 adapter를 먼저 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-terminal-controller.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-terminal-controller.test.ts`

## 핵심 책임

1. `PvpSessionClientState | null`에서 즉시 출력 가능한 최신 화면 문자열을 제공한다.
   - 내부적으로 `renderPvpSessionClientScreen(state, payloadOverride?)`를 사용한다.
2. 현재 pending action request에서 노출한 `inputToken`을 authoritative `BattleCommand`로 역매핑한다.
   - `1`, `2`, `switch:n`, `replace:n`, `forfeit`
3. 상위 consumer가 stdin/Claude 응답을 바로 넘길 수 있도록 token submit API를 제공한다.
   - 토큰이 유효하면 `sessionClient.sendBattleCommand(...)` 호출
   - 토큰이 없거나 현재 request와 맞지 않으면 deterministic error/result 반환
4. controller는 transport/store/view model contract를 바꾸지 않고, **session-client + renderer + request-view를 묶는 orchestration adapter**에 머문다.
5. 이후 battle-tui/CLI가 얹기 쉬운 최소 public contract를 만든다.
   - 현재 화면 문자열 조회
   - 현재 입력 가능 여부/가능 토큰 조회
   - 토큰 제출 결과 조회

## 설계 메모

- controller는 ANSI, raw stdin, WebSocket lifecycle, 서버 bootstrapping을 직접 다루지 않는다.
- 입력 해석은 `createPvpActionRequestView(state)`가 이미 제공하는 menu entry의 `inputToken`/`command`를 그대로 신뢰한다.
- 같은 token이라도 현재 pending request가 바뀌면 결과가 바뀔 수 있으므로, 매 호출마다 최신 state snapshot을 기준으로 판단한다.
- 반환 타입은 상위 consumer가 즉시 분기할 수 있게 success / invalid-token / unavailable / transport-not-ready 류의 상태를 명시적으로 담아야 한다.
- 이 레이어는 이후 `battle-tui` 통합 전 단계의 contract 고정이 목적이므로, side effect는 `sessionClient.sendBattleCommand(...)` 한 곳으로 제한한다.

## 기대 public contract

- snapshot 조회
  - `screen`: 현재 plain-text terminal screen 문자열
  - `inputEntries`: 현재 request 기준 메뉴 엔트리 + `inputToken` + authoritative `BattleCommand`
  - `availableInputTokens`: 실제 제출 가능한 token 목록
- token 해석
  - `resolved`
  - `invalid_token`
  - `no_request`
  - `locked`
  - `transport_not_ready`
- token 제출
  - `submitted`
  - `invalid_token`
  - `no_request`
  - `locked`
  - `transport_not_ready`
  - `unavailable`

## 완료 조건

- 현재 session-client snapshot 하나만 있으면 terminal consumer가 화면 문자열과 입력 가능 토큰 목록을 모두 얻을 수 있다.
- move/switch/replacement/forfeit token 제출 성공, 잘못된 token, 잠긴 상태, request 없음 시나리오가 테스트로 검증된다.
- `battle-tui` 또는 별도 CLI가 이 controller만 붙여도 PvP 명령 루프의 첫 통합을 시작할 수 있다.
