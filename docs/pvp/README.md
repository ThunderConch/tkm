# Tokénmon PvP 문서 인덱스

상태: Draft v1  
범위: 온라인 친선 PvP 초기 설계  
기준 방향: **세대별 온라인 파티 등록 + 서버 권한 전투 + 인게임 감성 6v6 싱글**

## 문서 목적

이 문서 세트는 Tokénmon의 온라인 PvP를 실제 구현 가능한 단위로 구조화한 상위/하위 설계 문서 모음이다.  
핵심 목표는 다음 세 가지다.

1. **전투 결과 위조를 막는다.**
2. **파티 성장 상태 위조를 최대한 막는다.**
3. **공식 대회 느낌보다 인게임에서 NPC 트레이너를 조우한 감성에 가깝게 만든다.**

이 문서 세트는 아직 구현 문서가 아니라 **설계 기준 문서**다. 이후 서버/API/클라이언트 구현은 이 문서를 기준으로 분해한다.

---

## 한눈에 보는 핵심 결정

- 전투는 **서버 권한(server-authoritative)** 으로 처리한다.
- 클라이언트(Claude Code)는 **기술 선택 / 교체 / 다음 포켓몬 선택** 같은 명령만 보낸다.
- 로컬 스토리/성장은 유지하되, 온라인에서는 **세대별 등록 파티 스냅샷**을 사용한다.
- 온라인 친선 PvP는 초기 버전에서 **싱글배틀 / 6마리 등록 / 6마리 전원 사용 / 팀 프리뷰 없음 / 1번 슬롯 선발** 로 간다.
- **동일 종 중복 금지**를 적용한다.
- **전설+환상 총 2마리 제한**, 그중 **restricted 1마리 제한**을 적용한다.
- 레벨은 실제 성장을 보존하되, 배틀 계산에서는 **50 이후 압축**, **유효 레벨 상한 60**을 둔다.
- `legendary`, `mythical`과 별개로 온라인 밸런스용 **`restricted` 개념을 따로 둔다.**
- 세대는 현재 로컬 시스템처럼 분리되어 있으므로, 온라인도 **세대별 ruleset / party / 룸** 구조로 간다.

---

## 권장 읽기 순서

1. [PvP 제품/게임플레이 규칙](./game-design/battle-format.md)
2. [성장/파티 등록 구조](./game-design/progression-and-party-registration.md)
3. [특수 포켓몬 정책](./game-design/special-pokemon-policy.md)
4. [세대별 ruleset 구조](./game-design/generation-rules.md)
5. [서버 아키텍처](./server/architecture.md)
6. [서버 데이터 모델](./server/data-model.md)
7. [서버 DB 스키마 초안](./server/database-schema.md)
8. [HTTP / WebSocket API 계약 초안](./server/api-contract.md)
9. [온라인 파티 등록 상세 계약](./server/party-registration-contract.md)
10. [친구전 룸 / 매치 성립 상세 계약](./server/room-and-match-contract.md)
11. [실시간 배틀 세션 상세 계약](./server/realtime-battle-session-contract.md)
12. [실시간 배틀 흐름](./server/battle-flow.md)
13. [치트 대응 / 보안 정책](./security/anti-cheat.md)
14. [구현 로드맵](./roadmap/rollout-plan.md)
15. [서버 패키지 / 모듈 구조 제안](./implementation/server-package-layout.md)

---

## 문서 트리

### 1. 게임 설계
- [게임 설계 인덱스](./game-design/README.md)
  - [배틀 포맷](./game-design/battle-format.md)
  - [성장 및 파티 등록](./game-design/progression-and-party-registration.md)
  - [전설 / 환상 / restricted 정책](./game-design/special-pokemon-policy.md)
  - [세대별 ruleset 설계](./game-design/generation-rules.md)

### 2. 서버 설계
- [서버 설계 인덱스](./server/README.md)
  - [서버 아키텍처](./server/architecture.md)
  - [데이터 모델](./server/data-model.md)
  - [DB 스키마 초안](./server/database-schema.md)
  - [API 계약](./server/api-contract.md)
  - [온라인 파티 등록 상세 계약](./server/party-registration-contract.md)
  - [친구전 룸 / 매치 성립 상세 계약](./server/room-and-match-contract.md)
  - [실시간 배틀 세션 상세 계약](./server/realtime-battle-session-contract.md)
  - [실시간 배틀 흐름](./server/battle-flow.md)

### 3. 보안 / 운영
- [보안 / 치트 대응 인덱스](./security/README.md)
  - [치트 대응 정책](./security/anti-cheat.md)
- [로드맵 인덱스](./roadmap/README.md)
  - [단계별 구현 로드맵](./roadmap/rollout-plan.md)

