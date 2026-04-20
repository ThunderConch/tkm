# ISSUE-09 · 클라이언트 배틀 세션 스토어

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-08 · 재접속 / 운영 안정화](./ISSUE-08-reconnect-and-ops.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

서버 authoritative 이벤트 스트림을 Claude Code / TUI가 소비할 수 있도록, **순수 함수 기반 클라이언트 상태 저장소**를 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-store.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-store.test.ts`

## 핵심 책임

1. `room.snapshot`으로 로컬 세션 상태를 부트스트랩한다.
2. `battle.request_action`, `battle.force_replacement`를 입력 가능 상태로 투영한다.
3. `battle.command_accepted`, `battle.command_rejected`에 따라 로컬 입력 잠금 상태를 갱신한다.
4. `battle.turn_resolved`, `battle.ended`를 반영해 pending command / request를 정리한다.
5. UI가 raw envelope 조립을 몰라도 되도록 `battle.command` 생성을 thin wrapper로 제공한다.

## 완료 조건

- 클라이언트가 서버 이벤트만으로 현재 visible battle state를 복원할 수 있다.
- 중복 제출 / phase mismatch 시도를 막기 위한 로컬 가드가 존재한다.
- 이후 transport adapter나 TUI 레이어가 이 저장소를 그대로 재사용할 수 있다.
