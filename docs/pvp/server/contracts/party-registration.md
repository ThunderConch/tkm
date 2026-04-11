# 온라인 파티 등록 상세 계약

상위 문서: [PvP 서버 Contracts 문서](./README.md)  
관련 문서: [API 계약 초안](../api-contract.md), [서버 데이터 모델](../storage/data-model.md), [DB 스키마 초안](../storage/database-schema.md), [성장 및 파티 등록](../../game-design/progression-and-party-registration.md), [치트 대응 정책](../../security/anti-cheat.md)

## 목적

이 문서는 초기 PvP의 **Phase 1 계약**을 상세화한다.  
범위는 다음 세 가지다.

1. `GET /api/pvp/rulesets/{generation}`
2. `GET /api/pvp/parties/{generation}/active`
3. `PUT /api/pvp/parties/{generation}/active`

즉, “이 세대에서 어떤 룰로 싸우는가”와 “내가 지금 온라인에서 사용할 파티가 무엇인가”를 서버 기준으로 확정하는 계약이다.

---

## 범위 밖

이 문서는 아직 아래를 다루지 않는다.

- 룸 생성 / 참가
- WebSocket 실시간 배틀 명령
- 배틀 종료 후 보상 지급
- 서버 주도 성장 전체 이관

---

## 계약 원칙

### 1. 서버가 온라인 사용 가능 여부를 최종 판단한다
클라이언트는 로컬 저장에서 파티 후보를 읽어 올 수는 있지만, **온라인에 실제로 사용 가능한 파티**는 서버가 검증 후 승인한 활성 스냅샷뿐이다.

### 2. 등록은 전체 교체(full replace)다
`PUT /active`는 부분 수정이 아니라, 해당 세대의 활성 파티 전체를 새 스냅샷으로 교체하는 연산이다.

### 3. 클라이언트는 계산 결과를 보내지 않는다
클라이언트는 `levelEffective`, 특수 포켓몬 분류 판정, 제한 카운트, 치트 판정 결과를 보내지 않는다. 이 값들은 모두 서버가 계산한다.

### 4. 로컬 성장의 감성은 보존하되, 온라인 진입은 서버 스냅샷으로 고정한다
스토리/로컬에서 키운 파티를 가져오되, 온라인 전투 중에는 로컬 저장이 아니라 **등록 시점 스냅샷**만 사용한다.

---

## 공통 전송 규칙

- 프로토콜: HTTPS + JSON
- 인코딩: UTF-8
- 시간 포맷: RFC 3339 / ISO-8601 UTC 문자열
- 인증: `Authorization: Bearer <token>` 가정
- `generation`은 path parameter로만 받는다. 별도 body 중복 필드는 허용하지 않는다.
- 모든 성공 응답은 최소한 `generation`, `rulesetKey` 또는 `snapshotId`처럼 **현재 서버가 확정한 식별자**를 포함한다.
- 모든 실패 응답은 아래 `error` envelope를 사용한다.

### 공통 에러 envelope

```json
{
  "error": {
    "code": "PVP_SPECIES_DUPLICATE",
    "message": "Duplicate species are not allowed in an online party.",
    "retryable": false,
    "details": {
      "generation": "gen4",
      "field": "members[3].speciesId"
    }
  }
}
```

### 공통 에러 필드

| 필드 | 설명 |
|---|---|
| `code` | 기계 판독용 안정 식별자 |
| `message` | 사용자/로그용 설명 |
| `retryable` | 같은 입력으로 즉시 재시도 가치가 있는지 |
| `details` | 필드 오류, 제한 초과 수치, 현재 ruleset key 등 부가 정보 |

---

## 공유 객체 계약

