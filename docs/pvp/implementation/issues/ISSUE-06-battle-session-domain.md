# ISSUE-06 · 서버 권한 배틀 세션 코어

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-05 · 룸 API / 매치 성립 흐름](./ISSUE-05-room-http-and-readiness.md)  
관련 문서: [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md), [서버 아키텍처](../../server/architecture.md)

## 목표

서버가 턴 진행의 최종 권위자가 되는 battle session 계층을 만든다.

## 구현 범위

### 신규 모듈

- `src/server/battle/battle-types.ts`
- `src/server/battle/battle-engine-adapter.ts`
- `src/server/battle/battle-command-service.ts`
- `src/server/battle/battle-turn-service.ts`
- `src/server/battle/battle-session-service.ts`
- `src/server/battle/battle-event-log.ts`

### 테스트

- `test/pvp-battle-session.test.ts`

## 핵심 책임

1. 배틀 시작 snapshot 생성
2. 턴 수집 / resolve 흐름
3. move / switch / replacement / forfeit 처리
4. public/private payload 분리
5. faint 후 replacement phase 진입
6. 종료 / 승패 기록

## 비범위

- 실제 WebSocket 연결 관리
- 재접속 복원

## 완료 조건

- 네트워크 계층 없이도 battle session 서비스 단위 테스트가 가능하다.
