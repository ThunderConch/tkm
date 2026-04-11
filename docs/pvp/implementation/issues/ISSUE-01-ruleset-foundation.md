# ISSUE-01 · ruleset / 정책 기반 계층

상위 문서: [PvP 구현 이슈 분해](./README.md)  
관련 문서: [PvP 초기 구현 PRD](../prd.md), [세대별 ruleset 설계](../../game-design/generation-rules.md), [전설 / 환상 / restricted 정책](../../game-design/special-pokemon-policy.md), [온라인 파티 등록 상세 계약](../../server/contracts/party-registration.md)

## 목표

온라인 PvP에서 사용할 **세대별 ruleset / restricted 정책 / 레벨 압축 규칙**을 코드로 고정한다.

이 이슈가 끝나면 서버는 최소한 다음 질문에 답할 수 있어야 한다.

- `gen4`의 현재 PvP ruleset key는 무엇인가?
- 이 세대에서 special limit는 무엇인가?
- 어떤 species가 restricted인가?
- 실제 레벨을 PvP 계산용 유효 레벨로 어떻게 압축하는가?

## 구현 범위

### 신규 모듈

- `src/server/rules/ruleset-types.ts`
- `src/server/rules/level-compression.ts`
- `src/server/rules/restricted-species.ts`
- `src/server/rules/ruleset-repository.ts`
- `src/server/rules/ruleset-service.ts`

### 테스트

- `test/pvp-ruleset.test.ts`

## 핵심 책임

1. generation별 active ruleset 정의
2. `rulesetKey` 형식 고정
3. legendary / mythical / restricted limit 값 제공
4. restricted species seed 데이터 조회
5. `soft-cap-after-50-v1` 계산 함수 구현
6. `effectiveLevelCap = 60` 보장

## 비범위

- HTTP endpoint
- DB 저장
- 온라인 파티 검증 전체
- 치트 오염 판정 전체
- 룸 / 배틀 / WebSocket

## 완료 조건

- `getRulesetByGeneration('gen4')` 같은 API가 동작한다.
- ruleset summary가 계약 문서의 주요 필드를 재현한다.
- restricted species 조회가 generation / ruleset 기준으로 가능하다.
- 레벨 압축 계산이 테스트로 고정된다.

## 테스트 시나리오

- `gen4` ruleset 조회 성공
- 미지원 generation 조회 실패
- restricted 목록에 특정 species 포함 여부 판정 성공
- 레벨 1, 50, 51, 60, 72, 100 케이스의 effective level 계산 검증
- 어떤 실제 레벨도 effective level 60을 넘지 않음

## 다음 이슈에 넘기는 계약

ISSUE-02는 이 이슈가 제공하는 값을 그대로 사용한다.

- `rulesetKey`
- `specialLimits`
- `battlePolicy`
- `levelPolicy`
- `isRestrictedSpecies(...)`
- `computeEffectiveLevel(...)`

## 권장 구현 메모

- 초기 버전은 DB보다 **정적 정책 데이터 + repository 인터페이스**로 시작해도 된다.
- 이후 DB가 들어와도 `ruleset-service.ts`의 public contract는 유지하는 방향이 좋다.