## RulesetSummary

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "status": "active",
  "party": {
    "size": 6,
    "activePartySlotsPerPlayer": 1,
    "speciesDupClause": true
  },
  "specialLimits": {
    "legendaryMythicalTotal": 2,
    "restrictedTotal": 1
  },
  "levelPolicy": {
    "displayMode": "actual-level-visible",
    "effectiveFormulaKey": "soft-cap-after-50-v1",
    "softCapStartsAt": 50,
    "effectiveLevelCap": 60
  },
  "battlePolicy": {
    "format": "single",
    "teamPreview": false,
    "leadSelection": "slot1_auto",
    "replacementSelection": "manual",
    "actionTimeoutSeconds": 45
  },
  "cheatPolicy": {
    "requireCleanSave": true,
    "allowCheatFlaggedSave": false,
    "growthSnapshotRequired": true
  },
  "updatedAt": "2026-04-11T06:00:00Z"
}
```

### 의미

- `activePartySlotsPerPlayer`: 초기 버전에서는 세대당 활성 온라인 파티 1개만 허용한다.
- `effectiveFormulaKey`: 실제 계산식 자체를 하드코딩 문자열로 박기보다, **버전 가능한 정책 키**로 고정한다.
- `specialLimits`: `legendary`, `mythical`, `restricted` 분류는 서버 정책 데이터가 최종 기준이다.

---

## OnlinePartyMemberInput

`PUT /active` 요청의 `members[]` 요소 계약이다.

```json
{
  "slot": 1,
  "pokemonInstanceId": "pkm_8f0d2f7a",
  "speciesId": "483",
  "nickname": "Dialga",
  "levelActual": 72,
  "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
}
```

### 필드 규칙

| 필드 | 타입 | 규칙 |
|---|---|---|
| `slot` | integer | 1~6, 중복 불가 |
| `pokemonInstanceId` | string | 로컬 저장에서 해당 개체를 식별하는 안정 ID |
| `speciesId` | string | 서버 도감 기준 species 식별자 |
| `nickname` | string | 선택, 서버가 길이/금칙문자 정규화 가능 |
| `levelActual` | integer | 1 이상, 서버가 로컬 스냅샷과 대조 |
| `moves` | string[] | 정확히 4개를 기본 가정, 중복/존재/세대 적합성은 서버 검증 |

### 입력 금지 필드

클라이언트는 다음 값을 보내지 않는다.

- `levelEffective`
- `isLegendary`
- `isMythical`
- `isRestricted`
- `cheatStatus`
- `currentHp`
- `statusCondition`
- `battleStatStage`

이 값들은 모두 서버 계산/판정 대상이다.

---

## GrowthProofInput

초기 버전은 로컬 저장 전체를 신뢰하지 않기 때문에, 등록 요청에는 **최소 성장 증빙 메타데이터**가 포함되어야 한다.

```json
{
  "proofVersion": "v1",
  "capturedAt": "2026-04-11T06:12:00Z",
  "sourceSaveId": "save_main",
  "sourceSaveRevision": 184,
  "cheatFlags": {
    "hasCheatHistory": false,
    "flags": []
  },
  "memberProofs": [
    {
      "slot": 1,
      "pokemonInstanceId": "pkm_8f0d2f7a",
      "speciesId": "483",
      "levelActual": 72,
      "movesHash": "sha256:3a4f...",
      "stateHash": "sha256:8d10..."
    }
  ]
}
```

### 최소 요구 의도

초기 버전에서 이것은 “완전한 암호학적 증명”이 아니다.  
대신 서버가 다음을 확인할 수 있게 해 주는 **등록 시점 일관성 메타데이터**다.

1. 어떤 저장 기준에서 읽었는가
2. 그 저장 revision이 무엇인가
3. 치트 오염 플래그가 있었는가
4. 각 엔트리가 어떤 개체/상태 해시를 기반으로 추출되었는가

### 서버 해석 원칙

- `proofVersion`이 모르면 등록 거부
- `cheatFlags.hasCheatHistory == true`면 기본 거부
- `memberProofs`는 `members`와 slot / instanceId 기준으로 일치해야 함
- `movesHash`, `stateHash`는 서버가 현재 지원하는 검증 수준에 따라 비교하거나 저장만 할 수 있음
- 초기 버전은 “검증 가능한 만큼 검증하고, 검증 불가 항목은 저장 후 감사 가능하게 남기는” 전략을 쓴다

---

## OnlinePartySnapshot

서버가 확정해 저장/응답하는 활성 파티 스냅샷이다.

```json
{
  "snapshotId": "ops_gen4_000123",
  "snapshotVersion": 3,
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "status": "active",
  "registeredAt": "2026-04-11T06:12:03Z",
  "sourceStateHash": "sha256:0bb1...",
  "sourceConfigHash": "sha256:17cc...",
  "validationStatus": "accepted",
  "partySummary": {
    "memberCount": 6,
    "legendaryMythicalCount": 2,
    "restrictedCount": 1,
    "speciesDupClause": true
  },
  "members": [
    {
      "slot": 1,
      "pokemonInstanceId": "pkm_8f0d2f7a",
      "speciesId": "483",
      "nickname": "Dialga",
      "levelActual": 72,
      "levelEffective": 54,
      "specialClass": {
        "legendary": true,
        "mythical": false,
        "restricted": true
      },
      "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
    }
  ]
}
```

### 서버 생성 필드

다음 값은 클라이언트 입력이 아니라 서버가 생성한다.

- `snapshotId`
- `snapshotVersion`
- `validationStatus`
- `partySummary.*`
- `members[].levelEffective`
- `members[].specialClass`

---

## Endpoint 1. Ruleset 조회

### 요청

`GET /api/pvp/rulesets/{generation}`

### 성공 응답

`200 OK`

응답 body는 [`RulesetSummary`](#rulesetsummary)와 같다.

### 실패 케이스

| HTTP | code | 의미 |
|---|---|---|
| 401 | `PVP_UNAUTHORIZED` | 로그인/세션 없음 |
| 404 | `PVP_RULESET_NOT_FOUND` | 해당 세대 ruleset 없음 |
| 410 | `PVP_RULESET_DISABLED` | 세대는 존재하지만 현재 비활성 |

### 메모

이 endpoint는 클라이언트가 파티 등록 UI를 그리기 전에 반드시 호출하는 것을 권장한다.  
즉, 등록 계약의 기준은 **클라이언트 하드코딩이 아니라 서버 ruleset**이다.

---

## Endpoint 2. 활성 파티 조회

### 요청

`GET /api/pvp/parties/{generation}/active`

### 성공 응답

`200 OK`

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "party": {
    "snapshotId": "ops_gen4_000123",
    "snapshotVersion": 3,
    "status": "active",
    "registeredAt": "2026-04-11T06:12:03Z",
    "sourceStateHash": "sha256:0bb1...",
    "sourceConfigHash": "sha256:17cc...",
    "validationStatus": "accepted",
    "partySummary": {
      "memberCount": 6,
      "legendaryMythicalCount": 2,
      "restrictedCount": 1,
      "speciesDupClause": true
    },
    "members": [
      {
        "slot": 1,
        "pokemonInstanceId": "pkm_8f0d2f7a",
        "speciesId": "483",
        "nickname": "Dialga",
        "levelActual": 72,
        "levelEffective": 54,
        "specialClass": {
          "legendary": true,
          "mythical": false,
          "restricted": true
        },
        "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
      }
    ]
  }
}
```

