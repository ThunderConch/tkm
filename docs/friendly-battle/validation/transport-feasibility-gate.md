# Transport feasibility gate

## 목적

이 문서는 **옵션 A(host-authoritative direct session)** 를 계속 밀어도 되는지 판단하는 **kill-or-commit gate** 다.

이 gate는 단순 탐색 문서가 아니다. 여기서 실패하면 A에 미련을 두지 않고 **즉시 B(lockstep P2P)** 로 하향한다.

## 왜 초반에 해야 하는가

이번 축의 성공 기준은 battle purity보다 **연결 UX** 에 더 가깝다.

즉,
- host/join 이 너무 번거롭거나
- 실패 원인이 불명확하거나
- Claude Code 내부 명령만으로 끝나지 않거나
- 1판 붙기까지 단계가 너무 많으면

아키텍처가 아무리 예뻐도 제품 방향은 틀린 것이다.

## 통과 조건

아래 항목을 모두 만족해야 한다.

### 1. 같은 머신 2터미널 재현
- host 명령 실행 가능
- join 명령 실행 가능
- ready 가능
- start 가능
- **최소 1턴 이상 action exchange 성공**

### 2. LAN / manual join 흐름
- 주소 또는 join 정보 수동 입력으로 연결 가능
- 브라우저나 별도 웹앱 없이 진행 가능

### 3. Claude Code-only 제약 준수
- 별도 운영 서버 불필요
- 별도 daemon 필수 아님
- 외부 제어판/웹 대시보드 없이 진행 가능

### 4. 실패 UX
- 연결 실패 시 CLI가 원인 후보를 설명해야 한다.
- 사용자가 다음 행동을 알 수 있어야 한다.

## 실패 조건

아래 중 하나라도 핵심적으로 깨지면 A를 폐기한다.

- 2터미널 기본 흐름조차 안정적으로 재현되지 않음
- host/join 단계가 너무 많아 B 이하 UX로 떨어짐
- Claude Code-only 조건을 만족하지 못함
- 실패 메시지가 불명확해 사용자가 진행을 포기하게 됨

## Gate 결과에 따른 분기

### Pass
- A 유지
- 이후 PR은 host-authoritative direct session 기준으로 진행

### Fail
- B로 즉시 하향
- [PR 로드맵](../roadmap/pr-roadmap.md)을 B 기준으로 다시 작성
- A 재추진은 하지 않음

## 권장 검증 로그

PR2에서는 최소 다음 산출물을 남긴다.

- same-machine two-terminal 실행 기록
- 성공/실패 사례 로그
- 사용자 단계 수
- 실패 메시지 예시
- A 유지 또는 B 전환 판정 메모

## 관련 문서

- [ADR 0001](../adr/0001-serverless-friendly-battle-direction.md)
- [연결 구조 후보 비교](../architecture/connection-options.md)
- [PR 로드맵](../roadmap/pr-roadmap.md)
