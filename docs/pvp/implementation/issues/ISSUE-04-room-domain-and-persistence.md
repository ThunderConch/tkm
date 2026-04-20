# ISSUE-04 · 친구전 룸 도메인 / 저장

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-03 · 온라인 파티 등록 API / 저장](./ISSUE-03-party-registration-surface.md)  
관련 문서: [친구전 룸 / 매치 성립 상세 계약](../../server/contracts/room-and-match.md), [서버 데이터 모델](../../server/storage/data-model.md)

## 목표

친구전 룸의 상태 전이와 저장 모델을 먼저 고정한다.

## 구현 범위

### 신규 모듈

- `src/server/rooms/room-types.ts`
- `src/server/rooms/room-code.ts`
- `src/server/rooms/room-validator.ts`
- `src/server/rooms/room-repository.ts`
- `src/server/rooms/room-service.ts`

### 테스트

- `test/pvp-room-service.test.ts`

## 핵심 책임

1. 룸 코드 생성
2. host / guest 결합
3. generation / ruleset mismatch 차단
4. active snapshot 존재 검증
5. `waiting_for_opponent` → `awaiting_presence` 상태 전이
6. 배틀 시작 시 사용할 ruleset snapshot freeze 준비

## 비범위

- 실제 HTTP route
- 실시간 presence
- 배틀 command loop

## 완료 조건

- 룸 상태 머신이 순수 서비스 레벨에서 검증된다.
- 동일 플레이어 중복 참가 같은 기본 오류를 차단한다.