### 실패 케이스

| HTTP | code | 의미 |
|---|---|---|
| 401 | `PVP_UNAUTHORIZED` | 로그인/세션 없음 |
| 404 | `PVP_ACTIVE_PARTY_NOT_FOUND` | 해당 세대의 활성 파티 미등록 |
| 409 | `PVP_RULESET_MISMATCH` | 현재 활성 파티가 더 이상 유효하지 않은 과거 ruleset에 묶여 있음 |

### 메모

- `404`는 에러이지만 UX 관점에서는 “아직 등록 안 함” 상태로 취급 가능하다.
- 서버는 필요하면 과거 snapshot을 유지하더라도, 이 endpoint는 항상 **현재 활성 1개**만 반환한다.

---

## Endpoint 3. 활성 파티 등록 / 갱신

### 요청

`PUT /api/pvp/parties/{generation}/active`

```json
{
  "sourceStateHash": "sha256:0bb1...",
  "sourceConfigHash": "sha256:17cc...",
  "clientBuild": "tokenmon-cli/0.120.0",
  "members": [
    {
      "slot": 1,
      "pokemonInstanceId": "pkm_8f0d2f7a",
      "speciesId": "483",
      "nickname": "Dialga",
      "levelActual": 72,
      "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
    },
    {
      "slot": 2,
      "pokemonInstanceId": "pkm_6af1a611",
      "speciesId": "491",
      "nickname": "Darkrai",
      "levelActual": 63,
      "moves": ["dark-pulse", "hypnosis", "dream-eater", "double-team"]
    }
  ],
  "growthProof": {
    "proofVersion": "v1",
    "capturedAt": "2026-04-11T06:12:00Z",
    "sourceSaveId": "save_main",
    "sourceSaveRevision": 184,
    "cheatFlags": {
      "hasCheatHistory": false,
      "flags": []
    },
    "memberProofs": [
      {
        "slot": 1,
        "pokemonInstanceId": "pkm_8f0d2f7a",
        "speciesId": "483",
        "levelActual": 72,
        "movesHash": "sha256:3a4f...",
        "stateHash": "sha256:8d10..."
      },
      {
        "slot": 2,
        "pokemonInstanceId": "pkm_6af1a611",
        "speciesId": "491",
        "levelActual": 63,
        "movesHash": "sha256:6d28...",
        "stateHash": "sha256:113f..."
      }
    ]
  }
}
```

