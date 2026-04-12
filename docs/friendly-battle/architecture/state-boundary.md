# 상태 경계: progression / snapshot / session / battle

## 왜 이 문서가 필요한가

현재 로컬 게임 흐름은 단일 저장 흐름에 가깝고, 전투 상태도 한 파일/한 세션 전제를 강하게 가진다. friendly battle 축에서는 이 경계를 먼저 고정하지 않으면 executor가 구현 중간에 서로 다른 가정을 만들게 된다.

## 1. Progression state

### 정의
플레이어가 로컬 스토리/탐험/성장 플레이를 하며 쌓는 원본 상태.

### 포함 예시
- 현재 파티
- 박스/보유 포켓몬
- 레벨과 성장 상태
- 세대별 저장 슬롯

### 규칙
- 이 상태가 **원본** 이다.
- 친선전은 이 상태를 직접 mutate 하지 않는다.

## 2. Party snapshot state

### 정의
friendly battle 시작 시 progression에서 추출한 **read-only 전투용 파티 스냅샷**.

### 포함 예시
- battle에 필요한 포켓몬 정보
- 세대 식별자
- 규칙 검증에 필요한 필드
- peer 전달용 직렬화 필드

### 규칙
- snapshot은 progression에서 생성된다.
- battle 중 snapshot 원본은 수정하지 않는다.
- 친선전 결과는 snapshot을 통해 progression에 자동 반영되지 않는다.

## 3. Session runtime state

### 정의
두 플레이어가 연결되어 친선전을 준비/진행하는 동안의 세션 상태.

### 포함 예시
- session id
- host / guest role
- ready 상태
- pending choice 상태
- timeout / cancel 상태

### 규칙
- 세션 상태와 전투 상태를 섞지 않는다.
- transport 문제는 session layer에서 다룬다.

## 4. Battle runtime state

### 정의
battle engine이 실제로 계산하는 턴제 전투 상태.

### 포함 예시
- HP / status
- current active
- field / turn counter
- move resolution 결과

### 규칙
- battle runtime은 snapshot을 입력으로 시작한다.
- session은 battle runtime 결과를 이벤트로 감싸 UI/CLI에 전달한다.

## 핵심 불변식

1. progression은 원본이다.
2. snapshot은 친선전 시작 시점의 복사본이다.
3. session은 연결/참가자/턴 제출 상태를 표현한다.
4. battle은 실제 규칙 계산을 담당한다.
5. 친선전 결과는 progression을 자동 오염시키지 않는다.

## 저장 경로 / namespace 원칙

구체 경로명은 구현 PR에서 확정하되, 다음 원칙은 고정한다.

- 기존 단일 `battle-state.json` 흐름과 충돌하지 않는다.
- friendly battle session state는 **별도 namespace/path** 를 사용한다.
- snapshot, session, battle runtime의 저장/직렬화 관심사를 분리한다.

## 미래 확장 여지

이 경계를 잘 유지하면, 나중에 다음 확장이 쉬워진다.

- 교환 시스템
- battle replay
- hosted relay 옵션
- generation별 별도 ruleset

## 관련 문서

- [아키텍처 개요](./overview.md)
- [연결 구조 후보 비교](./connection-options.md)
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)
- [PR 로드맵](../roadmap/pr-roadmap.md)
