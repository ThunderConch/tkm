# 세대별 ruleset 설계

상위 문서: [PvP 문서 인덱스](../README.md)
관련 문서: [성장 및 파티 등록](./progression-and-party-registration.md), [특수 포켓몬 정책](./special-pokemon-policy.md), [서버 데이터 모델](../server/data-model.md)

## 왜 세대별 ruleset이 필요한가

Tokénmon은 이미 세대별 데이터와 진행 구조를 갖고 있다.
따라서 온라인 PvP도 하나의 통합 규칙으로 뭉개기보다, **세대별 포켓몬 풀과 ruleset을 별도로 운영**하는 것이 자연스럽다.

이 구조를 선택하면 다음이 가능하다.

- gen1 친선전과 gen4 친선전의 메타를 분리
- 세대별 restricted 목록 운용
- 세대별 활성 등록 파티 1개 구조 유지
- 향후 시즌/이벤트 룰 추가 시 확장 용이

## 공통 규칙

모든 세대 ruleset은 다음 기본 축을 공유한다.

- 싱글 배틀
- 6마리 등록 / 6마리 전원 사용
- 팀 프리뷰 없음
- 1번 슬롯 자동 선발
- 중복 종 금지
- 전설+환상 총 2 제한
- restricted 최대 1
- 레벨 50 이후 압축 / 유효 레벨 상한 60

## 세대별 활성 파티

플레이어는 세대마다 별도의 온라인 파티를 가진다.

예:

- `player A / gen1 / active_party`
- `player A / gen4 / active_party`
- `player A / gen9 / active_party`

온라인 룸 생성 시에도 어느 세대 ruleset인지가 명확해야 한다.

## 세대별 특수 포켓몬 수치 참고

현재 데이터 기준 특수 포켓몬 분포는 다음과 같다.

| 세대 | 포켓몬 수 | legendary | mythical |
|---|---:|---:|---:|
| gen1 | 151 | 4 | 1 |
| gen2 | 100 | 5 | 1 |
| gen3 | 135 | 8 | 2 |
| gen4 | 112 | 9 | 5 |
| gen5 | 156 | 9 | 4 |
| gen6 | 72 | 3 | 3 |
| gen7 | 88 | 11 | 5 |
| gen8 | 96 | 11 | 1 |
| gen9 | 120 | 11 | 1 |

이 수치는 곧 restricted 규칙이 세대별로 달라져야 함을 의미한다.

## restricted 시드 리스트 v0

아래 목록은 초기 밸런싱 시작점이다.
확정 영구 규칙이라기보다, **첫 친선 PvP 운영을 위한 시드 목록**으로 본다.

| 세대 | restricted 시드 후보 |
|---|---|
| gen1 | 150 Mewtwo |
| gen2 | 249 Lugia, 250 Ho-Oh |
| gen3 | 382 Kyogre, 383 Groudon, 384 Rayquaza |
| gen4 | 483 Dialga, 484 Palkia, 486 Regigigas, 487 Giratina, 493 Arceus |
| gen5 | 643 Reshiram, 644 Zekrom, 646 Kyurem |
| gen6 | 716 Xerneas, 717 Yveltal |
| gen7 | 791 Solgaleo, 792 Lunala, 800 Necrozma |
| gen8 | 888 Zacian, 889 Zamazenta, 890 Eternatus |
| gen9 | 1007 Koraidon, 1008 Miraidon |

## gen4 현재 풀 기준 메모

현재 루트 데이터 기준 gen4 특수 포켓몬 풀에서는 다음 판단이 중요하다.

### restricted로 두는 후보
- Dialga
- Palkia
- Regigigas
- Giratina
- Arceus

### restricted가 아닌 특수 포켓몬 예시
- Uxie
- Mesprit
- Azelf
- Heatran
- Cresselia
- Phione
- Manaphy
- Darkrai
- Shaymin

특히 Regigigas는 Tokénmon 구현 상태에서 원작의 약점이 충분히 재현되지 않는다면 restricted로 보는 편이 안전하다.

## ruleset 버전 관리

세대 ruleset은 정적 파일 하나로 끝내지 말고, 서버에서 **버전 관리되는 정책 데이터**로 보는 것이 좋다.

예:

- `tkm-friendly-gen4-v1`
- `tkm-friendly-gen4-v2`
- `tkm-friendly-gen9-v1`

이렇게 해야 restricted 조정, 레벨 정책 수정, 예외 처리 추가가 기존 배틀 기록과 충돌하지 않는다.

## 설계 결론

온라인 PvP는 “한 개의 공통 모드”가 아니라 다음 구조로 본다.

- 세대별 친선 ruleset
- 세대별 restricted 목록
- 세대별 활성 온라인 파티
- 룸 생성 시 세대와 ruleset이 고정되는 구조

## 다음 문서

- [서버 데이터 모델](../server/data-model.md)
- [API 계약](../server/api-contract.md)
