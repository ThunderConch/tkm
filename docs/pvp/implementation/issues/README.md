# PvP 구현 이슈 분해

상위 문서: [PvP 구현 계획 문서](../README.md)  
기반 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [PvP 초기 구현 PRD](../prd.md), [서버 패키지 / 모듈 구조 제안](../server-package-layout.md)

## 목적

이 디렉터리는 PvP MVP를 **실제 구현에 바로 착수할 수 있는 이슈 단위**로 쪼갠다.
각 이슈는 다음 기준을 만족하도록 설계한다.

- 한 번의 구현 스프린트에서 끝낼 수 있을 것
- 테스트 경계가 분명할 것
- 다음 단계의 의존성이 명확할 것
- `src/core` 재사용과 `src/server` 신설 경계를 흐리지 않을 것

## 권장 실행 순서

1. [ISSUE-01 · ruleset / 정책 기반 계층](./ISSUE-01-ruleset-foundation.md)
2. [ISSUE-02 · 온라인 파티 검증 도메인](./ISSUE-02-party-validation-domain.md)
3. [ISSUE-03 · 온라인 파티 등록 API / 저장](./ISSUE-03-party-registration-surface.md)
4. [ISSUE-04 · 친구전 룸 도메인 / 저장](./ISSUE-04-room-domain-and-persistence.md)
5. [ISSUE-05 · 룸 API / 매치 성립 흐름](./ISSUE-05-room-http-and-readiness.md)
6. [ISSUE-06 · 서버 권한 배틀 세션 코어](./ISSUE-06-battle-session-domain.md)
7. [ISSUE-07 · 실시간 명령 게이트웨이](./ISSUE-07-realtime-command-gateway.md)
8. [ISSUE-08 · 재접속 / 운영 안정화](./ISSUE-08-reconnect-and-ops.md)
9. [ISSUE-09 · 클라이언트 배틀 세션 스토어](./ISSUE-09-client-session-store.md)
10. [ISSUE-10 · 클라이언트 프로토콜 어댑터](./ISSUE-10-client-protocol-adapter.md)
11. [ISSUE-11 · WebSocket 클라이언트 커넥터](./ISSUE-11-websocket-client-connector.md)
12. [ISSUE-12 · 클라이언트 재접속 / backoff 컨트롤러](./ISSUE-12-client-reconnect-controller.md)
13. [ISSUE-13 · 상위 PvP session client orchestration 레이어](./ISSUE-13-session-client-orchestrator.md)
14. [ISSUE-14 · PvP action request rendering / input UX adapter](./ISSUE-14-action-request-view.md)
15. [ISSUE-15 · PvP turn resolved rendering / 결과 로그 UX adapter](./ISSUE-15-turn-result-view.md)

## 왜 이 순서인가

PvP에서 가장 먼저 고정되어야 하는 것은 **온라인에서 무엇이 합법 파티인지**다.
ruleset, restricted 목록, 레벨 압축, 치트 오염 판정이 먼저 고정되지 않으면 파티 등록, 룸 매칭, 배틀 로그 해석이 모두 흔들린다.

따라서 초기 착수는 반드시 **정책 계층 → 검증 계층 → 등록 surface** 순으로 간다.

서버 권한 배틀과 재접속 정책이 먼저 완성된 뒤에야, Claude Code / TUI 클라이언트가 신뢰할 수 있는 읽기 모델을 얹을 수 있다.
그래서 클라이언트 측 구현은 **서버 authoritative contract 고정 이후**에 별도 이슈로 분리한다.

## 첫 실행 대상

현재 첫 구현 대상은 [ISSUE-01 · ruleset / 정책 기반 계층](./ISSUE-01-ruleset-foundation.md)이다.

이 이슈가 끝나면 다음 이슈들이 바로 그 위에 올라탈 수 있다.

- ISSUE-02는 ISSUE-01의 ruleset / restricted / 레벨 정책을 그대로 사용한다.
- ISSUE-03은 ISSUE-02의 검증 결과와 ISSUE-01의 ruleset 조회를 HTTP surface로 노출한다.

## 구현 체크포인트 매핑

| 체크포인트 | 필요한 이슈 |
| --- | --- |
| A. 등록만 되는 상태 | ISSUE-01, ISSUE-02, ISSUE-03 |
| B. 룸까지 되는 상태 | ISSUE-04, ISSUE-05 |
| C. 배틀 되는 상태 | ISSUE-06, ISSUE-07 |
| D. 실제 사용 가능한 상태 | ISSUE-08 |
| E. 클라이언트 통합 시작 상태 | ISSUE-09, ISSUE-10, ISSUE-11 |
| F. 실제 접속 안정화 시작 상태 | ISSUE-12 |
| G. 상위 클라이언트 진입점 정리 상태 | ISSUE-13 |
| H. 턴 결과 렌더링 진입점 정리 상태 | ISSUE-14, ISSUE-15 |

## 공통 실행 규칙

- 각 이슈는 가능하면 **테스트 우선(TDD)** 으로 진행한다.
- `src/core`를 수정해야 한다면, 서버 계층이 요구하는 최소한의 재사용 지점만 만든다.
- 서버가 최종 권위자인 값은 클라이언트 입력에서 받지 않는다.
- 이후 이슈가 필요로 하는 식별자(`rulesetKey`, `snapshotId`, `roomId`, `battleId`)는 초기에 안정 키로 설계한다.
