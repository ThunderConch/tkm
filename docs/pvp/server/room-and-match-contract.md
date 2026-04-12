# 친구전 룸 / 매치 성립 상세 계약

상위 문서: [PvP 서버 설계 문서](./README.md)
관련 문서: [API 계약 초안](./api-contract.md), [온라인 파티 등록 상세 계약](./party-registration-contract.md), [실시간 배틀 세션 상세 계약](./realtime-battle-session-contract.md), [실시간 배틀 흐름](./battle-flow.md), [치트 대응 정책](../security/anti-cheat.md)

## 목적

이 문서는 초기 PvP의 **Phase 2 계약**을 상세화한다.
범위는 다음 세 가지다.

1. `POST /api/pvp/rooms`
2. `POST /api/pvp/rooms/{roomId}/join`
3. `GET /api/pvp/rooms/{roomId}`

즉, “두 플레이어가 어떤 generation / ruleset / party snapshot으로 실제 대전을 시작하게 되는가”를 서버 기준으로 확정하는 계약이다.

---

## 범위 밖

이 문서는 아직 아래를 다루지 않는다.

- WebSocket 세션 수립 세부 핸드셰이크
- 턴별 명령 payload 상세
- 대미지 계산 / 판정 로직
- 래더 / 매치메이킹 큐
- spectator / replay export

---

## 계약 원칙

### 1. 룸은 배틀 전 staging area 다
룸은 단순 채팅방이 아니라, **배틀 시작 전에 generation / ruleset / party snapshot / player binding을 고정하는 준비 공간**이다.

### 2. 룸 생성 시점과 참가 시점 모두 서버가 재검증한다
호스트가 룸을 만들 때도, 상대가 참가할 때도 서버는 활성 파티 snapshot과 ruleset 일치를 다시 확인한다.

### 3. 매치 성립 후에는 파티 스냅샷이 배틀 단위로 고정된다
활성 파티는 재등록될 수 있지만, **이미 성립한 룸/배틀이 참조하는 snapshot**은 바뀌지 않는다.

### 4. 친선전 초기 버전에는 별도 ready 버튼 없이 곧바로 시작 준비로 넘어간다
사용자 경험은 “친구 코드 입력 → 붙으면 바로 배틀 진입”에 가깝게 간다.
따라서 별도 `ready` API는 두지 않고, 서버가 참가 성공 시 **match readiness**를 계산한다.

### 5. 상대 백라인 공개는 룸 단계에서도 금지한다
룸 상태 조회는 상대 존재 여부, generation, ruleset, 연결 상태 정도만 보여주며, **상대 파티 상세나 엔트리 리스트는 공개하지 않는다.**

---

## 공통 전송 규칙

- 프로토콜: HTTPS + JSON
- 인증: `Authorization: Bearer <token>` 가정
- room 식별자는 서버 발급 `roomId`와 사용자 공유용 `roomCode`를 분리한다.
- `roomCode`는 짧고 사람이 입력 가능한 문자열이지만, 내부 참조는 항상 `roomId`를 기준으로 한다.
- 모든 성공 응답은 최소한 `roomId`, `status`, `generation`, `rulesetKey`를 포함한다.
- 룸 상태 응답은 **플레이어별 투영(view)** 이다. 같은 룸이라도 조회자에 따라 `you`, `opponent` 블록 내용이 일부 다를 수 있다.

### 공통 에러 envelope

```json
{
  "error": {
    "code": "PVP_ROOM_RULESET_MISMATCH",
    "message": "Active party ruleset does not match the room ruleset.",
    "retryable": false,
    "details": {
      "roomId": "room_01JZ6Y4P4R",
      "generation": "gen4"
    }
  }
}
```

---

## 룸 상태 머신

```text
waiting_for_opponent
  -> awaiting_presence
  -> starting
  -> in_progress
  -> finished
  -> cancelled
```

### 상태 의미

