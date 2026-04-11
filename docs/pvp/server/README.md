# PvP 서버 설계 문서

상위 문서: [PvP 문서 인덱스](../README.md)

이 섹션은 Tokénmon 온라인 PvP의 **서버 구조, 저장 모델, 통신 계약, 실시간 흐름**을 정의한다.
이번 정리에서는 서버 문서를 `개요`, `storage`, `contracts`로 한 단계 더 쪼개서 읽기 순서를 분명하게 만들었다.

## 문서 구조

### 1. 서버 개요
- [서버 아키텍처](./architecture.md)
- [API 계약](./api-contract.md)
- [실시간 배틀 흐름](./battle-flow.md)

### 2. 저장 모델
- [Storage 인덱스](./storage/README.md)
  - [데이터 모델](./storage/data-model.md)
  - [DB 스키마 초안](./storage/database-schema.md)

### 3. 세부 계약
- [Contracts 인덱스](./contracts/README.md)
  - [온라인 파티 등록 상세 계약](./contracts/party-registration.md)
  - [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)
  - [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)

## 권장 읽기 순서

1. 먼저 [서버 아키텍처](./architecture.md)로 왜 서버 권한 구조가 필요한지 본다.
2. 다음 [Storage 인덱스](./storage/README.md)로 저장 계층 문서를 따라간다.
3. 그 다음 [API 계약](./api-contract.md)으로 HTTP / WebSocket 표면을 훑는다.
4. 이후 [Contracts 인덱스](./contracts/README.md)로 Phase별 상세 계약을 따라간다.
5. 마지막으로 [실시간 배틀 흐름](./battle-flow.md)으로 실제 플레이 시퀀스를 다시 연결해서 본다.

## 구현 전에 특히 먼저 볼 문서

- Phase 1 등록 작업 전: [온라인 파티 등록 상세 계약](./contracts/party-registration.md)
- Phase 2 룸 작업 전: [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)
- Phase 3 배틀 세션 작업 전: [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)
- 저장 계층 구현 전: [DB 스키마 초안](./storage/database-schema.md)
