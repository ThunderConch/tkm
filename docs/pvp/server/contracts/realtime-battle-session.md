# 실시간 배틀 세션 상세 계약

상위 문서: [PvP 서버 Contracts 문서](./README.md)  
관련 문서: [API 계약 초안](../api-contract.md), [친구전 룸 / 매치 성립 상세 계약](./room-and-match.md), [실시간 배틀 흐름](../battle-flow.md), [치트 대응 정책](../../security/anti-cheat.md)

## 목적

이 문서는 초기 PvP의 **Phase 3 계약**을 상세화한다.  
범위는 다음 두 가지다.

1. `GET /ws/pvp?roomId=<roomId>&token=<token>` 연결 규칙
2. WebSocket 상에서 오가는 배틀 명령 / 이벤트 상세 계약

즉, “클라이언트는 무엇을 보낼 수 있고, 서버는 어떤 공개 상태만 내려주며, 턴제 전투를 어떻게 실시간 세션으로 운영하는가”를 세밀하게 정의한다.

---

## 범위 밖

이 문서는 아직 아래를 다루지 않는다.

- damage formula 내부 수학식 전체
- spectator / replay 스트림
- 래더 매치메이킹
- 음성/채팅/이모트
- 배틀 종료 후 보상 분배

---

## 계약 원칙

### 1. 클라이언트는 명령만 보내고 결과는 계산하지 않는다
클라이언트는 `choose_move`, `choose_switch`, `choose_replacement`, `forfeit` 같은 **의도(intent)** 만 보낸다.  
명중, 우선순위, 속도, 대미지, 상태 변화, 승패는 모두 서버가 계산한다.

### 2. 서버 이벤트는 플레이어별 투영 결과다
동일 턴이라도 각 플레이어가 보는 payload는 달라질 수 있다.  
특히 상대 백라인, 숨은 기술 세부, 비공개 상태는 조기 공개하지 않는다.

### 3. 배틀 시작 시 선발은 자동 고정이다
초기 버전은 팀 프리뷰가 없고, 각자 **등록 파티 1번 슬롯이 자동 선발**이다.

### 4. 턴 요청과 교체 요청은 별도 phase다
일반 턴의 선택 요청과, 기절 후 replacement 요청은 서버 상태상 서로 다른 phase로 분리한다.

### 5. 재접속은 “현재 공개 상태 복구” 기준으로 처리한다
클라이언트가 끊겼다가 돌아오더라도, 서버는 **가장 최신 authoritative 공개 상태**를 다시 내려준다. 클라이언트 로컬 계산 복원에 의존하지 않는다.

---

## 세션 상태 머신

```text
awaiting_presence
  -> starting
  -> awaiting_actions
  -> resolving_turn
  -> awaiting_replacement
  -> resolving_turn
  -> finished
  -> abandoned
```

### 상태 의미

| 상태 | 의미 |
|---|---|
| `awaiting_presence` | 양측 WebSocket 접속 대기 |
| `starting` | battle start snapshot / seed / request 생성 중 |
| `awaiting_actions` | 일반 턴 명령 입력 대기 |
| `resolving_turn` | 서버 계산 중 |
| `awaiting_replacement` | 기절한 측의 교체 선택 대기 |
| `finished` | 승패 확정 |
| `abandoned` | 재접속 실패 등으로 운영상 중단 |

---

## 연결 규칙

## `GET /ws/pvp?roomId=<roomId>&token=<token>`

### 핸드셰이크 검증 순서

1. 토큰 인증
2. `roomId` 존재 여부 확인
3. 사용자가 room host/guest 중 하나인지 확인
4. 룸 상태가 `awaiting_presence`, `starting`, `in_progress` 계열인지 확인
5. 현재 seat의 기존 연결이 있으면 새 연결로 세션 교체 또는 중복 거부 정책 적용
6. seat presence를 `connected`로 반영
7. 서버가 `room.snapshot`을 즉시 전송

### 연결 거부 대표 코드

- `PVP_WS_UNAUTHORIZED`
- `PVP_ROOM_NOT_FOUND`
- `PVP_ROOM_ACCESS_DENIED`
- `PVP_ROOM_NOT_JOINABLE`
- `PVP_WS_DUPLICATE_CONNECTION`

---

## 공통 메시지 envelope

클라이언트/서버 메시지는 모두 최소한 아래 envelope를 따른다.

```json
{
  "type": "battle.request_action",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 14,
  "sentAt": "2026-04-11T07:15:10.123Z",
  "payload": {}
}
```

### 공통 필드

