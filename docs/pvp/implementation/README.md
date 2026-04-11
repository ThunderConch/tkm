# PvP 구현 계획 문서

상위 문서: [PvP 문서 인덱스](../README.md)

이 섹션은 Tokénmon 온라인 PvP 설계를 **실제 구현 가능한 작업 단위**로 바꾸는 문서 모음이다.

## 포함 문서

1. [PvP 초기 구현 PRD](./prd.md)
2. [PvP 작업 분해 / TODO](./todo-breakdown.md)
3. [서버 패키지 / 모듈 구조 제안](./server-package-layout.md)

## 읽는 순서

- 먼저 [PvP 초기 구현 PRD](./prd.md)에서 목표, 비목표, 성공 기준을 본다.
- 다음 [PvP 작업 분해 / TODO](./todo-breakdown.md)에서 실제 개발 순서와 작업 단위를 본다.
- 그 다음 [서버 패키지 / 모듈 구조 제안](./server-package-layout.md)으로 실제 `src/server` 경계를 어떻게 나눌지 본다.


## 구현 시 먼저 볼 상세 계약

- Phase 1 등록 작업 전에는 [온라인 파티 등록 상세 계약](../server/contracts/party-registration.md)을 먼저 읽는다.
- Phase 2 룸 작업 전에는 [친구전 룸 / 매치 성립 상세 계약](../server/contracts/room-and-match.md)을 먼저 읽는다.
- Phase 3 배틀 세션 작업 전에는 [실시간 배틀 세션 상세 계약](../server/contracts/realtime-battle-session.md)을 먼저 읽는다.
