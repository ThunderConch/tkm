# PvP 서버 데이터 모델

상위 문서: [PvP 문서 인덱스](../README.md)
관련 문서: [서버 아키텍처](./architecture.md), [DB 스키마 초안](./database-schema.md), [API 계약](./api-contract.md), [성장 및 파티 등록](../game-design/progression-and-party-registration.md), [세대별 ruleset 설계](../game-design/generation-rules.md)

## 목표

데이터 모델의 목표는 다음 세 가지다.

1. 세대별 ruleset을 안정적으로 저장한다.
2. 온라인 파티 등록과 배틀 상태를 분리한다.
3. 실시간 배틀을 복구 가능한 상태로 기록한다.

## 이 문서와 스키마 문서의 역할 분리

- 이 문서는 **엔티티 관계와 책임 분리**를 설명한다.
- [DB 스키마 초안](./database-schema.md)은 이를 **컬럼 / 제약 / 인덱스 수준**으로 구체화한다.

즉, 먼저 이 문서로 “무슨 테이블이 왜 필요한지”를 보고, 그 다음 스키마 문서로 “실제로 어떤 컬럼으로 만들지”를 보는 흐름이 좋다.

## 핵심 엔티티

### 1. `generation_rulesets`

세대별 온라인 룰 정의.

예시 필드:

- `id`
- `generation`
- `ruleset_key` (`tkm-friendly-gen4-v1` 등)
- `battle_type`
- `party_size`
- `team_preview_enabled`
- `species_dup_clause`
- `legendary_mythical_limit`
- `restricted_limit`
- `effective_level_cap`
- `level_compression_policy`
- `is_active`
- `created_at`

### 2. `restricted_species`

ruleset 단위 restricted 목록.

예시 필드:

- `id`
- `ruleset_id`
- `generation`
- `species_id`
- `reason`
- `created_at`

### 3. `online_party_snapshots`

플레이어의 세대별 활성 온라인 파티 스냅샷.

예시 필드:

- `id`
- `player_id`
- `generation`
- `ruleset_id`
- `is_active`
- `source_state_hash`
- `registered_at`
- `updated_at`

권장 제약:

- `(player_id, generation, is_active=true)` 유니크

### 4. `online_party_members`

등록 파티에 포함된 각 포켓몬 상세 정보.

예시 필드:

- `id`
- `party_snapshot_id`
- `slot_index`
- `species_id`
- `nickname`
- `level_actual`
- `level_effective`
- `hp`
- `attack`
- `defense`
- `sp_attack`
- `sp_defense`
- `speed`
- `moves_json`
- `growth_proof_json`

초기엔 구조 단순화를 위해 JSON 저장도 가능하지만, 장기적으로는 일부 정규화가 도움이 될 수 있다.

### 5. `battle_rooms`

실시간 PvP 룸 메타 정보.

예시 필드:

- `id`
- `room_code`
- `generation`
- `ruleset_id`
- `status` (`waiting`, `ready`, `in_progress`, `finished`, `cancelled`)
- `visibility` (`private_friend`)
- `created_by`
- `created_at`
- `started_at`
- `ended_at`
- `winner_player_id`

### 6. `battle_room_players`

각 룸에 참여한 플레이어와 사용 파티 연결.

예시 필드:

- `id`
- `room_id`
- `player_id`
- `side` (`p1`, `p2`)
- `party_snapshot_id`
- `connection_status`
- `joined_at`

### 7. `battle_turns`

실시간 턴 수집 상태와 phase를 명시적으로 관리하는 보조 엔티티.

예시 필드:

- `id`
- `room_id`
- `turn_number`
- `phase`
- `request_kind`
- `deadline_at`
- `status`
- `resolved_at`

### 8. `battle_commands`

클라이언트가 서버에 제출한 명령 기록.

예시 필드:

- `id`
- `room_id`
- `player_id`
- `turn_number`
- `command_type` (`choose_move`, `choose_switch`, `choose_replacement`, `forfeit`)
- `payload_json`
- `submitted_at`
- `accepted`

### 9. `battle_events`

서버가 계산한 결과 이벤트 로그.

예시 필드:

- `id`
- `room_id`
- `sequence`
- `turn_number`
- `event_type`
- `public_payload_json`
- `private_payload_json`
- `created_at`

`public_payload_json`은 양쪽에 공유 가능한 이벤트용, `private_payload_json`은 한쪽 플레이어에게만 보이는 정보를 담는 용도로 나눌 수 있다.

### 10. `player_online_state` (선택)

현재 온라인 접속/복귀/대기 상태를 관리하는 보조 엔티티.

## 중요한 모델링 원칙

### 로컬 파티와 온라인 파티를 분리한다

현재 로컬 `config.party`는 온라인 PvP용 canonical source가 아니다. 따라서 온라인은 반드시 `online_party_snapshots`를 기준으로 돌아가야 한다.

### ruleset을 배틀과 함께 고정한다

배틀이 시작되면 그 시점의 ruleset을 룸에 고정해야 한다. 그래야 추후 restricted 변경이 있어도 과거 배틀 기록과 충돌하지 않는다.

### 배틀 로그는 복구 가능해야 한다

최소한 `battle_commands`와 `battle_events`가 있으면 재접속 시 상태 재구성이 가능하다.

### 턴 phase는 별도 엔티티로 드러내는 편이 구현이 안전하다

문서 레벨에서는 생략 가능하지만, 실제 서버 구현에서는 `battle_turns` 같은 중간 엔티티가 있으면 timeout, 재접속, replacement phase 처리가 훨씬 깔끔해진다.

## 추천 관계도

```text
player
 ├── online_party_snapshots
 │    └── online_party_members
 └── battle_room_players
      └── battle_rooms
           ├── battle_turns
           │    └── battle_commands
           └── battle_events

generation_rulesets
 └── restricted_species
```

## 다음 문서

- [DB 스키마 초안](./database-schema.md)
- [API 계약](./api-contract.md)
- [실시간 배틀 흐름](./battle-flow.md)