| 필드 | 설명 |
|---|---|
| `type` | 이벤트/명령 타입 |
| `roomId` | 룸 식별자 |
| `battleId` | 배틀 식별자 |
| `seq` | 서버 또는 클라이언트 발신 순서 식별자 |
| `sentAt` | 서버/클라이언트 발신 시간 |
| `payload` | 타입별 본문 |

### 순서 원칙

- 서버 이벤트 `seq`는 같은 배틀 안에서 단조 증가해야 한다.
- 클라이언트 명령은 `clientCommandId`를 추가해 중복 제출 감지를 가능하게 한다.

---

## 클라이언트 -> 서버 명령 계약

## `battle.command`

```json
{
  "type": "battle.command",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 5,
  "sentAt": "2026-04-11T07:15:08.001Z",
  "payload": {
    "clientCommandId": "cmd_01JZ6Y8W6M",
    "turn": 4,
    "phase": "awaiting_actions",
    "command": {
      "type": "choose_move",
      "moveSlot": 2
    }
  }
}
```

### 공통 규칙

| 필드 | 규칙 |
|---|---|
| `clientCommandId` | 클라이언트가 생성하는 멱등 키 |
| `turn` | 현재 요청 턴과 일치해야 함 |
| `phase` | `awaiting_actions` 또는 `awaiting_replacement` |
| `command.type` | 허용 타입 중 하나여야 함 |

### 허용 command type

#### 1. `choose_move`

```json
{
  "type": "choose_move",
  "moveSlot": 2
}
```

- 현재 active Pokémon이 보유한 기술 슬롯이어야 함
- PP 0, 봉인, 상태상 사용 불가면 거부 가능

#### 2. `choose_switch`

```json
{
  "type": "choose_switch",
  "targetSlot": 4
}
```

- 살아 있는 백라인이어야 함
- 현재 교체 불가 상태면 거부 가능

#### 3. `choose_replacement`

```json
{
  "type": "choose_replacement",
  "targetSlot": 5
}
```

- 기절 직후 replacement phase에서만 허용
- 이미 쓰러졌거나 현재 필드 위인 slot은 불가

#### 4. `forfeit`

```json
{
  "type": "forfeit"
}
```

- 언제든 허용 가능하지만, 이미 종료된 배틀이면 무시/거부

---

## 서버 -> 클라이언트 이벤트 계약

## 1. `room.snapshot`

최초 접속 또는 재접속 시 현재 공개 상태 전체를 내려준다.

```json
{
  "type": "room.snapshot",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 1,
  "sentAt": "2026-04-11T07:15:00.000Z",
  "payload": {
    "roomStatus": "starting",
    "battleStatus": "awaiting_actions",
    "generation": "gen4",
    "rulesetKey": "tkm-friendly-gen4-v1",
    "yourSeat": "host",
    "turn": 1,
    "visibleState": {
      "self": {
        "active": {
          "slot": 1,
          "speciesId": "006",
          "nickname": "Blaze",
          "levelActual": 63,
          "levelEffective": 56,
          "hp": 158,
          "hpMax": 158,
          "status": null,
          "moves": [
            { "slot": 1, "id": "flamethrower", "disabled": false },
            { "slot": 2, "id": "slash", "disabled": false }
          ]
        },
        "bench": [
          { "slot": 2, "speciesId": "143", "fainted": false },
          { "slot": 3, "speciesId": "130", "fainted": false }
        ]
      },
      "opponent": {
        "active": {
          "speciesId": "483",
          "nickname": "Dialga",
          "levelActual": 72,
          "levelEffective": 54,
          "hpKnown": true,
          "hp": 174,
          "hpMax": 174,
          "status": null
        },
        "benchCount": 5
      }
    },
    "pendingRequest": {
      "kind": "choose_move_or_switch",
      "deadlineMs": 45000
    }
  }
}
```

### 공개 원칙

- 상대 bench는 `benchCount`만 공개한다.
- 상대 active의 기술 목록은 공개하지 않는다.
- 상대의 실제/유효 레벨 공개 여부는 ruleset 정책에 따르되, 초기 설계에서는 visible 상태로 둔다.

---

## 2. `battle.request_action`

서버가 일반 턴 선택을 요구할 때 보낸다.

```json
{
  "type": "battle.request_action",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 8,
  "sentAt": "2026-04-11T07:15:40.000Z",
  "payload": {
    "turn": 4,
    "phase": "awaiting_actions",
    "requestId": "req_turn4_host",
    "deadlineMs": 45000,
    "request": {
      "kind": "choose_move_or_switch",
      "activePokemon": {
        "slot": 1,
        "speciesId": "006",
        "hp": 121,
        "hpMax": 158,
        "status": null
      },
      "availableMoves": [
        { "slot": 1, "id": "flamethrower", "disabled": false },
        { "slot": 2, "id": "slash", "disabled": false }
      ],
      "availableSwitches": [
        { "slot": 3, "speciesId": "143", "fainted": false }
      ]
    }
  }
}
```

