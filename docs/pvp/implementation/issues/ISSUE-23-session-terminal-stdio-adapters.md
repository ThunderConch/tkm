# ISSUE-23 · session terminal stdio adapters

상위 문서: [PvP 구현 이슈 분해](./README.md)  
선행 이슈: [ISSUE-22 · room create/join + session bootstrap](./ISSUE-22-room-session-bootstrap.md)  
관련 문서: [PvP 작업 분해 / TODO](../todo-breakdown.md), [실시간 배틀 세션 상세 계약](../../server/contracts/realtime-battle-session.md)

## 목표

ISSUE-22에서 고정한 room/session bootstrap contract와 ISSUE-21의 testable CLI orchestration layer 위에, 실제 터미널에서 돌아가는 **stdin/stdout adapter layer** 를 올린다.

이번 단계의 목적은 사용자가 tokenmon/ battle-tui에서 곧바로 live PvP에 들어갈 수 있도록, raw stdin/readline/stdout repaint를 안전한 adapter 뒤로 밀어 넣는 것이다.

## 구현 범위

### 신규/확장 모듈

- `src/pvp/session-terminal-stdio.ts` 또는 동등한 adapter 모듈
- `src/cli/` live PvP entrypoint 연동부
- 필요 시 `src/pvp/index.ts`

### 테스트

- stdin token source 단위 테스트
- stdout repaint/cleanup 단위 테스트
- 상위 CLI entrypoint smoke test

## 핵심 책임

1. `PvpSessionTerminalCliInputSource`를 실제 stdin/readline 구현과 연결한다.
2. `PvpSessionTerminalCliScreenOutput`을 실제 stdout repaint/clear 정책과 연결한다.
3. start/stop 시 raw mode 진입/해제를 deterministic cleanup 순서로 보장한다.
4. Ctrl+C / EOF / 종료 훅과 live session disconnect를 정리된 순서로 연결한다.
5. room create/join bootstrap 결과를 받아 실제 터미널 PvP 루프를 시작하는 entrypoint를 만든다.

## 설계 메모

- process-global side effect는 adapter 안으로 가두고, runner/bootstrap domain은 순수 contract로 유지한다.
- repaint 정책은 최소 flicker로 시작하되, 이후 ANSI/battle-tui 최적화 가능성을 열어 둔다.
- stdin token normalization은 ISSUE-21 contract를 따르며, 실제 키 매핑은 adapter에서만 추가한다.
- stop 시 cleanup 순서는 raw mode 해제 누락이 없도록 테스트로 고정한다.

## 완료 조건

- 실제 stdin/stdout 환경에서 live PvP CLI를 시작/정지할 수 있다.
- room create/join + connect + repaint가 end-to-end로 이어진다.
- 종료 후 raw mode/readline/resource leak가 남지 않는다.