| 상태 | 의미 |
|---|---|
| `waiting_for_opponent` | 호스트만 존재, 상대 미참가 |
| `awaiting_presence` | 양 플레이어 binding 완료, WebSocket 진입 대기 |
| `starting` | 서버가 battle seed / player order / visible snapshot 생성 중 |
| `in_progress` | 배틀 진행 중 |
| `finished` | 배틀 종료 |
| `cancelled` | 시작 전 만료/취소 |

---

## 공유 객체 계약

## RoomSummary

```json
{
  "roomId": "room_01JZ6Y4P4R",
  "roomCode": "A7KQ2M",
  "mode": "friendly_private",
  "status": "waiting_for_opponent",
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "createdByUserId": "user_host",
  "createdAt": "2026-04-11T07:10:00Z",
  "expiresAt": "2026-04-11T07:25:00Z"
}
```

### 의미

- `mode`: 초기 버전은 `friendly_private` 고정이다.
- `expiresAt`: 상대가 끝내 참가하지 않을 경우 룸을 자동 정리하기 위한 TTL이다.

---

## RoomPlayerBinding

```json
{
  "seat": "host",
  "userId": "user_host",
  "partySnapshotId": "ops_gen4_000123",
  "partySnapshotVersion": 3,
  "presence": "offline",
  "joinedAt": "2026-04-11T07:10:00Z",
  "battleReady": false
}
```

### 필드 규칙

| 필드 | 설명 |
|---|---|
| `seat` | `host` 또는 `guest` |
| `partySnapshotId` | 등록 계약에서 확정된 활성 온라인 파티 스냅샷 ID |
| `partySnapshotVersion` | 스냅샷 버전. 재등록과 구분하기 위해 저장 |
| `presence` | `offline`, `connected`, `disconnected` |
| `battleReady` | 현재 룸 기준 배틀 시작 가능성 |

---

## RoomView

`GET /rooms/{roomId}`가 반환하는 조회자 기준 룸 상태다.

```json
{
  "room": {
    "roomId": "room_01JZ6Y4P4R",
    "roomCode": "A7KQ2M",
    "mode": "friendly_private",
    "status": "awaiting_presence",
    "generation": "gen4",
    "rulesetKey": "tkm-friendly-gen4-v1",
    "createdAt": "2026-04-11T07:10:00Z",
    "expiresAt": null
  },
  "you": {
    "seat": "host",
    "partySnapshotId": "ops_gen4_000123",
    "partyValidationStatus": "accepted",
    "presence": "connected",
    "battleReady": true
  },
  "opponent": {
    "seat": "guest",
    "presence": "offline",
    "battleReady": true,
    "displayName": "Trainer B"
  },
  "match": {
    "freezeStatus": "pending_presence",
    "battleId": null,
    "battleStartedAt": null
  }
}
```

### 공개 원칙

- `opponent`에는 display name, presence, battleReady 정도만 내려간다.
- 상대의 `partySnapshotId`는 초기 버전에서는 **비공개**로 둘 수 있다. 디버깅 편의보다 정보 노출 최소화가 우선이다.
- `freezeStatus`는 서버가 battle start freeze를 끝냈는지 설명한다.

---

## Endpoint 1. 룸 생성

## `POST /api/pvp/rooms`

