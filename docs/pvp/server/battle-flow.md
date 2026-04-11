# 실시간 배틀 흐름

상위 문서: [PvP 문서 인덱스](../README.md)  
관련 문서: [배틀 포맷](../game-design/battle-format.md), [서버 아키텍처](./architecture.md), [API 계약](./api-contract.md), [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md), [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)

## 목표

이 문서는 실제 플레이어 경험 기준으로, 온라인 친선 PvP가 어떤 순서로 진행되는지 정의한다.
필드별 payload와 오류 코드는 [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md) 및 [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)을 따른다.

## 전체 흐름

### 1. 파티 등록 완료

양 플레이어는 해당 세대에 대해 활성 온라인 파티를 등록해 둔다.

### 2. 룸 생성 / 참가

- 플레이어 A가 친구전 룸 생성
- room code 발급
- 플레이어 B가 코드로 참가
- 서버가 양측 파티와 ruleset 유효성 확인
- 양측 binding이 끝나면 룸은 `awaiting_presence` 상태로 전이

### 3. 배틀 시작

- 양측이 실시간 세션에 연결되면 룸은 `starting`으로 전이
- 서버가 양측 파티의 **1번 슬롯**을 선발로 고정
- 상대 백라인은 비공개
- 최초 공개 상태 스냅샷(`room.snapshot`) 송신

### 4. 행동 선택 단계

각 턴마다 서버는 양측에 행동 요청을 보낸다.

가능 행동:

- 기술 선택
- 교체 선택
- 항복

### 5. 서버 계산

양측 명령이 수집되면 서버가 다음을 계산한다.

- 우선순위
- 속도 순서
- 행동 유효성
- 대미지
- 상태 변화
- 쓰러짐 여부
- 승패 여부

### 6. 턴 결과 송신

서버는 결과 이벤트 묶음을 순서대로 내려준다.

예:

- 기술 사용
- 피해 발생
- 상태 이상 적용
- 포켓몬 기절
- 승패 체크

### 7. 교체/후속 선택 단계

기절한 포켓몬이 있으면 해당 플레이어에게만 `다음 포켓몬 선택` 요청을 보낸다.

### 8. 종료

한쪽 파티가 전멸하거나 항복하면 서버가 종료 이벤트를 보낸다.

---

## 상태 머신 관점

```text
waiting_for_opponent
  -> awaiting_presence
  -> starting
  -> in_progress
      -> awaiting_actions
      -> resolving_turn
      -> awaiting_replacement
      -> resolving_turn
  -> finished
```

## 턴 처리 원칙

### 선택 타이머

- 기본 선택 시간: 45초
- 시간 초과 시 정책은 추후 확정 가능하지만, 초기안은 다음 둘 중 하나로 설계할 수 있다.
  - 기본 기술 자동 선택
  - 즉시 패배/실격

초기 친선전에서는 지나치게 가혹하지 않게 **기본 행동 대체**가 UX상 더 나을 가능성이 높다. 다만 구현 난이도와 악용 가능성은 따져야 한다.

### 교체 요청

기절 직후에는 해당 플레이어만 행동 가능하다. 이 단계는 일반 턴 선택과 분리된 별도 요청으로 다루는 편이 안전하다.

### 숨은 정보 유지

- 턴 결과 이벤트는 양 플레이어에게 동일하지 않을 수 있다.
- 상대 백라인 관련 정보는 절대 조기 공개하지 않는다.

## 최소 커맨드 타입

- `choose_move`
- `choose_switch`
- `choose_replacement`
- `forfeit`

## 최소 이벤트 타입

- `battle_started`
- `action_requested`
- `command_accepted`
- `move_used`
- `damage_applied`
- `status_applied`
- `pokemon_fainted`
- `replacement_requested`
- `battle_ended`

## 설계 결론

실시간 PvP는 턴제이지만, 네트워크 구조는 **이벤트 기반 실시간 시스템**으로 봐야 한다.  
즉, “한 턴 입력 → 서버 계산 → 이벤트 스트림 반영”이 기본 루프다.

## 다음 문서

- [API 계약](./api-contract.md)
- [친구전 룸 / 매치 성립 상세 계약](./contracts/room-and-match.md)
- [실시간 배틀 세션 상세 계약](./contracts/realtime-battle-session.md)
- [치트 대응 정책](../security/anti-cheat.md)
