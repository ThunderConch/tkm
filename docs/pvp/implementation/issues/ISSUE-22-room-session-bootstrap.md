# ISSUE-22 · room create/join + session bootstrap

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-21 · session terminal CLI bootstrap](./ISSUE-21-session-terminal-cli.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [친구전 룸 / 매치 성립 상세 계약](../../server/contracts/room-and-match.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

ISSUE-21에서 고정한 testable CLI bootstrap 경계 위에, 실제 온라인 PvP 진입에 필요한 **room create/join + session bootstrap domain** 을 추가한다.

이 단계에서는 raw stdin/readline, stdout repaint, process-global side effect를 직접 다루지 않는다. 대신 HTTP room API와 WebSocket session bootstrap을 작은 도메인 계층으로 묶어서, 상위 CLI/ battle-tui가 `create room` / `join room` / `connect live session` 흐름을 안정적으로 호출할 수 있게 하는 것이 목적이다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/room-http-client.ts`
- `src/pvp/session-bootstrap.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-room-http-client.test.ts`
- `test/pvp-session-bootstrap.test.ts`

## 핵심 책임

1. room create / join / get 호출을 담당하는 작은 HTTP client layer를 제공한다.
2. `Authorization` / JSON body / error envelope 처리를 client domain 안에서 일관되게 감싼다.
3. room 응답(`RoomView`)에서 live session 접속에 필요한 `roomId`를 안전하게 추출한다.
4. 상위 consumer가 room bootstrap 결과를 그대로 `PvpSessionClient`로 연결할 수 있게 한다.
5. bootstrap 단계에서 WebSocket URL 조립 로직을 다시 발명하지 않고, 기존 `createPvpSessionClient` / `createPvpWebSocketUrl` contract를 재사용한다.
6. 실제 CLI/battle-tui는 이후 이 contract 위에 room code 입력, stdin 루프, repaint policy만 얹으면 되게 만든다.

## 설계 메모

- room HTTP layer는 transport 세부 구현보다 **입력/출력 contract 고정**이 우선이다.
- create/join bootstrap은 `RoomView`를 받은 뒤 session client를 만드는 단계까지 포함하지만, 자동 connect 여부는 옵션으로 남긴다.
- client domain은 서버 route handler 구현을 직접 호출하지 않고, fetch-like interface를 통해 네트워크 경계를 유지한다.
- non-2xx 응답과 malformed payload는 typed error로 올려서 상위 CLI가 메시지를 정리할 수 있게 한다.
- generation / ruleset / roomCode 검증의 authoritative source는 여전히 서버다. client는 server error envelope만 surface 한다.
- 이 단계에서는 room polling / reconnect recovery / room waiting screen UX를 완성하려 하지 않는다. 그건 이후 interactive adapter/consumer 단계에서 붙인다.

## 기대 public contract

- `createPvpRoomHttpClient(...)`
- `PvpRoomHttpClient`
- `PvpRoomHttpClientError` (`network_error` / `http_error` / `invalid_response`)
- `createPvpSessionBootstrap(...)`
- `bootstrap.createRoomSession(...)`
- `bootstrap.joinRoomSession(...)`
- `bootstrap.resumeRoomSession(...)`
- `bootstrap.createSessionFromRoomView(...)`

bootstrap 결과는 최소 다음을 포함한다.

- `roomView`
- `roomId`
- `sessionClient`

## 완료 조건

- create room 요청이 HTTP contract를 통해 `RoomView`로 돌아온다.
- join room 요청이 room code + room id를 함께 사용해 성공/실패를 구분한다.
- 오류 응답은 typed error(`PvpRoomHttpClientError`)로 surface 된다.
- bootstrap helper가 room 응답 기준으로 `PvpSessionClient`를 만들 수 있고, 필요 시 기존 `RoomView`에서 바로 세션을 만들 수 있다.
- 이후 issue는 이 contract 위에 실제 room-code 입력 UX와 raw stdin/stdout adapter만 추가하면 된다.
