# ISSUE-15 · PvP turn resolved rendering / 결과 로그 UX adapter

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-14 · PvP action request rendering / input UX adapter](./ISSUE-14-action-request-view.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`battle.turn_resolved` authoritative payload와 `session-client`가 보유한 session 상태를 바탕으로, Claude Code / battle TUI / 이후 CLI surface가 그대로 사용할 수 있는 **턴 결과 전용 읽기 모델 / 결과 로그 UX adapter**를 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/turn-result-view.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-turn-result-view.test.ts`

## 핵심 책임

1. `battle.turn_resolved` payload를 그대로 받아, 결과 로그/요약 정보를 UI가 곧바로 그릴 수 있는 deterministic view model로 변환한다.
2. 다음 이벤트를 **한국어 라벨/메시지**로 정리한다.
   - `move_used`
   - `switch_used`
   - `damage_applied`
   - `heal_applied`
   - `status_applied`
   - `pokemon_fainted`
   - `replacement_selected`
   - `forfeit`
3. `postTurnVisibleState`를 바탕으로 다음 요약 필드를 노출한다.
   - 내 active 포켓몬 라벨
   - 상대 active 포켓몬 라벨
   - 내 벤치 잔여/기절 정보
   - 상대 벤치 비공개 잔여 수 요약
   - `nextPhase` / `status` / terminal 결과 라벨
4. `session-client` consumer가 가능하면 **session state 하나만 보고도** 마지막 턴 결과 summary를 붙일 수 있도록 session-state wrapper API를 함께 제공한다.
5. transport, reconnect, battle calculation 책임은 침범하지 않고 **표현용 adapter**로만 머문다.

## 설계 메모

- payload 기반 API인 `createPvpTurnResultViewFromPayload(...)`는 **가장 정보가 많은 authoritative 입력**을 받아 로그와 summary를 모두 만든다.
- wrapper API인 `createPvpTurnResultView(state, payload?)`는 두 가지 용도를 가진다.
  - `payload`가 있으면: 로그 + summary를 함께 만든다.
  - `payload`가 없으면: session state에 남아 있는 `visibleState`, `lastResolvedTurn`, `battleStatus`, `terminalResult`만으로 **summary-only view**를 만든다.
- 현재 `session-store`는 raw `battle.turn_resolved.events` 자체를 보존하지 않으므로, **완전한 로그 재구성은 payload가 있을 때만 가능**하다.
- 따라서 이 이슈는 session-store를 확장하지 않고도 붙일 수 있는 최소/안정적인 UX adapter를 먼저 확정하는 단계다.

## 완료 조건

- 상위 consumer가 payload만으로 턴 결과 화면/로그를 바로 렌더할 수 있다.
- 상위 consumer가 session state만으로도 마지막 턴 summary를 렌더할 수 있다.
- 기본 액션 턴, 교체 유도 턴, finished 턴, null 입력 처리 시나리오가 테스트로 검증된다.
- 이후 battle TUI / Claude Code command loop는 이 adapter 위에 출력 레이아웃만 얹으면 된다.
