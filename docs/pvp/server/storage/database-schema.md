# PvP 서버 DB 스키마 초안

상위 문서: [PvP 서버 Storage 문서](./README.md)
관련 문서: [서버 데이터 모델](./data-model.md), [서버 아키텍처](../architecture.md), [API 계약](../api-contract.md), [친구전 룸 / 매치 성립 상세 계약](../contracts/room-and-match.md), [실시간 배틀 세션 상세 계약](../contracts/realtime-battle-session.md), [치트 대응 정책](../../security/anti-cheat.md), [PvP 작업 분해 / TODO](../../implementation/todo-breakdown.md)

## 목적

이 문서는 `data-model.md`의 high-level 엔티티를 **실제 구현 직전 수준의 DB 스키마 초안**으로 구체화한다.
즉, “어떤 테이블이 필요하다”에서 한 단계 더 들어가서 아래를 고정한다.

1. 각 테이블의 책임
2. 각 컬럼의 타입과 의미
3. 핵심 유니크 제약 / 인덱스 / 관계
4. 구현 순서와 트랜잭션 경계

---

## 스키마 전제

### DB 엔진 가정

초기 초안은 **PostgreSQL 계열 문법/타입**을 기준으로 쓴다.

- PK: `uuid`
- 시각: `timestamptz`
- 자유 구조 payload: `jsonb`
- 작은 상태값: `text + CHECK` 또는 enum

다른 DB를 쓰더라도 구조적 의도는 유지 가능하다.

### 플레이어 테이블은 외부 시스템으로 둔다

현재 Tokénmon repo에는 온라인 계정 canonical table이 아직 없다.
따라서 이 문서에서는 `player_id`를 **인증 레이어가 보장하는 안정적인 opaque identifier** 로 취급한다.

예:

- `player_123`
- `user:discord:abc`
- 향후 auth service subject id

즉, 이 문서의 FK 설명에서 `player_id`는 “외부 플레이어 엔티티를 참조한다”는 의미다.

### 온라인 등록은 accepted snapshot만 저장한다

초기 버전에서는 `online_party_snapshots`에 **서버 검증을 통과한 스냅샷만** 저장하는 쪽을 권장한다.
거부된 등록 시도 로그는 운영 테이블로 분리하는 것이 낫다.

### 온라인 배틀은 등록 시점의 정규화 결과를 사용한다

배틀 직전 로컬 저장을 다시 읽지 않는다.
배틀은 반드시 다음 두 가지를 기준으로 시작한다.

- 서버가 승인한 `online_party_snapshots`
- 서버가 룸 생성/시작 시점에 고정한 `ruleset_snapshot_json`

---

## 권장 테이블 의존 순서

```text
generation_rulesets
  -> restricted_species
  -> online_party_snapshots
       -> online_party_members
  -> battle_rooms
       -> battle_room_players
       -> battle_turns
            -> battle_commands
       -> battle_events
```

초기 구현 순서는 이 의존 순서를 거의 그대로 따라가는 것이 좋다.

---

## 1. `generation_rulesets`

세대별 온라인 친선 PvP 룰의 canonical source.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | ruleset row id |
| `generation` | `text` | not null | `gen1` ~ `gen9` |
| `ruleset_key` | `text` | not null unique | 예: `tkm-friendly-gen4-v1` |
| `battle_type` | `text` | not null | 초기값 `singles` |
| `party_size` | `smallint` | not null | 초기값 `6` |
| `team_preview_enabled` | `boolean` | not null | 초기값 `false` |
| `lead_selection_mode` | `text` | not null | 초기값 `slot1_auto` |
| `species_dup_clause` | `boolean` | not null | 동일 종 금지 여부 |
| `legendary_mythical_limit` | `smallint` | not null | 초기값 `2` |
| `restricted_limit` | `smallint` | not null | 초기값 `1` |
| `level_display_mode` | `text` | not null | 예: `show_actual` |
| `effective_level_cap` | `smallint` | not null | 초기값 `60` |
| `level_compression_policy` | `text` | not null | 예: `soft_cap_after_50` |
| `fainted_replacement_mode` | `text` | not null | 초기값 `manual_choose_next` |
| `timeout_policy` | `text` | not null | 예: `default_action_on_timeout` |
| `is_active` | `boolean` | not null | 세대별 현재 적용 여부 |
| `created_at` | `timestamptz` | not null | 생성 시각 |
| `updated_at` | `timestamptz` | not null | 수정 시각 |