### 요청

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "visibility": "private_friend"
}
```

### 요청 규칙

| 필드 | 규칙 |
|---|---|
| `generation` | 필수. host의 활성 파티 snapshot generation과 일치해야 함 |
| `rulesetKey` | 선택적이지만, 보내면 현재 서버 active ruleset과 일치해야 함 |
| `visibility` | 초기 버전은 `private_friend`만 허용 |

### 서버 검증 순서

1. 인증된 사용자 확인
2. `generation` 지원 여부 확인
3. 해당 generation의 현재 active ruleset 조회
4. 요청 `rulesetKey`가 있으면 active ruleset과 일치하는지 확인
5. host의 활성 온라인 파티 snapshot 존재 여부 확인
6. snapshot의 `validationStatus == accepted` 확인
7. 이미 진행 중인 친선 룸/배틀에 묶여 있는지 확인
8. 새 `roomId`, `roomCode`, TTL 생성
9. host seat binding 저장

### 성공 응답

```json
{
  "room": {
    "roomId": "room_01JZ6Y4P4R",
    "roomCode": "A7KQ2M",
    "mode": "friendly_private",
    "status": "waiting_for_opponent",
    "generation": "gen4",
    "rulesetKey": "tkm-friendly-gen4-v1",
    "createdAt": "2026-04-11T07:10:00Z",
    "expiresAt": "2026-04-11T07:25:00Z"
  },
  "you": {
    "seat": "host",
    "partySnapshotId": "ops_gen4_000123",
    "partyValidationStatus": "accepted",
    "presence": "offline",
    "battleReady": false
  },
  "opponent": null,
  "match": {
    "freezeStatus": "waiting_for_opponent",
    "battleId": null,
    "battleStartedAt": null
  }
}
```

### 대표 실패 코드

- `PVP_RULESET_NOT_FOUND`
- `PVP_PARTY_NOT_REGISTERED`
- `PVP_PARTY_NOT_ACTIVE`
- `PVP_RULESET_MISMATCH`
- `PVP_ROOM_ALREADY_BOUND`
- `PVP_ROOM_VISIBILITY_INVALID`

---

## Endpoint 2. 룸 참가

## `POST /api/pvp/rooms/{roomId}/join`

### 요청

```json
{
  "roomCode": "A7KQ2M",
  "generation": "gen4"
}
```

### 요청 규칙

| 필드 | 규칙 |
|---|---|
| `roomCode` | 필수. `roomId`와 매칭되어야 함 |
| `generation` | 필수. 룸 generation과 일치해야 함 |

### 서버 검증 순서

1. 인증된 사용자 확인
2. `roomId` 존재 여부 확인
3. 룸 상태가 `waiting_for_opponent`인지 확인
4. `roomCode` 일치 여부 확인
5. host와 guest가 동일 사용자 아닌지 확인
6. guest의 active online party snapshot 존재 여부 확인
7. guest snapshot generation / ruleset이 room과 일치하는지 확인
8. snapshot `validationStatus == accepted` 확인
9. guest binding 저장
10. 룸 상태를 `awaiting_presence`로 전이
11. battle freeze 준비 상태 계산

### 성공 응답

```json
{
  "room": {
    "roomId": "room_01JZ6Y4P4R",
    "roomCode": "A7KQ2M",
    "mode": "friendly_private",
    "status": "awaiting_presence",
    "generation": "gen4",
    "rulesetKey": "tkm-friendly-gen4-v1",
    "createdAt": "2026-04-11T07:10:00Z",
    "expiresAt": null
  },
  "you": {
    "seat": "guest",
    "partySnapshotId": "ops_gen4_000222",
    "partyValidationStatus": "accepted",
    "presence": "offline",
    "battleReady": true
  },
  "opponent": {
    "seat": "host",
    "presence": "offline",
    "battleReady": true,
    "displayName": "Trainer A"
  },
  "match": {
    "freezeStatus": "pending_presence",
    "battleId": null,
    "battleStartedAt": null
  }
}
```

### 대표 실패 코드

- `PVP_ROOM_NOT_FOUND`
- `PVP_ROOM_CODE_MISMATCH`
- `PVP_ROOM_ALREADY_FILLED`
- `PVP_ROOM_STATE_INVALID`
- `PVP_ROOM_SELF_JOIN_FORBIDDEN`
- `PVP_PARTY_NOT_REGISTERED`
- `PVP_ROOM_GENERATION_MISMATCH`
- `PVP_ROOM_RULESET_MISMATCH`
- `PVP_PARTY_VALIDATION_REJECTED`

---

## Endpoint 3. 룸 상태 조회

## `GET /api/pvp/rooms/{roomId}`

### 요청

Body 없음.

### 서버 검증 순서

1. 인증된 사용자 확인
2. `roomId` 존재 여부 확인
3. 요청 사용자가 host/guest 중 하나인지 확인
4. 룸 상태를 조회자 기준 projection으로 직렬화

### 성공 응답

응답 구조는 `RoomView`를 따른다.

### 대표 실패 코드

- `PVP_ROOM_NOT_FOUND`
- `PVP_ROOM_ACCESS_DENIED`

---

## Battle freeze 계약

룸이 `awaiting_presence`로 들어가면, 서버는 배틀 시작용 freeze를 아래 단위로 준비한다.

1. host party snapshot ID / version
2. guest party snapshot ID / version
3. room 생성 시점의 ruleset key
4. ruleset 정책 JSON hash
5. battle seed 생성용 엔트로피

### 왜 freeze가 필요한가

- 참가 직후 사용자가 활성 파티를 재등록해도, 이미 성립한 매치에는 영향이 없어야 한다.
- generation ruleset이 그 사이 교체되더라도, **이미 성립한 룸은 자기 ruleset key 기준으로 끝까지 진행**해야 한다.

### freeze 결과 객체 예시

```json
{
  "battleFreeze": {
    "generation": "gen4",
    "rulesetKey": "tkm-friendly-gen4-v1",
    "rulesetHash": "sha256:aa17...",
    "hostPartySnapshotId": "ops_gen4_000123",
    "guestPartySnapshotId": "ops_gen4_000222",
    "battleSeed": "bseed_01JZ6Y6A7A"
  }
}
```

---

## Presence 계약

친선전 초기 버전은 “코드 입력 후 바로 싸움” 감성을 유지하되, 실제 시작은 **양측 WebSocket presence**가 잡힌 뒤에만 허용한다.

### 규칙

- HTTP join 성공만으로 곧바로 `in_progress`가 되지는 않는다.
- host/guest 모두 실시간 세션에 연결되면 `awaiting_presence -> starting`으로 전이한다.
- 한쪽이 참가 직후 오래 연결하지 않으면 룸은 timeout 후 `cancelled`될 수 있다.

### presence timeout 예시 정책

| 항목 | 값 |
|---|---|
| opponent join 후 presence 대기 | 60초 |
| host 재연결 grace | 30초 |
| guest 재연결 grace | 30초 |

이 값은 정책화 가능한 상수이며, API 응답에는 필요 최소한만 노출한다.

---

## 룸 저장 계약

초기 버전에서 서버는 최소한 아래를 저장해야 한다.

- room summary
- room code hash 또는 원문(운영 정책에 따라)
- host/guest binding
- freeze metadata
- lifecycle timestamps (`createdAt`, `joinedAt`, `startedAt`, `finishedAt`, `cancelledAt`)
- cancel / finish reason

### 무결성 원칙

- host seat는 생성 시 1회만 설정 가능
- guest seat는 비어 있을 때 1회만 설정 가능
- `in_progress` 이후에는 seat binding 변경 불가
- `finished` / `cancelled` 룸은 재사용 불가

---

## 클라이언트 구현 메모

### 룸 생성 시

- 사용자는 먼저 generation을 고르고 룸을 만든다.
- 실패가 `PVP_PARTY_NOT_REGISTERED`면 곧바로 등록 화면으로 유도한다.
- 생성 성공 시 room code를 크게 보여준다.

### 룸 참가 시

- room code 입력 후 참가한다.
- 참가 실패가 ruleset / generation mismatch면 현재 활성 파티와 룸 조건이 안 맞는다는 메시지를 보여준다.
- 참가 성공 후에는 “상대와 연결 중...” 상태로 전환한다.

### 룸 조회 시

- 내 presence와 상대 presence를 분리 표시한다.
- 상대 파티 정보는 보여주지 않는다.

---

## Phase 2 결론

초기 친선 PvP에서 룸은 단순 입장 절차가 아니라, **배틀 직전의 server-authoritative 고정 지점**이다.
등록된 활성 파티와 ruleset을 룸에서 한 번 더 맞추고, 여기서 battle freeze를 만들어야 이후 실시간 배틀이 흔들리지 않는다.

---

## 다음 문서

- [실시간 배틀 세션 상세 계약](./realtime-battle-session-contract.md)
- [실시간 배틀 흐름](./battle-flow.md)
- [치트 대응 정책](../security/anti-cheat.md)
