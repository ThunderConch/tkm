# ISSUE-10 · 클라이언트 프로토콜 어댑터

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-09 · 클라이언트 배틀 세션 스토어](./ISSUE-09-client-session-store.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

클라이언트가 websocket 라이브러리나 UI 프레임워크에 종속되지 않으면서도, **서버 outbound envelope를 소비하고 필요한 outbound message를 생성하는 protocol adapter**를 만든다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/client-protocol.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-client-protocol.test.ts`

## 핵심 책임

1. 서버 outbound envelope(`battle.*`, `ws.ping`, `ws.error`)를 단일 진입점으로 처리한다.
2. 배틀 이벤트는 `session-store`에 위임해 authoritative 상태를 갱신한다.
3. `ws.ping` 수신 시 `ws.pong` outbound envelope를 생성한다.
4. transport 오류(`ws.error`)를 UI가 읽을 수 있는 상태로 기록한다.
5. UI 레이어가 raw protocol을 몰라도 되도록 `battle.command` 생성을 래핑한다.

## 완료 조건

- 상위 UI는 `applyPvpTransportEnvelope`와 `createPvpClientCommand`만으로 프로토콜 왕복을 다룰 수 있다.
- adapter가 socket 구현체 없이도 테스트 가능하다.
- 이후 실제 websocket 연결기나 Claude Code command loop는 이 adapter 위에 얹을 수 있다.
