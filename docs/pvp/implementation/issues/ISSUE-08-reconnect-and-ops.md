# ISSUE-08 · 재접속 / 운영 안정화

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-07 · 실시간 명령 게이트웨이](./ISSUE-07-realtime-command-gateway.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [서버 데이터 모델](../../server/storage/data-model.md)

## 목표

실전 사용 가능한 수준으로 재접속, 타임아웃, 디버깅 로그를 다듬는다.

## 구현 범위

### 신규/확장 모듈

- `src/server/ws/session-resume.ts`
- `src/server/battle/timeout-policy.ts`
- `src/server/projection/battle-projection.ts`
- 운영용 로그/조회 도구

### 테스트

- `test/pvp-reconnect.test.ts`
- `test/pvp-timeout-policy.test.ts`

## 핵심 책임

1. room snapshot 재구성
2. 끊김 후 현재 공개 상태 복원
3. 중복 명령 제출 방지
4. 타임아웃 패배/자동 처리 정책
5. 사후 디버깅 가능한 이벤트 로그 조회

## 완료 조건

- 사용자가 연결이 잠깐 끊겨도 배틀을 이어갈 수 있다.
- 운영자가 문제 배틀을 로그로 추적할 수 있다.
