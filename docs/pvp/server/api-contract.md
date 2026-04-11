# PvP HTTP / WebSocket API 계약 초안

상위 문서: [PvP 문서 인덱스](../README.md)  
관련 문서: [서버 아키텍처](./architecture.md), [서버 데이터 모델](./storage/data-model.md), [온라인 파티 등록 상세 계약](./contracts/party-registration.md), [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md), [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md), [실시간 배틀 흐름](./battle-flow.md), [치트 대응 정책](../security/anti-cheat.md)

## 목표

이 문서는 초기 친선 PvP 구현을 위한 **최소 API 계약**을 정의한다.  
핵심 원칙은 “REST로 준비하고, WebSocket으로 싸운다”이다.

---

## HTTP API

### 1. 현재 ruleset 조회

`GET /api/pvp/rulesets/{generation}`

응답 예시:

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "partySize": 6,
  "teamPreview": false,
  "speciesDupClause": true,
  "legendaryMythicalLimit": 2,
  "restrictedLimit": 1,
  "effectiveLevelCap": 60,
  "levelCompression": "soft-cap-after-50"
}
```

### 2. 세대별 활성 등록 파티 조회

`GET /api/pvp/parties/{generation}/active`

### 3. 세대별 온라인 파티 등록/갱신

`PUT /api/pvp/parties/{generation}/active`

상세 계약은 [온라인 파티 등록 상세 계약](./contracts/party-registration.md)을 따른다.

요청 예시:

```json
{
  "members": [
    {
      "slot": 1,
      "speciesId": "483",
      "nickname": "Dialga",
      "levelActual": 72,
      "moves": ["dragon-claw", "flash-cannon", "rest", "roar-of-time"]
    }
  ],
  "sourceStateHash": "sha256:..."
}
```

서버 검증 항목:

- 종 중복 여부
- 마릿수 규칙
- legendary/mythical 총량 제한
- restricted 제한
- 레벨 정책 계산 가능 여부
- 치트 오염 상태 여부

### 4. 친구전 룸 생성

`POST /api/pvp/rooms`

상세 계약은 [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)을 따른다.

요청 예시:

```json
{
  "generation": "gen4",
  "rulesetKey": "tkm-friendly-gen4-v1",
  "visibility": "private_friend"
}
```

응답 예시:

```json
{
  "roomId": "room_123",
  "roomCode": "A7KQ2M",
  "status": "waiting_for_opponent"
}
```

### 5. 룸 참가

`POST /api/pvp/rooms/{roomId}/join`

상세 계약은 [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)을 따른다.

요청 예시:

```json
{
  "roomCode": "A7KQ2M",
  "generation": "gen4"
}
```

### 6. 룸 상태 조회

`GET /api/pvp/rooms/{roomId}`

상세 계약은 [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)을 따른다.

재접속 시 초기 동기화에 사용한다.

---

## WebSocket 연결

### 연결

`GET /ws/pvp?roomId=<roomId>&token=<token>`

상세 계약은 [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)을 따른다.

클라이언트는 룸 입장 완료 후 WebSocket을 연결한다.

### 클라이언트 -> 서버 메시지

#### `battle.command`

```json
{
  "type": "battle.command",
  "roomId": "room_123",
  "turn": 4,
  "command": {
    "type": "choose_move",
    "moveSlot": 2
  }
}
```

가능한 command type:

- `choose_move`
- `choose_switch`
- `choose_replacement`
- `forfeit`

### 서버 -> 클라이언트 메시지

#### `room.snapshot`

재접속/최초 진입 시 현재 공개 상태를 내려준다.

#### `battle.request_action`

플레이어에게 행동을 요구한다.

```json
{
  "type": "battle.request_action",
  "roomId": "room_123",
  "turn": 4,
  "deadlineMs": 45000,
  "request": {
    "kind": "choose_move_or_switch",
    "activePokemon": { "speciesId": "006", "hp": 121 },
    "availableMoves": [
      { "slot": 1, "id": "flamethrower" },
      { "slot": 2, "id": "slash" }
    ],
    "availableSwitches": [
      { "slot": 3, "speciesId": "143" }
    ]
  }
}
```

#### `battle.command_accepted`

서버가 명령을 수락했음을 알린다.

#### `battle.turn_resolved`

해당 턴의 결과 이벤트 묶음을 내려준다.

#### `battle.force_replacement`

포켓몬 기절 후 다음 포켓몬 선택을 요구한다.

#### `battle.ended`

승패와 종료 사유를 알려준다.

---

## 에러 원칙

HTTP와 WebSocket 모두 다음 종류의 에러를 분리하는 것이 좋다.

- 인증 실패
- ruleset 불일치
- 파티 미등록
- 파티 검증 실패
- 이미 명령 제출됨
- 현재 행동 가능 상태 아님
- 타이머 만료
- 룸 상태 불일치

## 숨은 정보 원칙

상대 백라인, 상대의 비공개 상세 상태 등은 서버가 보내지 않는다.  
따라서 `room.snapshot`과 `battle.turn_resolved`는 **플레이어별 투영 결과**여야 한다.

## 초기 API 결론

- 등록/룸 관리는 HTTP
- 실시간 턴 처리는 WebSocket
- 클라이언트는 명령만 보냄
- 서버는 플레이어별 가시 정보만 내려줌

## 다음 문서

- [온라인 파티 등록 상세 계약](./contracts/party-registration.md)
- [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)
- [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)
- [실시간 배틀 흐름](./battle-flow.md)
- [치트 대응 정책](../security/anti-cheat.md)
