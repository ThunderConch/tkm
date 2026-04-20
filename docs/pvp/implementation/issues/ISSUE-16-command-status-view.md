# ISSUE-16 · PvP submitted-command / acceptance-status 읽기 모델

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-13 · 상위 PvP session client orchestration 레이어](./ISSUE-13-session-client-orchestrator.md), [ISSUE-14 · PvP action request rendering / input UX adapter](./ISSUE-14-action-request-view.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`battle.command_accepted`, `pendingCommand`, `lastRejectedCommand`, `pendingRequest.commandSubmitted` 사이의 관계를 상위 consumer가 다시 해석하지 않도록, `session-client` 상태에서 바로 읽을 수 있는 **submitted-command / acceptance-status 전용 한국어 view model**을 추가한다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/command-status-view.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-command-status-view.test.ts`

## 핵심 책임

1. `session state`만으로 이번 턴 제출 상태를 `created / accepted / rejected_permanent / none` 으로 정규화한다.
2. 제출한 명령을 다음 한국어 요약으로 노출한다.
   - `기술 n번`
   - `교체 슬롯 n`
   - `replacement 슬롯 n`
   - `항복`
3. 상위 consumer가 그대로 사용할 수 있도록 다음 필드를 deterministic하게 제공한다.
   - 잠금 여부 / 상호작용 가능 여부
   - 사용자용 `statusLabel` / `detailLabel`
   - rejection 코드/메시지/재시도 가능 여부 summary
   - `request.commandSubmitted` 와 `pendingCommand.status` 관계 설명 요약
4. transport, store, reconnect 동작은 바꾸지 않고 **표현용 adapter**에만 머문다.

## 설계 메모

- `createPvpCommandStatusViewFromSession(session, options?)` 는 순수 session-state 기반 변환기다.
- `createPvpCommandStatusView(state)` 는 `PvpSessionClientState` wrapper로, 상위 consumer가 이미 들고 있는 session-client snapshot을 그대로 넘기면 된다.
- `request.commandSubmitted=true` 이지만 `pendingCommand`가 없는 snapshot/reconnect 상황은 **accepted fallback** 으로 간주한다.
- retryable rejection은 제출 상태를 `none` 으로 되돌리되, `rejection summary`를 유지해 재제출 UX에 붙일 수 있게 한다.
- permanent rejection은 `pendingCommand.status=rejected_permanent` 와 `lastRejectedCommand` 를 함께 노출해, 재제출 없이 잠금 상태로 보여줄 수 있게 한다.

## 완료 조건

- 상위 consumer가 session-client state 하나로 제출 상태 라벨/요약/거부 사유를 바로 렌더할 수 있다.
- null input, idle state, created, accepted, permanent rejection, snapshot accepted fallback 시나리오가 테스트로 검증된다.
- 이후 battle TUI / Claude Code command loop는 이 adapter 결과를 그대로 붙여 제출 상태 섹션을 만들 수 있다.