### 핵심 제약 / 인덱스

- `unique (ruleset_key)`
- `index on (generation, is_active)`
- 필요하다면 `partial unique index on (generation) where is_active = true`

### 메모

세대별 현재 활성 ruleset은 1개만 두는 편이 운영이 단순하다.
단, 과거 배틀 재현을 위해 old ruleset row는 soft-delete 하지 말고 남겨두는 것을 권장한다.

---

## 2. `restricted_species`

특정 ruleset에서 restricted 취급하는 종 목록.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | row id |
| `ruleset_id` | `uuid` | FK -> `generation_rulesets.id` | 어느 ruleset 기준인지 |
| `generation` | `text` | not null | 조회 최적화용 중복 컬럼 |
| `species_id` | `text` | not null | 도감/종 식별자 |
| `classification_reason` | `text` | null | 왜 restricted 인지 메모 |
| `created_at` | `timestamptz` | not null | 생성 시각 |

### 핵심 제약 / 인덱스

- `unique (ruleset_id, species_id)`
- `index on (generation, ruleset_id)`

### 메모

`legendary`, `mythical`은 종 메타데이터에서 오고, `restricted`는 **온라인 밸런스 정책 레이어**에서 온다.
따라서 `restricted`는 별도 테이블로 두는 것이 맞다.

---

## 3. `online_party_snapshots`

플레이어가 세대별로 온라인용으로 등록한 파티 스냅샷.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | snapshot id |
| `player_id` | `text` | not null | 외부 auth subject |
| `generation` | `text` | not null | 어느 세대 파티인지 |
| `ruleset_id` | `uuid` | FK -> `generation_rulesets.id` | 검증 기준 ruleset |
| `is_active` | `boolean` | not null | 세대별 현재 활성 스냅샷 여부 |
| `registration_origin` | `text` | not null | 초기값 `local_story_import` |
| `source_state_hash` | `text` | not null | 로컬 state fingerprint |
| `source_config_hash` | `text` | not null | 로컬 config fingerprint |
| `source_profile_version` | `text` | null | 추후 저장 포맷 버전 추적 |
| `registered_client_version` | `text` | null | 어떤 빌드/클라이언트에서 등록했는지 |
| `cheat_check_status` | `text` | not null | 초기값 `passed` |
| `registered_at` | `timestamptz` | not null | 최초 등록 시각 |
| `updated_at` | `timestamptz` | not null | 마지막 갱신 시각 |
| `superseded_by_snapshot_id` | `uuid` | null | 새 스냅샷으로 교체된 경우 연결 |

### 핵심 제약 / 인덱스

- `index on (player_id, generation)`
- `partial unique index on (player_id, generation) where is_active = true`
- `index on (ruleset_id)`

### 설계 포인트

- 유저가 **여러 번 재등록**할 수 있으므로 snapshot history는 남긴다.
- 그러나 초기 UX는 **generation별 active slot 1개**만 허용한다.
- 서버는 배틀 매칭 시 active snapshot만 참조한다.

---

## 4. `online_party_members`

등록 스냅샷에 포함된 각 포켓몬의 정규화된 온라인 배틀 입력값.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | member row id |
| `party_snapshot_id` | `uuid` | FK -> `online_party_snapshots.id` | 어느 스냅샷 소속인지 |
| `slot_index` | `smallint` | not null | 1~6 |
| `source_local_ref` | `text` | not null | 로컬 원본 참조값(현재 구조상 species 기반 ref 가능) |
| `species_id` | `text` | not null | 종 id |
| `form_id` | `text` | null | 폼/형태 구분이 필요할 때 |
| `nickname` | `text` | null | 별명 |
| `level_actual` | `smallint` | not null | 실제 성장 레벨 |
| `level_effective` | `smallint` | not null | 압축 후 실제 배틀 계산 레벨 |
| `exp_value` | `integer` | null | 로컬 성장 검증용 보조 값 |
| `stat_hp` | `integer` | not null | 등록 시점 최대 HP |
| `stat_attack` | `integer` | not null | 공격 |
| `stat_defense` | `integer` | not null | 방어 |
| `stat_sp_attack` | `integer` | not null | 특수공격 |
| `stat_sp_defense` | `integer` | not null | 특수방어 |
| `stat_speed` | `integer` | not null | 스피드 |
| `move_1_id` | `text` | null | 기술 1 |
| `move_2_id` | `text` | null | 기술 2 |
| `move_3_id` | `text` | null | 기술 3 |
| `move_4_id` | `text` | null | 기술 4 |
| `growth_proof_json` | `jsonb` | not null | 서버가 검증에 사용한 성장/획득 근거 요약 |
| `registered_at` | `timestamptz` | not null | 등록 시각 |

