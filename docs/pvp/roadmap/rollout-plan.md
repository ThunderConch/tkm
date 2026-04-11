# PvP 구현 로드맵

상위 문서: [PvP 문서 인덱스](../README.md)  
관련 문서: [서버 아키텍처](../server/architecture.md), [치트 대응 정책](../security/anti-cheat.md), [API 계약](../server/api-contract.md)

## 목표

이 로드맵은 현재 설계를 실제 개발 단계로 어떻게 나눌지 정리한다.  
핵심 원칙은 **작게 시작하고, 서버 권한 구조를 먼저 굳히는 것**이다.

## 단계 0. 규칙 고정

목표:

- 초기 친선 PvP 규칙 확정
- 세대별 ruleset / restricted 시드 목록 확정
- 레벨 압축 정책 확정

산출물:

- ruleset 정의 문서
- restricted 목록 정책 데이터 초안

## 단계 1. 온라인 파티 등록

목표:

- 세대별 온라인 파티 등록/갱신 API 구현
- 중복 종 / 특수 포켓몬 제한 검증 구현
- 치트 오염 상태 차단

산출물:

- party registration endpoint
- validation layer
- active party snapshot storage

## 단계 2. 친구전 룸 시스템

목표:

- 룸 생성/참가
- room code 기반 초대
- 세대 / ruleset 고정

산출물:

- room service
- room persistence
- reconnect 가능한 room snapshot 기초

## 단계 3. 서버 권한 배틀 코어

목표:

- WebSocket 기반 실시간 명령 처리
- 서버 턴 계산
- battle_commands / battle_events 저장
- 승패 판정

산출물:

- realtime gateway
- battle simulation adapter
- battle event log

## 단계 4. 클라이언트 연결 UX

목표:

- Claude Code 클라이언트에서 룸 접속/배틀 입력 UX 정리
- 실시간 상태 렌더링
- 기절 후 교체 플로우 정리

산출물:

- connect flow
- command submission UX
- battle event rendering

## 단계 5. 운영 안정화

목표:

- 재접속 처리
- 타임아웃 정책 정교화
- 로그 기반 디버깅
- ruleset 버전 관리 체계 확정

## 단계 6. 차후 확장 후보

- 다중 온라인 파티 슬롯
- 관전
- 리플레이
- 시즌 ruleset
- 래더
- 더블 배틀

## 구현 순서 요약

| 순서 | 우선순위 | 이유 |
|---|---|---|
| 1 | 파티 등록 | 온라인 진입 기준을 먼저 세워야 함 |
| 2 | 룸 시스템 | 친구전 시작점 필요 |
| 3 | 서버 권한 배틀 | 핵심 가치 구현 |
| 4 | 클라이언트 UX | 실제 플레이 가능 상태 완성 |
| 5 | 안정화 | 재접속/로그/운영 대응 |

## 초기 구현 체크리스트

- [ ] 세대별 ruleset 저장 구조 결정
- [ ] restricted 목록 관리 방식 결정
- [ ] 온라인 파티 스냅샷 데이터 구조 확정
- [ ] 치트 오염 저장 차단 방식 확정
- [ ] room code 생성 규칙 결정
- [ ] WebSocket 이벤트 스키마 확정
- [ ] battle event 로그 형식 확정

## 문서 사용법

이 문서는 일정표가 아니라 **구현 분해 기준**이다.  
실제 개발에 들어갈 때는 이 로드맵을 기반으로 별도의 구현 계획 문서를 만들고, 각 단계별로 테스트 전략과 파일 변경 범위를 더 구체화하면 된다.

## 관련 문서

- [PvP 문서 인덱스](../README.md)
- [치트 대응 정책](../security/anti-cheat.md)
- [API 계약](../server/api-contract.md)
