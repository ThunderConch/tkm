# PvP 서버 설계 문서

상위 문서: [PvP 문서 인덱스](../README.md)

이 섹션은 Tokénmon 온라인 PvP의 **서버 구조, 저장 모델, 통신 계약, 실시간 흐름**을 정의한다.

## 포함 문서

1. [서버 아키텍처](./architecture.md)
2. [데이터 모델](./data-model.md)
3. [DB 스키마 초안](./database-schema.md)
4. [API 계약](./api-contract.md)
5. [온라인 파티 등록 상세 계약](./party-registration-contract.md)
6. [친구전 룸 / 매치 성립 상세 계약](./room-and-match-contract.md)
7. [실시간 배틀 세션 상세 계약](./realtime-battle-session-contract.md)
8. [실시간 배틀 흐름](./battle-flow.md)

## 권장 읽기 순서

- 먼저 [서버 아키텍처](./architecture.md)로 왜 서버 권한 구조가 필요한지 본다.
- 다음 [데이터 모델](./data-model.md)로 엔티티 관계를 본다.
- 그 다음 [DB 스키마 초안](./database-schema.md)으로 실제 컬럼/제약 수준까지 내린다.
- 이후 [API 계약](./api-contract.md)으로 전체 표면을 훑는다.
- Phase 1 구현 전에는 [온라인 파티 등록 상세 계약](./party-registration-contract.md)으로 등록/조회 계약을 필드 단위까지 본다.
- Phase 2 구현 전에는 [친구전 룸 / 매치 성립 상세 계약](./room-and-match-contract.md)으로 room freeze / presence / match binding 계약을 본다.
- Phase 3 구현 전에는 [실시간 배틀 세션 상세 계약](./realtime-battle-session-contract.md)으로 WebSocket 명령/이벤트 계약을 본다.
- 마지막으로 [실시간 배틀 흐름](./battle-flow.md)으로 플레이 시퀀스를 다시 연결해서 본다.