### 핵심 제약 / 인덱스

- `unique (party_snapshot_id, slot_index)`
- `index on (party_snapshot_id)`
- 등록 트랜잭션 내부 검증: snapshot 단위에서 `species_id` 중복 금지

### 설계 포인트

- 초기 버전에서는 move slot을 4개 고정 컬럼으로 두는 편이 가장 단순하다.
- `growth_proof_json`은 완전 무결성 증명이 아니라, **온라인 등록 당시 서버가 어떤 근거로 통과시켰는지 보존하는 감사 정보**다.
- 현재 온라인 친선 규칙에서는 배틀 시작 시 **풀 HP / 비휘발 상태 초기화**를 기본 가정으로 두는 편이 안전하다. 따라서 현재 체력, 독/화상 같은 전투 중 상태는 등록 스냅샷에 넣지 않는다.

---

## 5. `battle_rooms`

친구전 방과 배틀 메타데이터를 저장한다.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | room id |
| `room_code` | `text` | not null unique | 초대 코드 |
| `generation` | `text` | not null | 해당 룸의 세대 |
| `ruleset_id` | `uuid` | FK -> `generation_rulesets.id` | 시작 시점 ruleset row |
| `ruleset_key` | `text` | not null | 조회 편의 / 감사용 |
| `ruleset_snapshot_json` | `jsonb` | not null | 배틀 시점 ruleset freeze |
| `battle_type` | `text` | not null | 초기값 `singles` |
| `visibility` | `text` | not null | 초기값 `private_friend` |
| `status` | `text` | not null | `waiting_for_opponent`, `awaiting_presence`, `starting`, `in_progress`, `finished`, `cancelled` |
| `current_phase` | `text` | not null | `awaiting_presence`, `starting`, `awaiting_actions`, `resolving_turn`, `awaiting_replacement`, `finished` |
| `created_by_player_id` | `text` | not null | 룸 생성자 |
| `winner_player_id` | `text` | null | 승자 |
| `winning_side` | `text` | null | `p1`, `p2` |
| `end_reason` | `text` | null | `all_fainted`, `forfeit`, `disconnect`, `cancelled` |
| `current_turn_number` | `integer` | not null | 현재 턴 번호 |
| `rng_seed` | `text` | null | 서버 내부 deterministic replay용 |
| `created_at` | `timestamptz` | not null | 생성 시각 |
| `started_at` | `timestamptz` | null | 시작 시각 |
| `ended_at` | `timestamptz` | null | 종료 시각 |

### 핵심 제약 / 인덱스

- `unique (room_code)`
- `index on (created_by_player_id, created_at desc)`
- `index on (status, generation)`

### 설계 포인트

가장 중요한 컬럼은 `ruleset_snapshot_json`이다.
이 값을 저장해야, 나중에 restricted 목록이나 레벨 정책이 바뀌더라도 **과거 배틀은 당시 기준 그대로 재현**할 수 있다.

---

## 6. `battle_room_players`

각 룸에 어떤 플레이어가 어느 side로 참가했고, 어떤 파티 스냅샷을 썼는지 기록한다.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | row id |
| `room_id` | `uuid` | FK -> `battle_rooms.id` | 어느 룸인지 |
| `player_id` | `text` | not null | 참가 플레이어 |
| `side` | `text` | not null | `p1` 또는 `p2` |
| `party_snapshot_id` | `uuid` | FK -> `online_party_snapshots.id` | 사용한 파티 |
| `connection_status` | `text` | not null | `joined`, `connected`, `disconnected`, `reconnected`, `left` |
| `last_seen_at` | `timestamptz` | null | 마지막 heartbeat 시각 |
| `joined_at` | `timestamptz` | not null | 입장 시각 |
| `ready_at` | `timestamptz` | null | 배틀 시작 준비 완료 시각 |

