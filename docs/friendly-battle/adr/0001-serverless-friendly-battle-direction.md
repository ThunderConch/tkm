# ADR 0001 — serverless friendly battle 방향 결정

- 상태: Accepted (Draft baseline)
- 날짜: 2026-04-12
- 의사결정 범위: 친선전 멀티플레이 장기 축

## Decision

Tokénmon의 새 멀티플레이 장기 축은 **server-authoritative PvP** 가 아니라 **serverless friendly battle** 로 간다.

초기 기본안은 **host-authoritative direct session** 이다. 다만 이 안은 절대 고정이 아니며, [Transport feasibility gate](../validation/transport-feasibility-gate.md)를 통과할 때만 유지된다. Gate 실패 시 **lockstep P2P** 로 즉시 하향한다.

## Drivers

1. **인게임 감성 유지** — NPC 트레이너를 조우하듯 즉석에서 붙는 흐름이 중요하다.
2. **로컬 파티 보존** — 스토리/로컬에서 키운 파티를 그대로 꺼내 쓰는 맛이 핵심 가치다.
3. **Claude Code 내부 명령 완결성** — host / join / battle 이 외부 웹앱이나 운영 서버 없이 가능해야 한다.
4. **운영 부담 회피** — 래더, 계정, 매칭, anti-cheat 서버를 지금 축의 전제로 두지 않는다.
5. **장기 유지 가능성** — 공정성보다 재미와 유지보수 단순성을 우선한다.

## Non-goals

다음은 이 축의 초기 범위 밖이다.

- 래더 / 점수 / 시즌
- anti-cheat / 위조 방지 백엔드
- 재접속 복구
- public matchmaking
- spectator / replay
- 교환 시스템 본체

## Alternatives considered

### A. Host-authoritative direct session
- 한 플레이어가 host 역할을 맡고 전투 계산 권한을 가진다.
- 다른 플레이어는 join 후 선택 명령만 전달한다.
- **목표안**이다.

### B. Lockstep P2P
- 양쪽이 같은 초기 상태와 같은 입력을 공유하며 각자 시뮬레이션한다.
- A가 UX gate를 통과하지 못할 때의 **최대 타협안**이다.

### C. Minimal relay / hosted service
- 연결성은 나아질 수 있지만 운영 서버 전제를 다시 도입하게 된다.
- 이번 축에선 탈락한다.

## Why chosen

A안은 battle engine 재사용성과 인게임 감성 면에서 가장 자연스럽다. 그러나 이 프로젝트의 성공 기준은 battle engine purity보다 **연결 UX가 A 또는 최소 B 수준으로 나오는가**에 더 가깝다. 그래서 A를 곧바로 확정하지 않고, 반드시 **PR2 gate** 에서 검증한다.

## Consequences

- 문서와 코드 구조는 기존 `docs/pvp` 중심 축과 명확히 분리되어야 한다.
- progression / snapshot / session / battle 의 경계를 문서와 코드에 모두 반영해야 한다.
- transport feasibility가 실패하면 초반에 과감히 B로 하향해야 하며, A에 미련을 두고 구현을 계속하면 안 된다.

## Source of truth

- **현재 축의 source of truth:** `docs/friendly-battle/`
- **레거시 참고 축:** `docs/pvp/`

## Follow-ups

1. [아키텍처 개요](../architecture/overview.md) 확정
2. [상태 경계](../architecture/state-boundary.md) 확정
3. [Transport feasibility gate](../validation/transport-feasibility-gate.md) 수행
4. [PR 로드맵](../roadmap/pr-roadmap.md) 기준으로 구현 분해
