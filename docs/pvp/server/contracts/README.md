# PvP 서버 Contracts 문서

상위 문서: [서버 설계 인덱스](../README.md)

이 섹션은 서버가 외부에 노출하는 **Phase별 상세 계약**을 모아둔 하위 묶음이다.
즉, 실제 구현 시 “어떤 endpoint / 메시지 / 상태 전이가 허용되는가”를 필드 단위로 따라갈 때 읽는 문서들이다.

## 포함 문서

1. [온라인 파티 등록 상세 계약](./party-registration.md)
2. [친구전 룸 / 매치 성립 상세 계약](./room-and-match.md)
3. [실시간 배틀 세션 상세 계약](./realtime-battle-session.md)

## 읽는 순서

- Phase 1: [온라인 파티 등록 상세 계약](./party-registration.md)
- Phase 2: [친구전 룸 / 매치 성립 상세 계약](./room-and-match.md)
- Phase 3: [실시간 배틀 세션 상세 계약](./realtime-battle-session.md)

## 이 묶음이 답하는 질문

- 어떤 입력을 서버가 받아들이고 어떤 입력을 거절하는가?
- 룸 생성/참가/시작 준비는 어떤 상태 머신으로 묶이는가?
- WebSocket 세션에서 어떤 이벤트를 어떤 공개 범위로 내려야 하는가?
