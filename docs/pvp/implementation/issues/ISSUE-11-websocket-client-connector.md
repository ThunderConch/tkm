# ISSUE-11 · WebSocket 클라이언트 커넥터

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-10 · 클라이언트 프로토콜 어댑터](./ISSUE-10-client-protocol-adapter.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

순수 `session-store` / `client-protocol` 위에 **실제 WebSocket 연결 수명주기와 송수신을 얹는 클라이언트 커넥터**를 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/websocket-client.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-websocket-client.test.ts`

## 핵심 책임

1. `roomId` / `token` / 서버 URL을 받아 PvP WebSocket 연결을 열고 종료한다.
2. raw socket inbound message를 `client-protocol` 단일 진입점으로 전달한다.
3. UI가 socket 구현체를 몰라도 되도록 `connect`, `disconnect`, `sendBattleCommand`, `subscribe` 표면을 제공한다.
4. 브라우저 전역 `WebSocket`에 고정되지 않도록 socket factory / constructor 주입 경계를 제공한다.
5. `connecting`, `connected`, `reconnecting`, `closed`, `error` 같은 transport 상태를 별도 모델로 노출한다.
6. `ws.ping` / `ws.pong`, close code, parse failure, duplicate connect 같은 transport 오류를 battle state와 분리해 다룬다.

## 설계 메모

- 이 이슈는 **배틀 계산**이 아니라 **transport 연결기**를 만드는 단계다. 서버 authoritative 원칙은 그대로 유지한다.
- 재접속 UX 전체를 완성하는 것은 [ISSUE-08 · 재접속 / 운영 안정화](./ISSUE-08-reconnect-and-ops.md)와 연결되지만, 클라이언트 측에서는 우선 “끊김 감지 / 재연결 시도 훅 / snapshot 재부트스트랩”을 넣을 수 있는 최소 경계를 먼저 만든다.
- Claude Code와 battle TUI가 같은 connector를 재사용할 수 있도록, 터미널 입출력과 WebSocket transport를 직접 결합하지 않는다.
- 따라서 이 단계의 핵심은 “socket 이벤트 핸들러를 여기저기 흩뿌리는 것”이 아니라, **환경 독립 transport 경계**를 먼저 세우는 것이다.

## 완료 조건

- 상위 UI는 WebSocket 라이브러리의 이벤트 이름을 직접 알지 않고도 PvP 서버에 접속할 수 있다.
- fake socket으로 연결/메시지/종료 시나리오를 독립 테스트할 수 있다.
- `client-protocol` / `session-store` 테스트와 분리된 transport 테스트가 가능하다.
- 이후 Claude Code command loop나 battle TUI는 이 connector 위에 얹는 방식으로 실시간 대전을 붙일 수 있다.
