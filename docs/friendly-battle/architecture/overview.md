# Friendly Battle 아키텍처 개요

## 목표

이 아키텍처는 다음 목표를 만족해야 한다.

- 로컬에서 키운 파티를 그대로 꺼내 쓴다.
- Claude Code 내부 명령만으로 친선전을 시작할 수 있다.
- 운영 서버 없이도 성립한다.
- battle core와 transport를 느슨하게 분리해, A 실패 시 B로 전환할 여지를 남긴다.

## 최상위 레이어

### 1. Progression layer
스토리 / 로컬 성장 / 저장 데이터의 진짜 원본이다.

예시 책임:
- 잡은 포켓몬 목록
- 현재 파티
- 성장 상태
- 세대별 저장 데이터

### 2. Party snapshot layer
friendly battle 시작 시점에 progression에서 복사해 온 **read-only 전투용 스냅샷** 이다.

예시 책임:
- battle에 필요한 최소 파티 정보
- generation/ruleset 검증용 필드
- peer 교환 가능 포맷

### 3. Session runtime layer
host / join / ready / start / pending turn / disconnect 같은 **세션 상태**를 표현한다.

예시 책임:
- 세션 식별자
- 참가자 상태
- 연결 상태
- choice 제출 대기 상태

### 4. Battle runtime layer
실제 battle engine이 계산하는 전투 상태다.

예시 책임:
- HP / status / field effect
- 턴 순서
- move resolution
- faint / switch / battle end

## 데이터 흐름

1. 사용자가 로컬 progression에서 파티를 선택하거나 현재 파티를 사용한다.
2. progression에서 party snapshot을 생성한다.
3. host / join 과정을 거쳐 session runtime을 만든다.
4. battle start 시 snapshot이 battle runtime으로 주입된다.
5. battle runtime 결과는 세션 이벤트로 변환되어 양쪽 UI/CLI에 전달된다.
6. 친선전 종료 후 결과는 로그/요약으로 남길 수 있지만, progression에 자동 반영되지는 않는다.

## 권장 모듈 경계

- `progression reader`
- `snapshot builder`
- `snapshot validator`
- `session coordinator`
- `transport adapter`
- `battle adapter`
- `cli command surface`

이 구조의 핵심은 **transport가 바뀌어도 snapshot / session / battle 경계는 유지**된다는 점이다.

## 설계 원칙

1. **battle core보다 UX gate를 먼저 본다.**
2. **progression은 원본이고, battle은 snapshot 기반 복사본이다.**
3. **세션 상태와 전투 상태를 섞지 않는다.**
4. **transport 결정은 battle adapter와 분리한다.**
5. **friendly battle은 운영형 온라인 게임처럼 만들지 않는다.**

## 관련 문서

- [ADR 0001](../adr/0001-serverless-friendly-battle-direction.md)
- [연결 구조 후보 비교](./connection-options.md)
- [상태 경계](./state-boundary.md)
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)
- [PR 로드맵](../roadmap/pr-roadmap.md)
