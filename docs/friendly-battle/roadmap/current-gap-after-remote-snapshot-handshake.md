# Friendly Battle 현재 gap 정리

상태: Draft  
기준 브랜치: `feat/friendly-battle-remote-snapshot-handshake`  
목적: **지금 이미 구현된 것**과 **아직 남아 있는 product gap**을 분리해서 기록한다.

이 문서는 "serverless friendly battle" 축의 현재 구현 상태를 기준으로, 다음 PR에서 무엇을 메워야 하는지 빠르게 확인하기 위한 체크리스트다.

---

## 1. 현재 이미 구현된 것

### 1-1. 제품 엔트리 포인트
현재 유저가 진입하는 표면은 별도 GUI가 아니라 `tokenmon` CLI의 제품용 명령 surface 다.

- 엔트리: `tokenmon friendly-battle ...`
- 라우팅: `src/cli/tokenmon.ts` -> `src/cli/friendly-battle.ts`
- 하위 구현: 현재는 `src/cli/friendly-battle-local.ts` 로 위임

즉, **방 열기 / 참여하기 인터페이스는 이미 `tokenmon friendly-battle host|join` 형태로 들어가 있다.**

### 1-2. host / join 명령 surface
현재 공개 surface 는 다음과 같다.

- host
  - `tokenmon friendly-battle host --session-code <code> [--listen-host ...] [--join-host ...] [--port ...] [--timeout-ms ...] [--generation ...] [--player-name ...]`
- join
  - `tokenmon friendly-battle join --host <host> --port <port> --session-code <code> [--timeout-ms ...] [--generation ...] [--player-name ...]`

host 쪽은 실행 후 상대가 그대로 붙여넣을 수 있는 `JOIN_COMMAND` 를 출력한다.

참고로 현재 help 문구에는 join 쪽 `--generation` 이 생략되어 보일 수 있지만, 실제 `JOIN_COMMAND` 출력과 join 파서 기준으로는 `--generation` 도 현재 surface 에 포함되어 있다.

### 1-3. same-network join 정보 게시
host 는 같은 네트워크의 다른 머신이 붙을 수 있도록 `JOIN_INFO` / `JOIN_COMMAND` 를 출력한다.

즉, 방향 자체는 이미 **same machine 전용 local-only** 가 아니라 **same network 의 서로 다른 두 machine** 을 염두에 둔 형태로 올라와 있다.

### 1-4. 세션/전투 기반 코드
다음 기초 레이어가 이미 코드로 존재한다.

- session / protocol contract
- party snapshot builder / validator
- local harness
- battle adapter
- tcp direct spike transport
- product-facing CLI surface
- 타입/테스트 스위트

즉, 현재 브랜치는 **문서-only 상태가 아니라 실제 friendly battle foundation 코드가 이미 들어간 상태**다.

---

## 2. 현재 구현의 정확한 한계

가장 중요한 점은, **지금은 host/join 연결 자체와 battle event 흐름은 올라와 있지만, 실제 턴 선택 UX는 아직 제품 수준으로 완성되지 않았다**는 것이다.

### 2-1. ready / leave 는 아직 얕다
현재 `ready` 는 설명용이며, local v1 에서는 연결되면 자동 ready 로 취급한다.

현재 `leave` 도 별도 세션 프로토콜이 아니라, 실행 중인 터미널을 중단하는 형태다.

즉, `ready` / `leave` 는 **사용자용 명령 이름은 잡혀 있지만, 아직 깊은 session UX 는 아니다.**

### 2-2. 전투 중 choice 입력은 아직 실사용 UX 가 아니다
현재 local harness/CLI 흐름은 실사용자 입력 루프 대신, 테스트/스파이크 성격의 deterministic choice 제출이 섞여 있다.

예를 들면 현재 코드에는 다음 성격이 남아 있다.

- host 는 deterministic choice 선택 로직을 통해 행동을 고른다.
- guest 도 `move:0` 또는 상황에 따라 `surrender` 를 자동 제출하는 경로가 있다.

즉, **지금은 방을 열고 참가하는 입구는 생겼지만, 실제 인게임 감성의 "내가 기술을 고르고 교체를 고르는" 친선전 UX 는 아직 미완성**이다.

---

## 3. 지금 merge해도 가능한 것