### 요청 필드 규칙

| 필드 | 규칙 |
|---|---|
| `sourceStateHash` | 로컬 저장 상태 스냅샷 해시. 동일 저장 기반 여부 확인에 사용 |
| `sourceConfigHash` | 로컬 설정/룰 관련 구성 해시. 호환성 추적용 |
| `clientBuild` | 선택. 디버깅/운영 추적용 |
| `members` | 정확히 6마리 요구 |
| `growthProof` | 필수. 최소 `proofVersion`, `capturedAt`, `sourceSaveRevision`, `cheatFlags`, `memberProofs` 필요 |

### 서버 검증 순서

1. 인증/유저 식별 확인
2. `generation`에 대한 활성 ruleset 확인
3. payload shape 검증
4. `members` 정확히 6마리인지 확인
5. `slot`이 1~6 유일한지 확인
6. `speciesId` 중복 금지 확인
7. `members`와 `growthProof.memberProofs` 일치 확인
8. 치트 플래그/오염 저장 여부 확인
9. 세대/기술셋/개체 상태의 최소 합법성 확인
10. `legendary + mythical <= 2` 확인
11. `restricted <= 1` 확인
12. `levelEffective` 계산
13. 기존 활성 snapshot과 동일 입력인지 비교
14. 필요 시 새 snapshot version 생성 후 트랜잭션으로 active 교체

---

## 등록 성공 응답

### 1. 새 스냅샷 생성됨

`200 OK`

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "changed": true,
  "party": {
    "snapshotId": "ops_gen4_000124",
    "snapshotVersion": 4,
    "status": "active",
    "registeredAt": "2026-04-11T06:15:05Z",
    "sourceStateHash": "sha256:0bb1...",
    "sourceConfigHash": "sha256:17cc...",
    "validationStatus": "accepted",
    "partySummary": {
      "memberCount": 6,
      "legendaryMythicalCount": 2,
      "restrictedCount": 1,
      "speciesDupClause": true
    },
    "members": [
      {
        "slot": 1,
        "pokemonInstanceId": "pkm_8f0d2f7a",
        "speciesId": "483",
        "nickname": "Dialga",
        "levelActual": 72,
        "levelEffective": 54,
        "specialClass": {
          "legendary": true,
          "mythical": false,
          "restricted": true
        },
        "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
      }
    ]
  }
}
```

### 2. 입력은 같고 변경 없음

`200 OK`

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "changed": false,
  "party": {
    "snapshotId": "ops_gen4_000124",
    "snapshotVersion": 4,
    "status": "active",
    "registeredAt": "2026-04-11T06:15:05Z",
    "validationStatus": "accepted"
  }
}
```

### 멱등성 원칙

- 같은 정규화 결과와 같은 source hash로 재등록하면 `changed: false`를 반환할 수 있다.
- 다른 입력이면 반드시 새 `snapshotVersion`을 발급한다.
- 초기 버전은 히스토리 보존을 위해 **update in place보다 append + active 전환**을 권장한다.

---

## 등록 실패 계약

### 대표 에러 코드

