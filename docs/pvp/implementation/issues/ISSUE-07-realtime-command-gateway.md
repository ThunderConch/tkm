# ISSUE-07 · 실시간 명령 게이트웨이

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-06 · 서버 권한 배틀 세션 코어](./ISSUE-06-battle-session-domain.md)  
관련 문서: [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

클라이언트가 WebSocket으로 명령을 보내고, 서버가 플레이어별 가시 상태만 내려주는 실시간 transport 계층을 완성한다.

## 구현 범위

### 신규 모듈

- `src/server/ws/pvp-ws-server.ts`
- `src/server/ws/connection-registry.ts`
- `src/server/ws/message-router.ts`
- `src/server/ws/heartbeat.ts`

### 테스트

- `test/pvp-ws-gateway.test.ts`

## 핵심 책임

1. room/battle 단위 연결 식별
2. `battle.command` 라우팅
3. command accepted / turn resolved push
4. 플레이어별 private payload 분리 전달
5. heartbeat / disconnect 감지

## 완료 조건

- 클라이언트는 계산 결과가 아니라 **서버 이벤트**만 받아 렌더링한다.
