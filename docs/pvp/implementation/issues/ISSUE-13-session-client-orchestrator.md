# ISSUE-13 · 상위 PvP session client orchestration 레이어

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-12 · 클라이언트 재접속 / backoff 컨트롤러](./ISSUE-12-client-reconnect-controller.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`websocket-client`와 `reconnect-controller`를 조합해, Claude Code / battle TUI / 이후 CLI surface가 그대로 붙일 수 있는 **상위 PvP session client 단일 진입점**을 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-client.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-session-client.test.ts`

## 핵심 책임

1. 내부에서 WebSocket transport client와 reconnect controller를 생성/조합한다.
2. 상위 consumer가 `connect`, `disconnect`, `dispose`, `subscribe`, `getState`, `sendBattleCommand` 만으로 세션을 다룰 수 있게 한다.
3. UI가 nested 내부 구조를 매번 더듬지 않도록 다음 정보를 파생 상태로 평평하게 노출한다.
   - transport status
   - session / protocol snapshot
   - reconnect scheduling 메타
   - 현재 pending request 존재 여부와 종류
   - 현재 command 입력 가능 여부
4. authoritative battle 계산은 여전히 서버가 담당하고, 이 레이어는 **상태 조합과 읽기 모델 정리**만 맡는다.
5. 이후 battle TUI / Claude Code command loop wiring이 이 레이어 위에서 시작될 수 있도록 최소하지만 안정적인 진입점을 제공한다.

## 설계 메모

- `session-store`는 battle-visible state 규칙을 관리한다.
- `client-protocol`은 inbound/outbound envelope 해석을 담당한다.
- `websocket-client`는 transport 수명주기와 raw 송수신을 담당한다.
- `reconnect-controller`는 예기치 않은 끊김 뒤 재접속 스케줄링을 담당한다.
- 따라서 이번 이슈는 새로운 계산 계층이 아니라, **상위 consumer용 orchestration / facade 계층**을 만드는 단계다.

즉, 이후 상위 UI는 “socket 이벤트 + reconnect 이벤트 + protocol state + command lock”을 각각 따로 구독하지 않고, `session-client` 하나만 보면 된다.

## 완료 조건

- 상위 consumer가 단일 객체만으로 PvP 연결 lifecycle을 다룰 수 있다.
- 파생 상태에서 `canSendCommand`, `hasPendingRequest`, `activeRequestKind`, reconnect metadata를 곧바로 읽을 수 있다.
- connect → snapshot → action request → command submit → reconnect 시나리오가 독립 테스트로 검증된다.
- 이후 battle TUI / Claude Code 명령 루프는 이 레이어 위에 UX만 추가하면 된다.
