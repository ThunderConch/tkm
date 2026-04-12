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

## 판정 산출물

PR2는 아래 산출물을 **반드시** 남겨야 한다.

1. **정식 판정 문서**: [`./pr2-transport-gate-report.md`](./pr2-transport-gate-report.md)
2. same-machine two-terminal 실행 로그 또는 요약
3. 성공/실패 사례별 사용자 단계 수
4. 실패 메시지 예시
5. 최종 판정 메모: `A 유지` 또는 `B 전환`

`pr2-transport-gate-report.md`가 없으면 gate는 완료되지 않은 것으로 본다.
또한 파일이 존재하더라도 **Template / TBD 상태 그대로면 gate는 여전히 incomplete** 다.
즉, canonical report는 실제 실행 결과와 판정 근거로 채워져 있어야 한다.

## 통과 조건

아래 항목을 모두 만족해야 한다.

### 1. 같은 머신 2터미널 재현
- host 명령 실행 가능
- join 명령 실행 가능
- ready 가능
- start 가능
- **최소 1턴 이상 action exchange 성공**
- fresh start 기준으로 **첫 action exchange까지 필요한 명시적 사용자 명령 수가 총 5개 이하** 여야 한다.
  - 권장 상한: host 2개 이하, guest 2개 이하, 추가 보조 명령 1개 이하
  - 복붙/주소 확인은 포함하되, 디버깅용 임시 쉘 명령은 성공 경로에 포함하지 않는다.

### 2. LAN / manual join 흐름
- 주소 또는 join 정보 수동 입력으로 연결 가능
- 브라우저나 별도 웹앱 없이 진행 가능
- join에 필요한 정보는 **한 줄 또는 한 블록** 으로 복사 가능해야 한다.

### 3. Claude Code-only 제약 준수
- 별도 운영 서버 불필요
- 별도 daemon 필수 아님
- 외부 제어판/웹 대시보드 없이 진행 가능
- `tokenmon` / repo 내 CLI surface와 표준 로컬 네트워크 기능만으로 재현 가능해야 한다.

### 4. 실패 UX
연결 실패 시 CLI는 최소 아래 정보를 보여줘야 한다.

- 실패한 단계 (예: listen / connect / handshake / ready)
- 사용자가 바로 확인할 다음 액션 1개 이상
- 잘못됐을 가능성이 높은 입력값 (예: 주소, 포트, 세션 코드)
- 필요 시 재시도에 쓸 명령 또는 옵션 힌트

## 실패 조건

아래 중 하나라도 핵심적으로 깨지면 A를 폐기한다.

- 2터미널 기본 흐름조차 안정적으로 재현되지 않음
- 첫 action exchange까지의 성공 경로가 **명시적 사용자 명령 6개 이상** 필요함
- host/join 단계가 너무 많아 B 이하 UX로 떨어짐
- Claude Code-only 조건을 만족하지 못함
- 실패 메시지가 불명확해 사용자가 진행을 포기하게 됨
- 성공/실패 근거가 [`./pr2-transport-gate-report.md`](./pr2-transport-gate-report.md)에 구조적으로 남지 않음

## Gate 결과에 따른 분기

### Pass
- A 유지
- 이후 PR은 host-authoritative direct session 기준으로 진행
- `pr2-transport-gate-report.md`에 **Pass 근거**, 성공 경로 명령 수, 대표 로그를 남긴다.

### Fail
- B로 즉시 하향
- [PR 로드맵](../roadmap/pr-roadmap.md)을 B 기준으로 다시 작성
- A 재추진은 하지 않음
- `pr2-transport-gate-report.md`에 **Fail 근거**, 막힌 지점, B 전환 이유를 남긴다.

## 판정표

| 항목 | Pass 기준 | Fail 기준 |
|---|---|---|
| same-machine host/join | 2터미널에서 host/join/ready/start/action exchange 성공 | 기본 흐름 자체가 불안정하거나 1턴 교환 실패 |
| 성공 경로 단계 수 | 첫 action exchange까지 명시적 사용자 명령 5개 이하 | 6개 이상 또는 디버깅성 보조 절차 상시 필요 |
| manual join UX | 주소/세션 정보를 한 번에 복사하고 join 가능 | 정보가 여러 군데 흩어지거나 추가 툴 의존 |
| Claude Code-only | repo CLI + 로컬 네트워크만으로 재현 | 별도 웹앱/운영 서버/상주 프로세스 전제 |
| 실패 UX | 실패 단계, 원인 후보, 다음 액션이 바로 보임 | 실패 원인/다음 행동을 사용자가 추정해야 함 |
| 증적 문서화 | `pr2-transport-gate-report.md`에 로그/판정 근거 기록 | 판정이 구두/임시 로그에만 남음 |

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