| HTTP | code | 설명 |
|---|---|---|
| 400 | `PVP_INVALID_REQUEST` | JSON shape 자체가 잘못됨 |
| 401 | `PVP_UNAUTHORIZED` | 인증 실패 |
| 403 | `PVP_CHEAT_CONTAMINATED_SAVE` | 치트 오염 저장이라 온라인 등록 불가 |
| 404 | `PVP_RULESET_NOT_FOUND` | 세대 ruleset 없음 |
| 409 | `PVP_SOURCE_HASH_STALE` | 클라이언트가 기준으로 삼은 로컬 상태가 이미 바뀌었음 |
| 409 | `PVP_RULESET_CHANGED` | 등록 도중 서버 ruleset이 바뀌어 재확인 필요 |
| 422 | `PVP_PARTY_SIZE_INVALID` | 6마리 조건 위반 |
| 422 | `PVP_PARTY_SLOT_DUPLICATED` | slot 중복 |
| 422 | `PVP_SPECIES_DUPLICATE` | 동일 종 중복 |
| 422 | `PVP_SPECIAL_LIMIT_EXCEEDED` | legendary + mythical 총량 초과 |
| 422 | `PVP_RESTRICTED_LIMIT_EXCEEDED` | restricted 초과 |
| 422 | `PVP_MEMBER_NOT_OWNED` | 해당 개체가 로컬 스냅샷에 존재하지 않음 |
| 422 | `PVP_MEMBER_STATE_MISMATCH` | 레벨/기술/상태 hash가 증빙과 불일치 |
| 422 | `PVP_MOVESET_INVALID` | 기술 조합이 세대 또는 정책에 맞지 않음 |
| 422 | `PVP_GROWTH_PROOF_INVALID` | growth proof 자체가 불완전하거나 버전 미지원 |

### 필드 오류 예시

```json
{
  "error": {
    "code": "PVP_RESTRICTED_LIMIT_EXCEEDED",
    "message": "Restricted Pokémon limit exceeded.",
    "retryable": false,
    "details": {
      "generation": "gen4",
      "restrictedLimit": 1,
      "restrictedDetected": 2,
      "speciesIds": ["483", "484"]
    }
  }
}
```

---

## 서버 저장 계약

이 요청이 성공하면 서버는 최소한 다음을 저장한다.

- `online_party_snapshots`
  - `snapshot_id`
  - `player_id`
  - `generation`
  - `ruleset_key`
  - `snapshot_version`
  - `is_active`
  - `source_state_hash`
  - `source_config_hash`
  - `growth_proof_json`
  - `validation_status`
- `online_party_members`
  - `snapshot_id`
  - `slot_index`
  - `pokemon_instance_id`
  - `species_id`
  - `level_actual`
  - `level_effective`
  - `special_tags_json`
  - `moves_json`

즉, 배틀 시작 이후에는 로컬 저장을 다시 보지 않고도 서버 스냅샷만으로 전투 진입이 가능해야 한다.

---

## 클라이언트 구현 메모

### 등록 화면 진입 전
1. 먼저 `GET /rulesets/{generation}` 호출
2. 해당 ruleset으로 제한/설명 문구 렌더링
3. 현재 등록 상태를 `GET /parties/{generation}/active`로 확인

### 등록 시
1. 로컬 저장에서 후보 6마리 선택
2. `sourceStateHash`, `growthProof` 생성
3. `PUT /active` 호출
4. 성공 시 서버 반환 snapshot을 로컬 UI 기준 상태로 채택

### 실패 시 UX
- `404 PVP_ACTIVE_PARTY_NOT_FOUND`: “아직 온라인 파티가 등록되지 않았어요.”
- `403 PVP_CHEAT_CONTAMINATED_SAVE`: “치트 사용 이력이 있는 저장은 온라인에 등록할 수 없어요.”
- `422 PVP_SPECIES_DUPLICATE`: “같은 종의 포켓몬은 중복 등록할 수 없어요.”
- `422 PVP_SPECIAL_LIMIT_EXCEEDED`: “전설/환상은 총 2마리까지만 등록할 수 있어요.”
- `422 PVP_RESTRICTED_LIMIT_EXCEEDED`: “최상위 restricted 포켓몬은 1마리까지만 등록할 수 있어요.”

---

## Phase 1 결론

초기 PvP에서 중요한 것은 “내 로컬 파티를 그대로 믿고 즉석에서 싸우게 하는 것”이 아니다.  
더 중요한 것은 다음 두 가지다.

1. **서버가 온라인에 쓸 파티를 사전에 승인한다.**
2. **승인된 스냅샷만 다음 단계(룸/배틀)에서 사용한다.**

이 계약을 먼저 단단히 해 두면, 이후 룸 생성/참가와 실시간 배틀은 모두 이 스냅샷 식별자를 기준으로 안정적으로 연결할 수 있다.

## 다음 문서

- [API 계약 초안](../api-contract.md)
- [친구전 룸 / 매치 성립 상세 계약](./room-and-match.md)
- [실시간 배틀 흐름](../battle-flow.md)
- [PvP 작업 분해 / TODO](../../implementation/todo-breakdown.md)
