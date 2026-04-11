# PvP 서버 패키지 / 모듈 구조 제안

상위 문서: [PvP 구현 계획 문서](./README.md)  
관련 문서: [서버 아키텍처](../server/architecture.md), [서버 DB 스키마 초안](../server/database-schema.md), [HTTP / WebSocket API 계약 초안](../server/api-contract.md), [PvP 작업 분해 / TODO](./todo-breakdown.md)

## 목적

이 문서는 PvP 서버를 실제로 구현할 때 **repo 안에 어떤 디렉터리와 모듈 경계를 두는 게 좋은지**를 정리한다.  
즉, 앞선 문서들이 “무슨 기능이 필요한가”를 정의했다면, 이 문서는 “그 기능을 코드베이스 어디에 어떻게 놓을 것인가”를 정리하는 문서다.

초기 목표는 다음 세 가지다.

1. 현재 `src/core` 전투 로직을 가능한 한 재사용한다.
2. 온라인 PvP 전용 책임을 `src/server`로 분리한다.
3. HTTP / WebSocket / persistence / battle orchestration 경계를 명확히 만든다.

---

## 현재 repo 기준 전제

현재 repo의 주요 구조는 대략 이렇다.

- `src/core/`: 게임 규칙, 포켓몬 데이터, 전투/성장 로직
- `src/cli/`: CLI 진입점
- `src/battle-tui/`: 로컬 전투 렌더링/UI
- `src/hooks/`, `src/setup/`, `src/audio/`, `src/sprites/`: 부가 기능

즉, **게임 규칙 엔진은 이미 `src/core`에 있고**, 아직 온라인 서버 전용 계층은 없다.  
그래서 초기 PvP 구현은 아래 원칙으로 가는 것이 좋다.

- **게임 규칙은 `src/core` 중심 재사용**
- **온라인 상태 관리와 입출력은 `src/server`로 신설**
- `src/cli`에는 서버 실행/관리용 진입점만 얇게 둠

---

## 추천 최상위 구조

```text
src/
  core/
  cli/
  battle-tui/
  server/
    index.ts
    config/
    auth/
    rules/
    parties/
    rooms/
    battle/
    ws/
    http/
    persistence/
    projection/
    anti-cheat/
    shared/
```

### 왜 `src/server`를 따로 두는가

이유는 단순하다.

- `src/core`는 **오프라인/로컬 전투에서도 재사용 가능한 순수 규칙 계층**으로 남겨야 하고
- `src/server`는 **온라인 PvP 전용 orchestration 계층**이어야 하기 때문이다.

이 분리가 있어야 나중에 다음이 쉬워진다.

- 로컬 battle과 온라인 battle의 경계 유지
- 서버 테스트에서 I/O 계층 mocking
- 향후 spectator / ladder / replay 확장

---

## 모듈별 책임

## 1. `src/server/index.ts`

서버 부트스트랩 진입점.

책임:

- config 로딩
- HTTP 서버 생성
- WebSocket gateway 연결
- persistence wiring
- route 등록
- graceful shutdown

초기에는 여기서 app assembly를 하고, 실제 로직은 하위 디렉터리로 내려보낸다.

---

## 2. `src/server/config/`

서버 환경설정 로더.

예상 파일:

- `env.ts`: 포트, DB URL, WS 설정, timeout 값
- `pvp-config.ts`: PvP 전용 runtime config

책임:

- 환경변수 파싱
- 기본값 정의
- 런타임 설정 검증

---

## 3. `src/server/auth/`

온라인 PvP용 인증 컨텍스트 변환 계층.

예상 파일:

- `player-identity.ts`
- `auth-middleware.ts`
- `token-verifier.ts` 또는 placeholder

책임:

- 외부 인증 토큰에서 `player_id` 추출
- HTTP / WS 요청에 player context 부착
- 익명/잘못된 접근 차단

초기 친선전이라도 `player_id`를 안정적으로 만드는 계층은 미리 분리하는 편이 좋다.

---

## 4. `src/server/rules/`

세대별 ruleset / restricted 목록 / 레벨 압축 정책 담당.

예상 파일:

- `ruleset-repository.ts`
- `ruleset-service.ts`
- `restricted-species.ts`
- `level-compression.ts`
- `ruleset-types.ts`

책임:

- generation별 active ruleset 조회
- restricted 목록 조회
- 레벨 압축 계산
- battle start 시 사용할 ruleset snapshot 생성

이 계층은 `generation_rulesets`, `restricted_species` 테이블과 직접 대응한다.

---

## 5. `src/server/parties/`