### 핵심 제약 / 인덱스

- `unique (room_id, side)`
- `unique (room_id, player_id)`
- `index on (player_id, joined_at desc)`

### 설계 포인트

온라인 배틀 시작 이후에는 이 row가 **어떤 snapshot으로 싸웠는지**를 고정한다.
중간에 active party를 재등록해도 이미 시작된 배틀에는 영향을 주지 않는다.

---

## 7. `battle_turns`

실시간 턴 수집과 phase 전이를 명시적으로 관리하는 보조 테이블.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | turn phase id |
| `room_id` | `uuid` | FK -> `battle_rooms.id` | 어느 룸인지 |
| `turn_number` | `integer` | not null | 메인 턴 번호 |
| `phase` | `text` | not null | `main`, `replacement_p1`, `replacement_p2`, `replacement_both` |
| `request_kind` | `text` | not null | `choose_move_or_switch`, `choose_replacement` 등 |
| `deadline_at` | `timestamptz` | null | 행동 제출 마감 |
| `status` | `text` | not null | `collecting`, `locked`, `resolved`, `expired` |
| `resolved_at` | `timestamptz` | null | phase 종료 시각 |
| `created_at` | `timestamptz` | not null | 생성 시각 |

### 핵심 제약 / 인덱스

- `unique (room_id, turn_number, phase)`
- `index on (room_id, status)`
- `index on (deadline_at)`

### 왜 필요한가

문서 수준에서는 생략 가능하지만 구현 관점에서는 이 테이블이 있으면 아래가 쉬워진다.

- 명령 중복 제출 방지
- timeout 처리
- replacement phase 분리
- 재접속 시 현재 입력 대기 상태 복원

---

## 8. `battle_commands`

클라이언트가 제출한 실제 명령 원본. append-only 성격을 권장한다.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | command id |
| `room_id` | `uuid` | FK -> `battle_rooms.id` | 어느 룸인지 |
| `turn_id` | `uuid` | FK -> `battle_turns.id` | 어느 phase 요청에 대한 응답인지 |
| `player_id` | `text` | not null | 제출 플레이어 |
| `side` | `text` | not null | `p1` / `p2` |
| `command_type` | `text` | not null | `choose_move`, `choose_switch`, `choose_replacement`, `forfeit` |
| `request_nonce` | `text` | not null | 서버가 요청마다 발급한 nonce |
| `payload_json` | `jsonb` | not null | 실제 선택 payload |
| `accepted` | `boolean` | not null | 수락 여부 |
| `rejection_reason` | `text` | null | 거절 사유 |
| `submitted_at` | `timestamptz` | not null | 제출 시각 |
| `processed_at` | `timestamptz` | null | 검증 완료 시각 |

### 핵심 제약 / 인덱스

- `unique (turn_id, player_id)`
- `unique (request_nonce, player_id)`
- `index on (room_id, submitted_at)`

### 설계 포인트

- `battle_commands`는 서버 계산의 입력 감사 로그다.
- accepted/rejected를 모두 남기면, UX 디버깅과 악용 분석이 쉬워진다.
- 클라이언트는 같은 턴에 여러 번 바꾸는 기능을 지원하지 않는 초기안이므로 `unique (turn_id, player_id)`가 자연스럽다.

---

## 9. `battle_events`

서버가 계산해 확정한 결과 이벤트 로그.

| 컬럼 | 타입 | 제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | event id |
| `room_id` | `uuid` | FK -> `battle_rooms.id` | 어느 룸인지 |
| `sequence` | `bigint` | not null | 룸 내 단조 증가 순번 |
| `turn_number` | `integer` | not null | 어느 턴 결과인지 |
| `phase` | `text` | not null | `main`, `replacement_*`, `end` |
| `event_type` | `text` | not null | `move_used`, `damage_applied`, `pokemon_fainted` 등 |
| `public_payload_json` | `jsonb` | null | 양측 공통 공개 payload |
| `p1_private_payload_json` | `jsonb` | null | p1 전용 추가 payload |
| `p2_private_payload_json` | `jsonb` | null | p2 전용 추가 payload |
| `server_payload_json` | `jsonb` | null | 디버깅/복구용 서버 내부 payload |
| `created_at` | `timestamptz` | not null | 생성 시각 |

