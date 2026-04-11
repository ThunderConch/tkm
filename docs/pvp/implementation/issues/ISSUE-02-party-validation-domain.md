# ISSUE-02 · 온라인 파티 검증 도메인

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-01 · ruleset / 정책 기반 계층](./ISSUE-01-ruleset-foundation.md)  
관련 문서: [온라인 파티 등록 상세 계약](../../server/contracts/party-registration.md), [치트 대응 정책](../../security/anti-cheat.md)

## 목표

클라이언트가 보낸 로컬 파티 후보를 서버 관점의 **온라인 등록 가능 / 불가** 결과로 판정하는 순수 도메인 로직을 만든다.

## 구현 범위

### 신규 모듈

- `src/server/parties/party-types.ts`
- `src/server/parties/party-validator.ts`
- `src/server/parties/growth-proof.ts`

### 테스트

- `test/pvp-party-validator.test.ts`

## 핵심 책임

1. 파티 슬롯 수 검증
2. 중복 종 금지 검증
3. legendary + mythical 총 2 제한 검증
4. restricted 최대 1 제한 검증
5. moves / slot / speciesId 기본 입력 검증
6. growth proof의 member 매칭 검증
7. 치트 오염 플래그 기본 거부
8. `levelActual` → `levelEffective` 계산 반영

## 비범위

- active snapshot 저장
- HTTP route wiring
- DB transaction
- 룸 생성

## 완료 조건

- validator가 성공 시 **정규화된 서버용 party snapshot 초안**을 돌려준다.
- 실패 시 안정 에러 코드 목록을 돌려준다.
- ruleset 변경 없이 validator만으로 대부분의 등록 실패 이유를 설명할 수 있다.

## 테스트 시나리오

- 6마리 정상 파티 승인
- 중복 종 거부
- legendary/mythical 총량 초과 거부
- restricted 2마리 거부
- cheat flagged save 거부
- growth proof slot mismatch 거부
- levelEffective 계산값 포함

## 다음 이슈에 넘기는 계약

ISSUE-03은 이 validator를 감싸서 `PUT /active`에 연결한다.
