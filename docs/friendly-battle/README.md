# Friendly Battle 문서 인덱스

상태: Draft v1
범위: **serverless friendly battle** 장기 축
기준 방향: **Claude Code 내부 명령만으로 붙는 로컬 파티 기반 친선전**

## 이 문서 세트가 다루는 것

이 문서 세트는 Tokénmon의 멀티플레이 방향 중, 기존의 server-authoritative PvP 축과 분리된 **친선전 전용 장기 축**을 정의한다.

핵심 목표는 다음과 같다.

1. **인게임처럼 즉석에서 붙는 감성**을 살린다.
2. **로컬에서 키운 파티를 그대로 꺼내 쓰는 맛**을 유지한다.
3. **Claude Code 내부 명령만으로** host / join / battle 흐름이 가능해야 한다.
4. 운영 서버, 래더, 계정, 시즌 같은 **운영형 온라인 게임 요소는 초기 범위에서 제외**한다.

이 축은 다음을 의도적으로 포함하지 않는다.

- 래더 / 점수 / 시즌
- anti-cheat / 결과 위조 방지 백엔드
- 재접속 복구
- 인터넷 전체 자동 매칭
- 관전 / 리플레이
- 운영형 계정 시스템

## 기존 PvP 문서와의 관계

- 이 문서 세트는 **새 source of truth** 다.
- [`../pvp/README.md`](../pvp/README.md)는 **server-authoritative legacy/reference track**으로 취급한다.
- 두 축은 공존할 수 있지만, **이번 친선전 축의 의사결정은 이 디렉터리 기준으로 읽어야 한다.**

## 한눈에 보는 핵심 결정

- 장기 축 이름은 **serverless friendly battle** 이다.
- 기본 목표안은 **A = host-authoritative direct session** 이다.
- 최대 타협안은 **B = lockstep P2P** 이다.
- **C 수준으로 복잡해지는 연결 구조는 실패**로 본다.
- 단, A는 확정이 아니라 **PR2 transport feasibility gate 통과 시에만 유지**된다.
- friendly battle은 로컬 progression을 직접 쓰지 않고, **read-only party snapshot** 으로 전투를 시작한다.
- 친선전 결과는 기본 progression을 **자동 오염시키지 않는다.**

## 권장 읽기 순서

1. [ADR: 방향 결정](./adr/0001-serverless-friendly-battle-direction.md)
2. [아키텍처 개요](./architecture/overview.md)
3. [연결 구조 후보 비교](./architecture/connection-options.md)
4. [상태 경계: progression / snapshot / session / battle](./architecture/state-boundary.md)
5. [Transport feasibility gate](./validation/transport-feasibility-gate.md)
6. [PR 로드맵](./roadmap/pr-roadmap.md)

## 문서 트리

### 1. ADR
- [ADR 인덱스](./adr/README.md)
  - [0001. serverless friendly battle 방향 결정](./adr/0001-serverless-friendly-battle-direction.md)

### 2. 아키텍처
- [아키텍처 인덱스](./architecture/README.md)
  - [개요](./architecture/overview.md)
  - [연결 구조 후보 비교](./architecture/connection-options.md)
  - [상태 경계](./architecture/state-boundary.md)

### 3. 검증 / 게이트
- [검증 / 게이트 인덱스](./validation/README.md)
  - [Transport feasibility gate](./validation/transport-feasibility-gate.md)

### 4. 로드맵
- [로드맵 인덱스](./roadmap/README.md)
  - [PR 로드맵](./roadmap/pr-roadmap.md)
  - [현재 gap 정리](./roadmap/current-gap-after-remote-snapshot-handshake.md)

## 문서 간 관계

- [ADR](./adr/0001-serverless-friendly-battle-direction.md)는 왜 이 축을 새로 파는지, 그리고 A/B/C 판정 기준이 무엇인지 고정한다.
- [아키텍처 개요](./architecture/overview.md)는 전체 레이어와 구현 방향을 설명한다.
- [연결 구조 후보 비교](./architecture/connection-options.md)는 A/B/C 옵션을 같은 평가 축 위에서 비교한다.
- [상태 경계](./architecture/state-boundary.md)는 progression / snapshot / session / battle 사이의 책임 경계를 정의한다.
- [Transport feasibility gate](./validation/transport-feasibility-gate.md)는 A안을 계속 밀지, B로 내려갈지 결정하는 kill-or-commit 문서다.
- [PR 로드맵](./roadmap/pr-roadmap.md)은 실제 구현 순서와 각 PR의 acceptance criteria를 정의한다.
- [현재 gap 정리](./roadmap/current-gap-after-remote-snapshot-handshake.md)는 현재 기준으로 이미 올라온 것과 남은 product gap을 분리해 보여준다.

## 빠른 요약

| 항목 | 결정 |
|---|---|
| 장기 축 | serverless friendly battle |
| 기본 연결 목표 | host-authoritative direct session |
| 최대 타협 | lockstep P2P |
| 실패 판정 | C 수준의 복잡한 연결 또는 운영 서버 전제 |
| 파티 사용 방식 | 로컬 progression -> read-only snapshot |
| progression 반영 | 친선전 결과는 자동 반영 안 함 |
| 핵심 UX 기준 | Claude Code 내부 명령만으로 host/join/battle 가능 |
| 범위 제외 | ladder, anti-cheat, reconnect, public matchmaking, replay |

## 관련 문서

- 상위 문서: [Docs Home](../README.md)
- 기존 레거시 참고: [PvP 문서 인덱스](../pvp/README.md)
- 핵심 ADR: [0001. 방향 결정](./adr/0001-serverless-friendly-battle-direction.md)
- 핵심 아키텍처: [개요](./architecture/overview.md)
- 핵심 게이트: [Transport feasibility gate](./validation/transport-feasibility-gate.md)
- 구현 순서: [PR 로드맵](./roadmap/pr-roadmap.md)
