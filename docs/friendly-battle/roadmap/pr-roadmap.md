# Friendly Battle PR 로드맵

## 원칙

- PR36/37의 server-authoritative 축과 분리한다.
- `master` 기준 새 브랜치에서 진행한다.
- A는 기본 목표지만 **PR2 gate 통과 전까지 확정안이 아니다.**
- progression / snapshot / session / battle 경계를 흐리지 않는다.

## PR1 — 방향 문서 + ADR 고정

### 목적
새 장기 축을 공식 선언하고, 레거시 PvP 문서와 새 source of truth를 분리한다.

### 포함 내용
- `docs/friendly-battle/` 문서 축 생성
- 방향 ADR
- 옵션 판정 기준표
- A target / B max / C fail 규칙
- Claude Code-only 정의
- 레거시 문서와의 관계 명시

### acceptance criteria
- 새 축을 한 문장으로 설명 가능하다.
- executor가 어떤 문서를 source of truth로 읽어야 하는지 헷갈리지 않는다.

## PR2 — Transport feasibility spike + gate

### 목적
A안을 계속 밀 수 있는지 조기에 결정한다.

이 PR은 **제품 코드 완성 PR이 아니라, transport 방향성을 검증하는 spike PR** 이다.
즉, 여기서는 정식 session contract / battle adapter / user-facing CLI를 다 만들기 전에, **임시 scaffolding 또는 별도 prototype 경로를 써서라도** A가 성립 가능한지 먼저 본다.

### 포함 내용
- same-machine two-terminal 검증
- transport 레벨의 host/join/ready/start/action exchange 프로토타입
- synthetic payload 또는 임시 mock turn payload 기반 왕복 확인
- LAN/manual join 흐름 확인
- 실패 UX 기록
- A 유지 / B 전환 판정

### acceptance criteria
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)의 통과 조건을 만족하거나, 명시적으로 fail 판정한다.
- 결과가 문서/로그로 남는다.
- 이 단계의 산출물은 **throwaway spike 또는 후속 PR에서 재정리될 수 있음** 이 명시된다.

## PR3 — Session / state contract

### 목적
구현 전 책임 경계를 고정한다.

### 포함 내용
- session model
- peer protocol 초안
- progression / snapshot / session / battle boundary
- namespace/path 원칙

### acceptance criteria
- 이후 battle adapter와 CLI가 같은 용어와 경계를 공유한다.
- PR2 spike에서 얻은 교훈이 정식 contract로 흡수된다.

## PR4 — Battle adapter

### 목적
기존 battle engine을 friendly session에 붙일 최소 어댑터를 만든다.

### 포함 내용
- turn submit interface
- result emit interface
- host-authoritative 기준 이벤트 흐름

### acceptance criteria
- transport 없이도 session-facing battle flow를 재현 가능하다.
- PR2 spike에서 확인한 action exchange 흐름을 battle layer에 정식 연결할 수 있다.

## PR5 — Local party snapshot + validation

### 목적
로컬 파티를 친선전에 안전하게 가져오는 계약을 코드로 만든다.

### 포함 내용
- progression -> snapshot 변환
- snapshot schema
- validation 규칙
- generation hooks

### acceptance criteria
- 로컬 progression을 직접 mutate하지 않고 battle-ready snapshot을 만들 수 있다.

## PR6 — Local 2인 harness

### 목적
같은 머신 2터미널 기준 end-to-end 재현 수단을 만든다.

### 포함 내용
- CLI 기반 host / join 재현
- smoke test
- session cleanup

### acceptance criteria
- 세션/battle 문제를 로컬에서 빠르게 재현할 수 있다.
- PR2의 임시 검증 흐름을 대체하는 **정식 재현 수단** 이 된다.

## PR7 — CLI UX 1차

### 목적
문서 없이도 시도 가능한 첫 사용자 흐름을 만든다.

### 포함 내용
- host / join / leave / ready 명령
- 상태 메시지
- 오류 안내

### acceptance criteria
- 개발자가 아닌 사용자도 대략적인 사용 흐름을 이해할 수 있다.
- PR2 spike용 임시 UX와 분리된 **제품용 명령 surface** 가 된다.

## PR8 — Actual transport hardening

### 목적
PR2에서 선택된 transport 경로를 실제 제품 수준으로 다듬는다.

### 포함 내용
- timeout / cancel
- disconnect handling
- 오류 경로 보강

### acceptance criteria
- 최소 친선전 흐름이 반복 가능하고 실패 시 회복 행동이 명확하다.

## PR9 — Friendly ruleset + polish

### 목적
인게임 감성과 친선전 규칙을 맞춘다.

### 포함 내용
- 기본 ruleset
- generation별 확장 포인트
- UX polish
- future trade 메모

### acceptance criteria
- 사용자가 친선전 축의 정체성을 명확히 체감할 수 있다.

## 브랜치 제안

- 권장 브랜치명: `feat/friendly-battle-foundation`
- 대안 브랜치명: `feat/serverless-friendly-battle`

## 관련 문서

- [Friendly Battle 문서 인덱스](../README.md)
- [ADR 0001](../adr/0001-serverless-friendly-battle-direction.md)
- [아키텍처 개요](../architecture/overview.md)
- [상태 경계](../architecture/state-boundary.md)
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)
