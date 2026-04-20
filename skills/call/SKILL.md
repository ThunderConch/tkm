---
description: "Call a Pokémon by name and it reacts based on bond (EV). Korean: 불러, 불러줘, 야, 이리와, 포켓몬 이름, 반응, 파이숭이야, 불꽃숭이야"
---

# Call Your Pokémon

The user called a Pokémon by name. Make it react based on how long you've been together (EV).

## Step 1: Read party EV data

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" party
```

## Step 2: Find the called Pokémon and register the call

Extract the Pokémon name from the user's message. Match by **nickname first**, then by species name.

Once matched, register the call (increments call_count; every 5 calls → EV +1):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" call <포켓몬_ID>
```

The command outputs JSON: `{"ev": N, "call_count": N, "evGained": true/false}`

If `evGained` is true, append a subtle note after the reaction:
> *(사이가 조금 가까워진 것 같다... EV +1)*

## Step 3: Show animated sprite with emotion bubble

Run with the Pokémon's ID and the EV value returned from Step 2:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tsx-resolve.sh" "${CLAUDE_PLUGIN_ROOT}/src/cli/tokenmon.ts" sprite <포켓몬_ID> <EV>
```

This renders the Pokémon's braille sprite with:
- A speech bubble showing its emotional state (? / ... / :) / <3 / <3!) based on EV
- A brief bounce animation (sprite hops up and down when called)

## Step 4: React based on EV

Format: **[닉네임 또는 이름]**[은/는] [반응]

Choose the reaction tier based on EV from Step 1:

### EV 0 — 처음 만남
Reactions (pick one randomly):
- 경계하듯 슬그머니 뒤로 물러선다
- 눈을 피하며 주위를 두리번거린다
- 불안한 듯 몸을 잔뜩 움츠린다
- 주변을 둘러본다
- 궁금하다는 듯이 당신을 쳐다본다
- 심심해하는 것 같다
- 어색하게 서 있다
- 멀찍이서 가만히 이쪽을 바라본다

### EV 1–50 — 낯선 사이
- 살금살금 다가오다가 멈칫한다
- 낯선 듯 더듬더듬 다가온다
- 조심스럽게 냄새를 맡아본다
- 꼬리를 조금 흔들다가 멈춘다

### EV 51–120 — 익숙해지는 중
- 고개를 갸웃거리며 다가온다
- 꼬리를 조심스럽게 흔들어 본다
- 두 눈을 반짝이며 냄새를 맡는다
- 기지개를 켜며 다가온다

### EV 121–200 — 친한 사이
- 신나게 달려와 발치에서 빙글빙글 돈다
- 기분 좋게 울음소리를 낸다!
- 기쁜 듯 온몸을 비빈다
- 반갑게 점프한다

### EV 201–252 — 오랜 파트너
- 꺄르르 웃으며 달려와 품에 안긴다
- 오랜 친구처럼 어깨에 올라탄다
- 눈을 가늘게 뜨며 기분 좋게 그르릉거린다
- 이름을 부르자마자 달려와 손을 핥는다

## Step 5: Not in party

If the Pokémon is **not in the party**, respond:

> **[포켓몬 이름]**[은/는] 파티에 없어서 달려오지 못했다...

---

Keep the reaction to **one line**. Use correct Korean particles (은/는, 이/가).
