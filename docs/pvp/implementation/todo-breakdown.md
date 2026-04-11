# PvP 작업 분해 / TODO

상위 문서: [PvP 구현 계획 문서](./README.md)
기반 설계 문서: [PvP 초기 구현 PRD](./prd.md), [구현 로드맵](../roadmap/rollout-plan.md), [서버 DB 스키마 초안](../server/storage/database-schema.md), [서버 패키지 / 모듈 구조 제안](./server-package-layout.md)
실행 이슈 문서: [PvP 구현 이슈 분해](./issues/README.md)

## 목적

이 문서는 초기 PvP를 실제 코드 작업 단위로 쪼갠다.
순서는 **규칙 확정 → 등록 → 룸 → 서버 권한 배틀 → UX → 안정화** 기준으로 잡는다.

실제 executor 작업은 이 문서를 다시 한 번 정리한 [구현 이슈 문서](./issues/README.md)를 기준으로 나눈다.

---

## Phase 0. 규칙/정책 고정

### TODO
- [ ] generation별 ruleset 키 포맷 결정
- [ ] restricted 시드 리스트를 generation별 정책 데이터로 정리
- [ ] 레벨 압축 공식을 문서에서 구현 규칙으로 확정
- [ ] 치트 오염 상태의 판정 기준 확정

### 산출물
- 정책 파일 또는 정책 로더 초안
- ruleset identifier 규칙
- restricted seed data

---

## Phase 1. 온라인 파티 등록

상세 기준 문서: [온라인 파티 등록 상세 계약](../server/contracts/party-registration.md)

### 서버 작업
- [ ] generation ruleset 조회 endpoint 추가
- [ ] active online party 조회 endpoint 추가
- [ ] active online party 등록/갱신 endpoint 추가
- [ ] 파티 유효성 검증 로직 추가
- [ ] duplicate species / special limit 검증 로직 추가
- [ ] effective level 계산 로직 추가
- [ ] 치트 오염 저장 차단 로직 추가

### 데이터 작업
- [ ] `generation_rulesets` 저장 구조 추가
- [ ] `restricted_species` 저장 구조 추가
- [ ] `online_party_snapshots` 저장 구조 추가
- [ ] `online_party_members` 저장 구조 추가
- [ ] active snapshot 교체 트랜잭션 규칙 추가
- [ ] `source_state_hash` / `source_config_hash` / `growth_proof_json` 저장 정책 고정

### 클라이언트 작업
- [ ] generation별 온라인 룰 조회 화면/명령 추가
- [ ] 온라인 파티 등록 진입 UX 추가
- [ ] 로컬 포켓몬 목록에서 등록 후보 선택 UX 추가
- [ ] 등록 실패 사유 메시지 정의

### 파일/모듈 후보
- 서버 신규 디렉터리: `src/server/`
- 상세 구조 기준: [서버 패키지 / 모듈 구조 제안](./server-package-layout.md)
- CLI 진입점 후보: `src/cli/pvp-server.ts`, `src/cli/pvp-rules.ts`

---

## Phase 2. 친구전 룸 시스템

상세 기준 문서: [친구전 룸 / 매치 성립 상세 계약](../server/contracts/room-and-match.md)

### 서버 작업
- [ ] 룸 생성 endpoint 추가
- [ ] 룸 참가 endpoint 추가
- [ ] room code 생성기 추가
- [ ] room state persistence 추가
- [ ] generation/ruleset mismatch 검증 추가
- [ ] battle start 시점 `ruleset_snapshot_json` freeze 처리 추가

### 데이터 작업
- [ ] `battle_rooms` 저장 구조 추가
- [ ] `battle_room_players` 저장 구조 추가
- [ ] room/player unique 제약 추가

### 클라이언트 작업
- [ ] 룸 생성 UX 추가
- [ ] 룸 코드 입력 후 참가 UX 추가
- [ ] 룸 대기 상태 표시 UX 추가

### 수용 테스트
- [ ] 룸 생성 후 상대 참가 전까지 `waiting_for_opponent` 상태 유지
- [ ] generation mismatch 참가 실패
- [ ] 두 플레이어 binding 완료 후 `awaiting_presence` 진입
- [ ] 양 플레이어 실시간 접속 완료 후 `starting` 전이

---

## Phase 3. 서버 권한 배틀 코어

상세 기준 문서: [실시간 배틀 세션 상세 계약](../server/contracts/realtime-battle-session.md)

### 서버 작업
- [ ] WebSocket 연결 진입점 추가
- [ ] room snapshot 송신 구현
- [ ] `battle.command` 처리기 구현
- [ ] 턴 수집기(command collector) 구현
- [ ] 배틀 계산 어댑터 구현
- [ ] turn resolved event 생성기 구현
- [ ] faint 후 replacement phase 구현
- [ ] victory / forfeit 종료 처리 구현
- [ ] timeout 처리 정책 구현