### 규칙

- 같은 턴이라도 양 플레이어의 request payload는 다를 수 있다.
- `availableSwitches`는 실제 가능한 교체 후보만 포함한다.
- 서버는 request 발송 시점부터 timeout을 계산한다.

---

## 3. `battle.command_accepted`

서버가 명령을 수락했음을 알린다.

```json
{
  "type": "battle.command_accepted",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 9,
  "sentAt": "2026-04-11T07:15:43.000Z",
  "payload": {
    "clientCommandId": "cmd_01JZ6Y8W6M",
    "turn": 4,
    "phase": "awaiting_actions",
    "lockedIn": true
  }
}
```

### 목적

- 사용자가 이미 입력을 끝냈다는 것을 UX에 반영한다.
- 중복 클릭 / 중복 전송을 시각적으로 막는다.

---

## 4. `battle.command_rejected`

명령이 현재 상태와 맞지 않을 때 보낸다.

```json
{
  "type": "battle.command_rejected",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 10,
  "sentAt": "2026-04-11T07:15:43.200Z",
  "payload": {
    "clientCommandId": "cmd_01JZ6Y8W6M",
    "code": "PVP_COMMAND_PHASE_MISMATCH",
    "message": "This command is not valid for the current phase.",
    "retryable": true
  }
}
```

### 대표 거부 코드

- `PVP_COMMAND_PHASE_MISMATCH`
- `PVP_COMMAND_TURN_MISMATCH`
- `PVP_COMMAND_DUPLICATE`
- `PVP_COMMAND_MOVE_INVALID`
- `PVP_COMMAND_SWITCH_INVALID`
- `PVP_COMMAND_REPLACEMENT_INVALID`
- `PVP_COMMAND_TIMEOUT`

---

## 5. `battle.turn_resolved`

서버가 해당 턴 결과를 공개 가능한 이벤트 묶음으로 내려준다.

```json
{
  "type": "battle.turn_resolved",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 12,
  "sentAt": "2026-04-11T07:15:48.000Z",
  "payload": {
    "turn": 4,
    "events": [
      {
        "eventType": "move_used",
        "actor": "self",
        "speciesId": "006",
        "moveId": "flamethrower"
      },
      {
        "eventType": "damage_applied",
        "target": "opponent_active",
        "hp": 91,
        "hpMax": 174
      },
      {
        "eventType": "status_applied",
        "target": "opponent_active",
        "status": "burn"
      }
    ],
    "postTurnVisibleState": {
      "self": {
        "active": { "slot": 1, "speciesId": "006", "hp": 121, "hpMax": 158, "status": null },
        "bench": [
          { "slot": 3, "speciesId": "143", "fainted": false }
        ]
      },
      "opponent": {
        "active": { "speciesId": "483", "hp": 91, "hpMax": 174, "status": "burn" },
        "benchCount": 5
      }
    },
    "nextPhase": "awaiting_actions"
  }
}
```

### 설계 포인트

- `events`는 연출/로그용이다.
- 클라이언트는 `events`를 재생하되, 최종 상태는 항상 `postTurnVisibleState`를 authoritative하게 본다.
- 상대에게 보이면 안 되는 정보는 `events`에서도 누출하지 않는다.

---

## 6. `battle.force_replacement`

기절한 플레이어에게 다음 포켓몬 선택을 요구한다.

```json
{
  "type": "battle.force_replacement",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 13,
  "sentAt": "2026-04-11T07:15:48.300Z",
  "payload": {
    "turn": 4,
    "phase": "awaiting_replacement",
    "requestId": "req_replace_turn4_guest",
    "deadlineMs": 45000,
    "faintedSlot": 1,
    "availableReplacements": [
      { "slot": 2, "speciesId": "445", "fainted": false },
      { "slot": 6, "speciesId": "248", "fainted": false }
    ]
  }
}
```

### 규칙

- 이 이벤트는 필요한 플레이어에게만 전송된다.
- 반대편 플레이어에게는 “상대가 다음 포켓몬을 선택 중” 정도의 대기 상태만 보여주면 된다.

---

## 7. `battle.ended`

```json
{
  "type": "battle.ended",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 27,
  "sentAt": "2026-04-11T07:20:10.000Z",
  "payload": {
    "result": "win",
    "reason": "all_opponent_pokemon_fainted",
    "finalVisibleState": {
      "self": {
        "remainingCount": 2
      },
      "opponent": {
        "remainingCount": 0
      }
    }
  }
}
```

### 종료 사유 예시

