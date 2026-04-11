# ISSUE-12 · 클라이언트 재접속 / backoff 컨트롤러

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-11 · WebSocket 클라이언트 커넥터](./ISSUE-11-websocket-client-connector.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [ISSUE-08 · 재접속 / 운영 안정화](./ISSUE-08-reconnect-and-ops.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

`websocket-client` 위에 **환경 독립 reconnect / backoff orchestration 레이어**를 올려, Claude Code / TUI가 예기치 않은 끊김 이후에도 authoritative snapshot 기반으로 다시 이어붙일 수 있게 한다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/reconnect-controller.ts`
- `src/pvp/index.ts`

### 테스트

- `test/pvp-reconnect-controller.test.ts`

## 핵심 책임

1. manual disconnect와 예기치 않은 close/error를 구분한다.
2. 예기치 않은 끊김 뒤에는 설정 가능한 backoff 정책으로 재접속을 스케줄링한다.
3. 재접속 시도 횟수, 다음 대기 시간, 마지막 reconnect 사유를 UI가 읽을 수 있는 상태로 노출한다.
4. 기존 `session-store` / `client-protocol` / `websocket-client` 책임을 침범하지 않고 orchestration만 담당한다.
5. fake timer / fake scheduler로 deterministic test가 가능하도록 시간 의존성을 주입 가능하게 만든다.

## 설계 메모

- authoritative state 복구는 여전히 서버 `room.snapshot`이 담당한다.
- 이 레이어는 “무엇을 다시 그릴지”를 계산하지 않고, “언제 다시 붙을지”만 결정한다.
- 초기 PvP는 battle animation 재생보다 **빠른 재동기화와 입력 잠금 해제**가 더 중요하다.
- 따라서 reconnect controller는 transport wrapper이지, 별도 battle state store가 아니다.

## 완료 조건

- 예기치 않은 close 뒤에 controller가 자동으로 reconnect를 스케줄링할 수 있다.
- 사용자가 명시적으로 종료한 경우에는 추가 reconnect가 발생하지 않는다.
- backoff 정책과 시도 횟수가 테스트에서 deterministic하게 검증된다.
- 이후 Claude Code command loop / battle TUI는 이 controller 위에서 “재연결 중” UX만 얹으면 된다.
