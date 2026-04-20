# ISSUE-14 · PvP action request rendering / input UX adapter

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-13 · 상위 PvP session client orchestration 레이어](./ISSUE-13-session-client-orchestrator.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`session-client`가 노출하는 authoritative session 상태 위에, Claude Code / battle TUI / 이후 CLI surface가 공통으로 사용할 수 있는 **action request 전용 읽기 모델 / 입력 UX adapter**를 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/action-request-view.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-action-request-view.test.ts`

## 핵심 책임

1. 현재 pending request(`choose_move_or_switch`, `choose_replacement`)를 UI가 곧바로 그릴 수 있는 메뉴/섹션 모델로 변환한다.
2. move / switch / replacement / forfeit 입력 후보를 **서버 authoritative command shape**에 맞춘 command option으로 노출한다.
3. `commandSubmitted`, `canSendCommand`, request kind 같은 상태를 바탕으로 “지금 입력 가능한가”, “이미 제출했는가”를 UX-friendly 상태로 정리한다.
4. TUI/CLI가 raw `pendingRequest` 구조를 직접 해석하지 않도록, 라벨/설명/기본 hotkey/sort 순서를 이 레이어에서 정리한다.
5. transport, reconnect, battle calculation 책임은 침범하지 않고 **표현용 파생 상태와 입력 후보 정리**만 담당한다.

## 설계 메모

- `session-store`는 authoritative pending request와 command lock 상태를 보존한다.
- `session-client`는 transport / reconnect / protocol / session 상태를 한 곳으로 묶는다.
- 따라서 이번 이슈는 새로운 store를 추가하는 것이 아니라, **상위 UX가 소비할 마지막 얇은 adapter 레이어**를 만드는 단계다.
- 초기 범위에서는 실제 키 입력 루프 전체를 battle TUI에 직접 연결하지 않는다. 대신, 후속 이슈가 그대로 붙일 수 있도록 deterministic한 view model을 먼저 확정한다.

## 완료 조건

- 상위 consumer가 `session-client` 상태 하나만으로 현재 요청 화면을 렌더할 수 있다.
- action / replacement phase 각각에 대해 move, switch, replacement, forfeit 입력 후보가 테스트로 검증된다.
- 이미 제출된 턴과 입력 불가 상태가 별도 UX 상태로 노출된다.
- 이후 battle TUI / Claude Code command loop는 이 adapter 위에 실제 키 바인딩과 출력만 얹으면 된다.
