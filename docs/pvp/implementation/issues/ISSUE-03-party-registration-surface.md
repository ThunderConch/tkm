# ISSUE-03 · 온라인 파티 등록 API / 저장

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-01 · ruleset / 정책 기반 계층](./ISSUE-01-ruleset-foundation.md), [ISSUE-02 · 온라인 파티 검증 도메인](./ISSUE-02-party-validation-domain.md)  
관련 문서: [온라인 파티 등록 상세 계약](../../server/contracts/party-registration.md), [서버 데이터 모델](../../server/storage/data-model.md)

## 목표

ruleset 조회와 활성 온라인 파티 조회/등록을 실제 서버 surface로 노출한다.

## 구현 범위

### 신규 모듈

- `src/server/http/pvp-rules-routes.ts`
- `src/server/http/pvp-party-routes.ts`
- `src/server/parties/party-registration-service.ts`
- `src/server/parties/party-snapshot-repository.ts`

### 진입점 후보

- `src/server/index.ts`
- `src/cli/pvp-server.ts`

### 테스트

- `test/pvp-party-registration-service.test.ts`
- `test/pvp-routes.test.ts`

## 핵심 책임

1. `GET /api/pvp/rulesets/{generation}`
2. `GET /api/pvp/parties/{generation}/active`
3. `PUT /api/pvp/parties/{generation}/active`
4. 세대당 활성 파티 1개 교체 규칙 적용
5. snapshot version 증가
6. 실패 시 계약 문서의 error envelope 반환

## 비범위

- 룸 생성/참가
- WebSocket
- 배틀 계산

## 완료 조건

- 등록 요청이 validator를 통과하면 active snapshot이 교체된다.
- ruleset과 active snapshot 조회가 모두 동작한다.
- 등록 실패 시 UI가 소비 가능한 에러 코드가 나온다.

## 다음 이슈에 넘기는 계약

ISSUE-04/05는 여기서 확정된 `snapshotId`, `rulesetKey`, `generation`을 룸 생성 시 참조한다.