### 데이터 작업
- [ ] `battle_turns` 저장 구조 추가
- [ ] `battle_commands` 저장 구조 추가
- [ ] `battle_events` 저장 구조 추가
- [ ] public / private payload 분리 저장 규칙 추가

### 클라이언트 작업
- [x] action request 렌더링
- [x] move/switch/replacement 입력 UX adapter 구현
- [x] command accepted 상태 반영
- [x] turn resolved 이벤트 렌더링
- [x] 클라이언트 세션 스토어(`src/pvp/session-store.ts`) 구현
- [x] 클라이언트 프로토콜 어댑터(`src/pvp/client-protocol.ts`) 구현
- [x] WebSocket 클라이언트 커넥터(`src/pvp/websocket-client.ts`) 구현

### 주의사항
- 클라이언트는 결과 계산 금지
- 상대 백라인 정보 누출 금지
- public/private payload 분리 강제

---

## Phase 4. 재접속 / 안정화

### 서버 작업
- [ ] room snapshot 재구성 로직 추가
- [ ] last visible state 복구 로직 추가
- [ ] reconnect 시 타이머 재계산 로직 추가
- [ ] 중복 명령 제출 방지 처리 추가

### 클라이언트 작업
- [ ] 끊김 후 재접속 UX 추가
- [ ] 이미 제출한 명령 표시 처리
- [ ] 진행 중 턴 상태 복원 처리
- [x] session-level PvP screen view model 정리
- [x] deterministic session terminal renderer 추가
- [x] WebSocket connector 위에서 reconnect/backoff 정책 정리
- [x] 상위 PvP session client orchestration 레이어 추가

### 실행 이슈 메모

- Phase 3 클라이언트 기초는 ISSUE-09 ~ ISSUE-11로 완료
- Phase 4 재접속 controller는 ISSUE-12로 완료
- 상위 PvP session client facade는 ISSUE-13으로 완료
- PvP action request 렌더링 / 입력 UX adapter는 ISSUE-14로 완료
- turn resolved 결과 로그 / summary adapter는 ISSUE-15로 완료
- submitted-command / acceptance-status adapter는 ISSUE-16으로 완료
- session-level screen view model adapter는 ISSUE-17로 완료
- deterministic session terminal renderer는 ISSUE-18로 완료
- ISSUE-19는 renderer/action-request/session-client를 묶고, plain-text screen + input token submit/result contract를 고정하는 terminal controller 슬라이스로 진행
- session-store에 last resolved payload를 보존하면 향후 reconnect 뒤 full log 재생 UX까지 확장 가능
- ISSUE-17 이후 상위 consumer는 session snapshot 하나로 transport/session/request/command/result를 함께 소비할 수 있으며, ISSUE-18은 이를 plain-text terminal layout으로 고정한다.
- ISSUE-18 이후 다음 슬라이스는 battle-tui/cli에 이 deterministic renderer를 직접 붙이기 전에, input token bridge를 가진 terminal controller layer를 먼저 고정한다.
- ISSUE-19 이후 battle-tui/cli는 controller contract 위에 stdin loop, room join flow, 화면 refresh 정책만 얹으면 된다.
- ISSUE-20은 controller 위에 live session subscribe/start-stop/submit orchestration을 얹는 runner 슬라이스로 진행하며, 이후 실제 CLI는 stdin loop와 bootstrap만 추가로 붙인다.

---

## Phase 5. 운영/밸런스 후속

### 운영 작업
- [ ] restricted 목록 조정 프로세스 정의
- [ ] ruleset versioning 전략 확정
- [ ] 배틀 로그 디버깅 도구 추가

### 확장 후보
- [ ] spectator mode
- [ ] replay export
- [ ] ladder mode
- [ ] multiple online party slots per generation

---

## 추천 구현 순서

1. 정책 데이터와 ruleset 저장 구조부터 만든다.
2. 온라인 파티 등록을 먼저 만든다.
3. 룸 시스템을 만든다.
4. 그 위에 서버 권한 배틀을 얹는다.
5. 마지막에 재접속/운영 안정화를 붙인다.

이 순서를 추천하는 이유는, **온라인에서 무엇이 유효한 파티인지 먼저 고정되지 않으면 그 다음 단계가 전부 흔들리기 때문**이다.

---

## 구현 체크포인트

### 체크포인트 A. 등록만 되는 상태
- ruleset 조회 가능
- generation별 파티 등록 가능
- 제한 위반 파티 거부 가능

### 체크포인트 B. 룸까지 되는 상태
- 룸 생성/참가 가능
- 양측 활성 파티 묶기 가능

### 체크포인트 C. 배틀 되는 상태
- turn loop 작동
- 종료/승패 저장 가능

### 체크포인트 D. 실제 사용 가능한 상태
- 재접속 복구 가능
- 기본 오류 메시지 정리 완료
- 로그 디버깅 가능
