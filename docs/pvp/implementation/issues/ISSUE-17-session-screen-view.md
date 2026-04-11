# ISSUE-17 · PvP session-level screen 읽기 모델

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-14 · PvP action request rendering / input UX adapter](./ISSUE-14-action-request-view.md), [ISSUE-15 · PvP turn resolved rendering / 결과 로그 UX adapter](./ISSUE-15-turn-result-view.md), [ISSUE-16 · PvP submitted-command / acceptance-status 읽기 모델](./ISSUE-16-command-status-view.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

기존의 `action-request-view`, `command-status-view`, `turn-result-view` 세 read model을 상위 consumer가 다시 조합하지 않도록, `session-client` snapshot 하나에서 바로 읽을 수 있는 **단일 session-level screen view model**을 추가한다.

이 이슈는 아직 battle TUI layout 문자열이나 CLI loop 결합까지는 가지 않고, 상위 consumer/Claude Code/TUI가 그대로 소비할 수 있는 deterministic한 **순수 데이터 adapter**에만 집중한다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-screen-view.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-screen-view.test.ts`

## 핵심 책임

1. transport / reconnect 상태를 한국어 summary label로 정리한다.
2. session 메타(`roomId`, `battleId`, `turn`, `battleStatus`, `generation`, `rulesetKey`, `yourSeat`)를 상위 consumer가 그대로 쓸 수 있는 요약으로 묶는다.
3. 기존 하위 read model 결과를 그대로 포함한다.
   - `createPvpActionRequestView(state)`
   - `createPvpCommandStatusView(state)`
   - `createPvpTurnResultView(state, payload?)`
4. 상위 consumer가 한 번에 분기할 수 있도록 top-level 상태를 정규화한다.
   - empty state
   - terminal 여부
   - reconnecting / awaiting_input / command_locked 등 화면 상태
5. transport/store/session-client의 public contract는 바꾸지 않고, **표현용 adapter**로만 해결한다.

## 설계 메모

- `createPvpSessionScreenView(state, payloadOverride?)` 는 순수 함수다.
- turn result는 payload override가 있으면 우선 사용하고, 없으면 session state fallback을 사용한다.
- screen status는 다음 우선순위로 정규화한다.
  1. terminal
  2. reconnecting
  3. awaiting_input
  4. command_locked
  5. transport_wait
  6. idle
- empty state 판단은 **request/result가 모두 비어 있는가** 기준으로 한다. command status는 보조 정보로 유지한다.
- 이후 ISSUE-18 이상에서 TUI renderer / Claude Code command loop는 이 screen view model을 그대로 받아 각 채널에 맞는 layout만 입히면 된다.

## 완료 조건

- 상위 consumer가 `PvpSessionClientState` 하나만으로 세부 하위 read model과 transport/session 요약을 함께 소비할 수 있다.
- null state, reconnecting empty state, command locked state, terminal fallback 시나리오가 테스트로 검증된다.
- battle-tui/cli loop를 수정하지 않아도, 다음 슬라이스에서 붙일 수 있는 안정적인 상위 view contract가 생긴다.