### 핵심 제약 / 인덱스

- `unique (room_id, sequence)`
- `index on (room_id, turn_number, sequence)`

### 설계 포인트

- 초기 PvP는 **상대 백라인 비공개**가 매우 중요하므로, public/private projection 분리를 row 구조에 반영하는 것이 좋다.
- 배틀 결과 조작 방지의 핵심은 결국 `battle_events`가 서버에서만 append된다는 점이다.

---

## 테이블별 트랜잭션 권장 경계

### A. 온라인 파티 재등록

한 트랜잭션에서 다음 순서로 처리한다.

1. active snapshot 조회 + lock
2. ruleset 검증
3. duplicate / restricted / level 정책 검증
4. cheat check 통과 확인
5. 새 `online_party_snapshots` insert
6. `online_party_members` 1~6 insert
7. 이전 active snapshot 비활성화
8. 새 snapshot 활성화 commit

### B. 룸 시작

1. 룸 생성 또는 참가 완료
2. 양측 active snapshot 확정
3. `battle_rooms.ruleset_snapshot_json` 채움
4. `battle_room_players` 2명 row 고정
5. 첫 `battle_turns` row 생성

### C. 턴 처리

1. `battle_commands` 수집
2. 양측 명령 충족 또는 timeout
3. 서버 계산
4. `battle_events` append
5. `battle_rooms.current_turn_number` / `current_phase` 갱신
6. 다음 `battle_turns` 생성 또는 종료

---

## 구현 우선순위 기준으로 본 필수 컬럼

### Phase 1에서 꼭 필요한 것

- `generation_rulesets`
- `restricted_species`
- `online_party_snapshots`
- `online_party_members`
- `source_state_hash`, `source_config_hash`, `growth_proof_json`

### Phase 2에서 꼭 필요한 것

- `battle_rooms`
- `battle_room_players`
- `ruleset_snapshot_json`

### Phase 3에서 꼭 필요한 것

- `battle_turns`
- `battle_commands`
- `battle_events`

---

## 일부 컬럼을 굳이 지금 넣지 않는 이유

### 로컬 저장 전문(raw save blob)

초기 버전에는 과하다.
해시와 정규화된 성장 결과, 그리고 `growth_proof_json` 정도면 친선전 수준의 초기 보호에는 충분하다.

### spectator / replay / ladder 전용 테이블

지금 넣으면 설계가 빨리 커진다.
친선 PvP v1 범위를 넘는 기능은 후속 migration으로 분리하는 편이 낫다.

### multiple active party slots

초기에는 generation별 active slot 1개가 운영/UX/검증 모두 가장 단순하다.
이후 확장 시 `slot_name` 또는 `slot_index` 개념을 `online_party_snapshots`에 추가하면 된다.

---

## 스키마와 현재 문서의 대응 관계

- `data-model.md`는 **엔티티 개념도**다.
- 이 문서는 **구체 컬럼/제약 초안**이다.
- `api-contract.md`는 이 스키마를 바탕으로 request/response shape를 정의한다.
- `anti-cheat.md`는 여기서 `source_*_hash`, `growth_proof_json`, `ruleset_snapshot_json`, `battle_events` 같은 컬럼이 왜 필요한지 설명한다.

---

## 추천 migration 순서

1. `generation_rulesets`
2. `restricted_species`
3. `online_party_snapshots`
4. `online_party_members`
5. `battle_rooms`
6. `battle_room_players`
7. `battle_turns`
8. `battle_commands`
9. `battle_events`

이 순서면 **ruleset -> registration -> room -> battle** 흐름과 구현 단계가 일치한다.

---

## 다음 문서

- [서버 데이터 모델](./data-model.md)
- [HTTP / WebSocket API 계약 초안](../api-contract.md)
- [PvP 작업 분해 / TODO](../../implementation/todo-breakdown.md)