### 4. 구현 계획
- [구현 계획 인덱스](./implementation/README.md)
  - [PvP 초기 구현 PRD](./implementation/prd.md)
  - [PvP 작업 분해 / TODO](./implementation/todo-breakdown.md)
  - [서버 패키지 / 모듈 구조 제안](./implementation/server-package-layout.md)

---

## 문서 간 관계

- [배틀 포맷](./game-design/battle-format.md)은 플레이어 경험과 경기 규칙의 기준 문서다.
- [성장 및 파티 등록](./game-design/progression-and-party-registration.md)은 로컬 성장과 온라인 사용을 연결하는 문서다.
- [특수 포켓몬 정책](./game-design/special-pokemon-policy.md)과 [세대별 ruleset 설계](./game-design/generation-rules.md)는 배틀 포맷의 세부 제약을 정의한다.
- [서버 아키텍처](./server/architecture.md)는 왜 서버 권한 구조가 필요한지 설명한다.
- [데이터 모델](./server/data-model.md)은 엔티티 개념도를 설명하고, [서버 DB 스키마 초안](./server/database-schema.md)은 이를 컬럼/제약 수준으로 구체화한다.
- [API 계약](./server/api-contract.md)은 서버 아키텍처와 스키마를 전체 입출력 표면으로 정리한 문서다.
- [온라인 파티 등록 상세 계약](./server/party-registration-contract.md)은 그중 Phase 1 등록/조회 계약을 필드 단위까지 세밀하게 내린 문서다.
- [친구전 룸 / 매치 성립 상세 계약](./server/room-and-match-contract.md)은 Phase 2의 room binding / presence / battle freeze 계약을 세밀하게 내린 문서다.
- [실시간 배틀 세션 상세 계약](./server/realtime-battle-session-contract.md)은 Phase 3의 WebSocket 명령/이벤트 계약을 세밀하게 내린 문서다.
- [실시간 배틀 흐름](./server/battle-flow.md)은 실제 플레이 시퀀스를 정의한다.
- [치트 대응 정책](./security/anti-cheat.md)은 위 모든 문서의 보안 기준 문서다.
- [구현 로드맵](./roadmap/rollout-plan.md)은 이 설계를 어떤 순서로 구현할지 정리한 문서다.
- [PvP 초기 구현 PRD](./implementation/prd.md)은 제품 목표와 수용 기준을 정리한 문서다.
- [PvP 작업 분해 / TODO](./implementation/todo-breakdown.md)은 실제 개발 순서와 작업 단위를 정리한 문서다.
- [서버 패키지 / 모듈 구조 제안](./implementation/server-package-layout.md)은 이 작업들을 현재 repo 구조 안에서 어디에 구현할지 정리한 문서다.

---

## 상위 결정 요약

| 항목 | 결정 |
|---|---|
| 전투 처리 권한 | 서버 권한 |
| 접속 방식 | Claude Code 클라이언트가 서버에 접속 |
| 초기 대전 타입 | 친선 PvP |
| 실시간성 | 실시간 진행 |
| 전투 포맷 | 싱글, 6v6, 팀 프리뷰 없음 |
| 선발 방식 | 1번 슬롯 자동 선발 |
| 교체 | 자유 교체 가능 |
| 기절 후 처리 | 다음 포켓몬 직접 선택 |
| 중복 종 | 금지 |
| 특수 포켓몬 제한 | 전설+환상 총 2, restricted 최대 1 |
| 성장 보존 | 실제 레벨 표시 유지 |
| 레벨 밸런싱 | 50 이후 압축, 유효 레벨 최대 60 |
| 온라인 파티 | 세대별 등록 스냅샷 1개 활성 |
| 재등록 | 허용 |
| 핵심 보안 목표 | 결과 위조 / 성장 상태 위조 방지 |

---

## 관련 문서

- 상위 문서: [Docs Home](../README.md)
- 구현 우선순위: [구현 로드맵](./roadmap/rollout-plan.md)
- 구현 PRD: [PvP 초기 구현 PRD](./implementation/prd.md)
- 구현 작업 분해: [PvP 작업 분해 / TODO](./implementation/todo-breakdown.md)
- 등록 계약 상세: [온라인 파티 등록 상세 계약](./server/party-registration-contract.md)
- 룸 계약 상세: [친구전 룸 / 매치 성립 상세 계약](./server/room-and-match-contract.md)
- 실시간 세션 계약 상세: [실시간 배틀 세션 상세 계약](./server/realtime-battle-session-contract.md)
- 코드 구조 제안: [서버 패키지 / 모듈 구조 제안](./implementation/server-package-layout.md)
- 데이터 중심 상세: [서버 데이터 모델](./server/data-model.md)
- DB 구체안: [서버 DB 스키마 초안](./server/database-schema.md)
- 보안 중심 상세: [치트 대응 정책](./security/anti-cheat.md)