- `all_opponent_pokemon_fainted`
- `forfeit`
- `timeout_forfeit`
- `admin_cancelled`
- `connection_abandoned`

---

## 타임아웃 정책

### 기본 원칙

- 일반 턴과 replacement phase 모두 timeout을 가진다.
- 친선전 초기 버전은 지나치게 가혹하지 않게, **실격보다는 서버 대체 행동**을 우선 검토할 수 있다.
- 다만 악용을 줄이기 위해 phase별 정책을 분리한다.

### 추천 초기 정책

| phase | timeout 시 처리 |
|---|---|
| `awaiting_actions` | 기본 기술 자동 선택 시도, 불가하면 랜덤 유효 기술 |
| `awaiting_replacement` | 랜덤 유효 replacement 선택 |
| 연속 timeout 누적 | 누적 기준 초과 시 패배 처리 가능 |

### 왜 바로 실격이 아닌가

- 인게임 감성에 더 맞는다.
- 친선전 UX가 덜 거칠다.
- 네트워크 불안정에 덜 취약하다.

단, 반복 악용 방지를 위해 timeout count는 서버가 별도 추적해야 한다.

---

## 재접속 계약

### 규칙

1. 클라이언트 재접속 시 서버는 즉시 최신 `room.snapshot`을 다시 보낸다.
2. 아직 내 요청 phase가 살아 있으면, snapshot 안에 `pendingRequest`를 포함한다.
3. 이미 제출한 명령이 있다면 `commandSubmitted: true` 같은 상태를 snapshot에 포함할 수 있다.
4. 재접속 직후 과거 이벤트를 전부 재생할 필요는 없고, 최신 공개 상태가 우선이다.

### 최소 재접속 snapshot 예시

```json
{
  "type": "room.snapshot",
  "roomId": "room_01JZ6Y4P4R",
  "battleId": "battle_01JZ6Y8MK2",
  "seq": 21,
  "sentAt": "2026-04-11T07:18:00.000Z",
  "payload": {
    "roomStatus": "in_progress",
    "battleStatus": "awaiting_actions",
    "yourSeat": "guest",
    "turn": 6,
    "visibleState": {
      "self": {
        "active": { "slot": 2, "speciesId": "445", "hp": 77, "hpMax": 161, "status": null },
        "bench": [
          { "slot": 6, "speciesId": "248", "fainted": false }
        ]
      },
      "opponent": {
        "active": { "speciesId": "006", "hp": 42, "hpMax": 158, "status": "burn" },
        "benchCount": 1
      }
    },
    "pendingRequest": {
      "kind": "choose_move_or_switch",
      "deadlineMs": 17000,
      "commandSubmitted": false
    }
  }
}
```

---

## 서버 저장 계약

최소한 아래는 저장 가능하거나 재구성 가능해야 한다.

- battle summary (`battleId`, roomId, generation, rulesetKey)
- authoritative turn index / phase
- player command log (`clientCommandId`, accepted/rejected result)
- visible/public event stream
- private event stream 또는 private derivation source
- timeout counters
- final result / reason

### 무결성 원칙

- 같은 `clientCommandId`는 같은 seat + turn + phase 내에서 한 번만 수락 가능
- `turn_resolved` 이후 이전 turn 명령은 절대 수락 불가
- `finished` 이후 모든 명령은 거부 또는 무시

---

## 클라이언트 구현 메모

### 전투 중

- 클라이언트는 로컬 전투 계산을 하지 않는다.
- `events`는 연출용으로 사용하되, 최종 상태는 `postTurnVisibleState`를 신뢰한다.
- 명령 제출 후에는 입력 UI를 잠그고 `battle.command_accepted`를 기다린다.

### 교체 phase

- 일반 턴과 다른 화면/프롬프트로 다루는 편이 안전하다.
- 선택 가능한 교체 후보만 보여준다.

### 재접속 시

- “다시 연결됨, 현재 턴 상태 동기화 완료” 같은 메시지를 보여준다.
- 끊기기 전 로컬 애니메이션 상태는 버리고 snapshot 기준으로 다시 그린다.

---

## Phase 3 결론

초기 PvP의 실시간성은 “액션 게임식 프레임 동기화”가 아니라, **턴 요청과 authoritative 이벤트 스트림을 주고받는 실시간 세션**으로 구현하는 것이 맞다.  
서버는 명령 수집과 결과 계산을 전부 책임지고, 클라이언트는 오직 현재 자신에게 공개된 상태와 입력 가능 행동만 처리해야 한다.

---

## 다음 문서

- [실시간 배틀 흐름](../battle-flow.md)
- [치트 대응 정책](../../security/anti-cheat.md)
- [서버 아키텍처](../architecture.md)