온라인 파티 등록/조회/검증 담당.

예상 파일:

- `party-registration-service.ts`
- `party-validator.ts`
- `party-snapshot-repository.ts`
- `growth-proof.ts`
- `party-types.ts`

책임:

- 로컬 파티 입력을 온라인 snapshot으로 정규화
- duplicate species / legendary / mythical / restricted 제한 검증
- `level_actual` -> `level_effective` 계산
- `source_state_hash`, `source_config_hash`, `growth_proof_json` 생성/저장
- generation별 active snapshot 교체

이 계층은 **치트 방어 첫 관문**이다.

---

## 6. `src/server/rooms/`

친구전 룸 생성/참가/준비 상태 관리.

예상 파일:

- `room-service.ts`
- `room-repository.ts`
- `room-code.ts`
- `room-validator.ts`
- `room-types.ts`

책임:

- 룸 생성
- room code 발급
- generation/ruleset mismatch 차단
- 양 플레이어 입장 상태 추적
- battle start 조건 충족 시 방을 in-progress로 전이

이 계층은 `battle_rooms`, `battle_room_players`와 대응한다.

---

## 7. `src/server/battle/`

서버 권한 배틀 orchestration의 핵심.

예상 파일:

- `battle-session-service.ts`
- `battle-turn-service.ts`
- `battle-command-service.ts`
- `battle-engine-adapter.ts`
- `battle-event-log.ts`
- `battle-types.ts`
- `timeout-policy.ts`

책임:

- 현재 룸의 battle lifecycle 관리
- `battle_turns` 생성 / 종료
- 명령 수집 / 중복 방지 / timeout 처리
- 기존 `src/core/battle.ts`, `src/core/turn-battle.ts`와 연결
- 계산 결과를 `battle_events`로 append
- 종료/승패 처리

### 가장 중요한 경계

여기서 중요한 건 **배틀 계산 엔진과 네트워크 입출력을 직접 섞지 않는 것**이다.

- `battle-engine-adapter.ts`는 `src/core` 호출 담당
- `battle-session-service.ts`는 turn lifecycle 담당
- `battle-event-log.ts`는 persistence 및 sequence 보장 담당

이렇게 나누면 전투 규칙 변경이 있어도 WS 코드를 건드릴 일이 줄어든다.

---

## 8. `src/server/ws/`

실시간 WebSocket gateway.

예상 파일:

- `pvp-ws-server.ts`
- `connection-registry.ts`
- `message-router.ts`
- `heartbeat.ts`
- `session-resume.ts`

책임:

- room 단위 연결 관리
- 클라이언트 메시지 파싱
- `battle.command`를 battle 계층으로 라우팅
- heartbeat / disconnect / reconnect 처리
- 특정 player에게만 private payload 전달

여기는 **transport layer**로 유지하고, 게임 판단은 battle 계층에 넘겨야 한다.

---

## 9. `src/server/http/`

REST endpoint 계층.

예상 파일:

- `routes.ts`
- `ruleset-routes.ts`
- `party-routes.ts`
- `room-routes.ts`
- `serializers.ts`

책임:

- ruleset 조회
- active online party 조회/등록
- 룸 생성/참가/조회
- DTO validation
- HTTP 에러 응답 표준화

---

## 10. `src/server/persistence/`

DB 접근 계층.

예상 파일:

- `db.ts`
- `transaction.ts`
- `repositories/`
  - `ruleset-repository.ts`
  - `party-repository.ts`
  - `room-repository.ts`
  - `battle-turn-repository.ts`
  - `battle-command-repository.ts`
  - `battle-event-repository.ts`

책임:

- SQL/ORM 호출 집중
- 트랜잭션 경계 제공
- repository 인터페이스 제공

중요한 점은 business rule을 repository 안에 과하게 넣지 않는 것이다.  
검증/정책은 service 계층, 저장은 repository 계층으로 나눈다.

---

## 11. `src/server/projection/`

플레이어별 시야 투영 계층.

예상 파일:

- `room-snapshot-projection.ts`
- `battle-event-projection.ts`
- `visibility-rules.ts`

책임:

- 같은 room state를 p1/p2에게 다르게 직렬화
- 상대 백라인 비공개 처리
- public/private payload 구성

이 계층을 별도로 두는 이유는 “무엇이 진실인가”와 “무엇을 누구에게 보여줄 것인가”를 분리하기 위해서다.

---

## 12. `src/server/anti-cheat/`

친선전 v1 범위의 치트 방어 계층.

예상 파일:

- `registration-integrity.ts`
- `growth-sanity-check.ts`
- `battle-input-validation.ts`
- `audit-log.ts`