현재 기준으로는 아래가 가능하다.

- host 가 친선전 세션을 연다.
- join 쪽이 출력된 명령으로 접속한다.
- snapshot 을 교환한다.
- ready/start 흐름을 태운다.
- battle event 를 주고받는다.
- timeout/cancel 류 transport hardening 일부가 들어가 있다.

즉, **transport foundation + session foundation + snapshot foundation + product entrypoint** 까지는 이미 올라왔다고 볼 수 있다.

---

## 4. 지금 merge해도 아직 "완주 가능한 친선전 제품" 이 아닌 이유

아래 항목이 남아 있기 때문이다.

### 4-1. 반복 턴 입력 UX
필수.

남은 항목:
- 각 턴마다 기술 선택 루프
- switch 선택 루프
- 잘못된 입력 재시도 UX
- 현재 대기 상태를 보여주는 출력
- Claude Code 내부에서 부담 없이 따라갈 수 있는 명령형 안내

### 4-2. 기절 후 다음 포켓몬 선택 UX
필수.

남은 항목:
- 강제 교체가 필요한 상황 감지
- 교체 가능한 포켓몬 목록 제시
- 유저가 직접 다음 포켓몬을 고르는 흐름
- 선택 시간 초과/취소 처리 정책

### 4-3. surrender / 종료 흐름
필수.

남은 항목:
- 명시적 surrender 입력
- 상대에게 종료 이유 전달
- host/join 어느 쪽에서 종료해도 세션이 일관되게 닫히는 처리
- 종료 후 요약 메시지

### 4-4. same-network two-machine 수동 검증 증거
강하게 권장.

코드 방향은 이미 same-network 를 향하고 있지만, **실제 서로 다른 두 머신에서의 수동 smoke evidence** 는 별도 문서/로그로 더 남기는 것이 좋다.

이건 대형 기능 추가라기보다는, 현재 transport 방향을 제품적으로 안심하고 밟기 위한 검증 보강에 가깝다.

---

## 5. 의도적으로 지금 안 하는 것

아래는 gap 이 아니라 **의도적 비범위** 다.

- anti-cheat / 결과 위조 방지 백엔드
- server-authoritative battle
- 래더 / 점수 / 시즌
- 계정 시스템
- 재접속 복구
- 인터넷 전체 자동 매칭
- 관전 / 리플레이
- 교환 시스템

즉, 이 문서에서 말하는 "남은 gap" 은 위 항목을 뜻하지 않는다.  
여기서 말하는 gap 은 오직 **serverless friendly battle 을 친선전 제품으로 완주시키기 위해 남은 최소 product flow** 다.

---

## 6. 다음 PR 우선순위

### P0 — 실제 턴 선택 UX 완성
가장 먼저.

목표:
- host/join 둘 다 배틀 중 직접 choice 를 낼 수 있어야 한다.
- 기술 선택 / 교체 선택 / surrender 가 모두 유저 입력 기반으로 동작해야 한다.

### P1 — 종료/오류 흐름 정리
그 다음.

목표:
- leave / surrender / disconnect 시 사용자가 무엇을 해야 하는지 명확해야 한다.
- 실패했을 때 다시 host 부터 시작하면 되는지, join 만 재시도하면 되는지 안내가 있어야 한다.

### P2 — same-network manual smoke 문서화
병행 가능.

목표:
- 서로 다른 두 machine 에서 실제로 시도하는 절차를 문서화한다.
- 성공/실패 케이스를 간단히 남긴다.

---

## 7. 한 줄 결론

현재 구현은 **방을 열고 참가하는 입구 + transport/session foundation + snapshot foundation** 까지는 올라와 있다.  
하지만 **실제 플레이어가 턴마다 직접 기술/교체/항복을 고르는 제품 UX** 는 아직 남아 있다.

그래서 지금 상태는 "친선전 기반 공사" 로는 충분히 의미 있지만,  
아직은 **완주 가능한 친선전 제품 1차** 라고 부르기에는 이르다.

## 관련 문서

- [Friendly Battle 문서 인덱스](../README.md)
- [아키텍처 개요](../architecture/overview.md)
- [PR 로드맵](./pr-roadmap.md)
- [Transport feasibility gate](../validation/transport-feasibility-gate.md)
