# 연결 구조 후보 비교

## 평가 기준

모든 옵션은 아래 기준으로 비교한다.

1. Claude Code 내부 명령만으로 host/join 가능한가
2. 로컬 파티 snapshot을 그대로 쓸 수 있는가
3. 친선전 1회 플레이까지의 setup burden이 낮은가
4. 운영 서버 / 계정 / 매칭이 불필요한가
5. 미래 교환 확장 여지가 남는가

## 옵션 A — Host-authoritative direct session

### 개념
- host가 세션을 연다.
- joiner가 주소/코드 기반으로 접속한다.
- battle 계산 권한은 host가 가진다.
- guest는 행동 명령을 보낸다.

### 장점
- battle adapter가 단순하다.
- 기존 단일 battle flow를 재사용하기 쉽다.
- 인게임 감성과 잘 맞는다.

### 단점
- 연결 UX 실패 시 전체 전략이 무너진다.
- NAT/포트/주소 입력 문제가 UX를 악화시킬 수 있다.

### 현재 판정
- **1순위 목표안**
- 단, [Transport feasibility gate](../validation/transport-feasibility-gate.md) 통과 시에만 유지

## 옵션 B — Lockstep P2P

### 개념
- 양쪽이 같은 초기 snapshot과 입력을 공유한다.
- 각자 battle을 시뮬레이션한다.

### 장점
- 운영 서버가 여전히 필요 없다.
- 연결 모델은 단순해 보일 수 있다.

### 단점
- deterministic 보장이 훨씬 중요해진다.
- desync 위험이 커진다.
- RNG / state drift / 버전 차이 대응이 필요하다.

### 현재 판정
- **최대 타협안**
- A가 UX gate를 통과하지 못하면 즉시 하향

## 옵션 C — Minimal relay service

### 개념
- 연결 편의를 위해 중계 서비스나 hosted component를 둔다.

### 장점
- 실사용 연결 UX는 개선될 가능성이 있다.

### 단점
- 운영 서버 전제가 다시 생긴다.
- 이번 축의 철학과 맞지 않는다.

### 현재 판정
- **탈락**

## 비교 요약표

| 항목 | A: Host-authoritative | B: Lockstep P2P | C: Minimal relay |
|---|---|---|---|
| Claude Code-only | 높음 | 중간 | 낮음 |
| 로컬 파티 활용 | 높음 | 높음 | 높음 |
| 초기 setup burden | 미지수 (gate 필요) | 미지수 | 중간 |
| 운영 서버 불필요 | 예 | 예 | 아니오 |
| battle adapter 단순성 | 높음 | 낮음 | 중간 |
| 이번 축 적합성 | 최고 | 차선 | 탈락 |

## 결론

- 기본 추천은 **A** 다.
- 단, A는 감성이나 구조가 아니라 **실제 연결 UX** 로만 유지 여부를 판정한다.
- A가 실패하면 **B** 로 즉시 전환한다.
- C는 이번 축의 장기 방향에서 제외한다.
