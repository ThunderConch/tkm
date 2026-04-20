# ISSUE-05 · 룸 API / 매치 성립 흐름

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-04 · 친구전 룸 도메인 / 저장](./ISSUE-04-room-domain-and-persistence.md)  
관련 문서: [친구전 룸 / 매치 성립 상세 계약](../../server/contracts/room-and-match.md)

## 목표

룸 생성/참가/대기 상태 조회를 실제 서버 surface로 연결한다.

## 구현 범위

### 신규 모듈

- `src/server/http/pvp-room-routes.ts`
- `src/server/projection/room-projection.ts`

### 테스트

- `test/pvp-room-routes.test.ts`

## 핵심 책임

1. 룸 생성 API
2. 룸 참가 API
3. 대기 상태 조회/표시용 projection
4. 양 플레이어 binding 완료 후 `awaiting_presence` 상태 진입

## 비범위

- WebSocket presence handshake
- 턴 처리

## 완료 조건

- 두 플레이어가 룸 코드만으로 배틀 직전 상태까지 도달할 수 있다.