책임:

- 파티 등록 입력 검증
- 비정상 성장 상태 탐지
- 잘못된 command payload 차단
- 감사 로그 보조

초기에는 여기서 모든 치트를 완벽히 막기보다, **온라인 등록과 배틀 입력에서 최소한의 신뢰 경계**를 세우는 역할이 중요하다.

---

## 13. `src/server/shared/`

서버 전용 공통 타입 / 에러 / 유틸.

예상 파일:

- `errors.ts`
- `result.ts`
- `ids.ts`
- `clock.ts`
- `logger.ts`

책임:

- 공통 에러 타입
- ID 생성 보조
- 시간/로그 추상화
- 테스트 가능한 공통 유틸 제공

---

## `src/core`와의 경계

초기 PvP 구현에서 가장 중요한 구조적 원칙 중 하나는 다음이다.

> 온라인 PvP를 만든다고 해서 배틀 규칙 엔진까지 `src/server`로 복제하지 않는다.

즉:

- `src/core/battle.ts`
- `src/core/turn-battle.ts`
- `src/core/moves.ts`
- `src/core/stats.ts`
- `src/core/status-effects.ts`
- `src/core/pokemon-data.ts`

같은 파일들은 **규칙 엔진 / 도메인 데이터 계층**으로 계속 남기고,  
`src/server/battle/battle-engine-adapter.ts`가 이들을 감싸서 온라인 배틀에서 사용하도록 만드는 것이 좋다.

### 추천 어댑터 책임

`battle-engine-adapter.ts`는 다음만 담당한다.

- room state -> core battle input 변환
- core battle result -> server event list 변환
- server RNG seed 주입
- deterministic replay 가능 형태 유지

즉, 서버 battle 계층이 core 엔진을 호출하되, core 엔진이 네트워크나 DB를 알 필요는 없게 만든다.

---

## 추천 CLI 진입점

`src/cli/`에는 온라인 PvP용 관리/개발 진입점을 얇게 두는 것을 권장한다.

예상 파일:

- `src/cli/pvp-server.ts`: 로컬 개발용 서버 실행
- `src/cli/pvp-rules.ts`: ruleset 확인/시드용 보조 명령
- `src/cli/pvp-room-debug.ts`: room 상태 조회/디버그

중요한 점은 CLI가 business logic을 직접 갖지 않고, `src/server`를 호출만 하게 하는 것이다.

---

## 테스트 구조 제안

```text
test/
  pvp/
    rules/
    parties/
    rooms/
    battle/
    projection/
    anti-cheat/
```

### 테스트 레벨

1. **unit**
   - 레벨 압축
   - duplicate species 검사
   - restricted limit 검사
   - projection masking

2. **integration**
   - party registration transaction
   - room create/join
   - battle turn resolve
   - reconnect snapshot rebuild

3. **contract**
   - HTTP response shape
   - WebSocket message shape

---

## 추천 구현 순서와 패키지 생성 순서

### Step 1
- `src/server/config`
- `src/server/shared`
- `src/server/rules`

### Step 2
- `src/server/persistence`
- `src/server/parties`

### Step 3
- `src/server/rooms`
- `src/server/http`

### Step 4
- `src/server/battle`
- `src/server/projection`
- `src/server/ws`

### Step 5
- `src/cli/pvp-server.ts`
- `test/pvp/*`

이 순서가 좋은 이유는, **정책 -> 저장 -> 룸 -> 배틀 -> 실시간 transport** 순으로 의존성이 자연스럽기 때문이다.

---

## 초기 v1에서 일부러 미루는 것

초기 범위에서는 아래는 별도 패키지로 빼지 않아도 된다.

- ladder matchmaking
- spectator delivery
- replay export service
- seasonal ruleset rotation worker
- analytics/event warehouse sink

이런 것들은 친선 PvP v1 범위를 넘는다.

---

## 최종 제안

초기 PvP 구현은 다음 식으로 이해하면 된다.

- `src/core`: 배틀 규칙과 게임 도메인
- `src/server`: 온라인 PvP orchestration
- `src/cli`: 개발/실행 진입점
- `test/pvp`: 서버 검증

이 구조로 가면, 현재 Tokénmon의 로컬 게임 감성을 유지하면서도 **서버 권한 PvP를 무리 없이 얹을 수 있다.**

---

## 다음 문서

- [PvP 작업 분해 / TODO](./todo-breakdown.md)
- [서버 DB 스키마 초안](../server/database-schema.md)
- [HTTP / WebSocket API 계약 초안](../server/api-contract.md)
