# Tokenmon v0.1.0 Spec: Collection Expansion + QoL

> One spec, three milestones. Each milestone pairs a content feature with a QoL improvement.

## Design Principles

1. **Tamagotchi-first**: No stress, no FOMO, no unwanted surprises.
2. **User agency**: Branching evolution and legendary selection are always user-initiated.
3. **Additive rewards**: Event encounters and pokédex rewards are bonuses — missing them carries no penalty.
4. **i18n-aware**: All new user-facing text goes through the i18n system (ko/en).

---

## Milestone 1: Branching Evolution + Notification System

### M1-A. Branching Evolution

#### Behavior

- **Single-path evolution** (e.g., Starly → Staravia): Unchanged — automatic on level-up.
- **Branching evolution** (e.g., Eevee → 7 forms): Automatic evolution is **blocked**. The pokémon enters `evolution_ready` state.
- User selects the target form via `/tkm evolve <pokemon> [<target>]`.
- No time limit. No pressure. The pokémon stays in current form until the user decides.

#### CLI: `/tkm evolve`

```
$ /tkm evolve eevee
> Eevee (Lv.25) can evolve into:
>   1. Leafeon    — condition: met ✓
>   2. Glaceon    — condition: met ✓
>   3. Espeon     — condition: friendship 220+ ✓ (daytime)
>   4. Umbreon    — condition: friendship 220+ (nighttime) ✗
> Select a number:
```

If only one branch is eligible, still prompt for confirmation (no auto-evolve).

#### Data Changes

- `pokemon.json`: `evolves_to` field supports `string | string[]`.
  - String → single-path (auto).
  - Array → branching (manual selection).
- Each branch entry: `{ "name": "<id>", "condition": { ... } }`.
- Gen 4 branching candidates: Eevee (7 eeveelutions), Kirlia (Gardevoir/Gallade), Snorunt (Glalie/Froslass), Burmy (3 forms), Ralts line.

#### State Changes

- `state.pokemon[name].evolution_ready: boolean` — flags pokémon awaiting user choice.
- `state.pokemon[name].evolution_options: string[]` — eligible target forms at time of trigger.

#### Evolution Logic (`evolution.ts`)

```
on level-up / friendship / condition met:
  if evolves_to is string → auto-evolve (existing behavior)
  if evolves_to is array →
    eligible = filter branches by condition
    if eligible.length > 0:
      set evolution_ready = true
      set evolution_options = eligible
      skip auto-evolution
```

### M1-B. Notification System

#### Notification Events

| Event | Trigger | Message |
|-------|---------|---------|
| `evolution_ready` | Branching evolution condition met | "{name} can evolve! Use /tkm evolve" |
| `region_unlocked` | Pokédex progress meets region unlock | "New region unlocked: {region}" |
| `achievement_near` | Any achievement ≥ 90% progress | "{achievement} is almost complete ({current}/{target})" |
| `legendary_unlocked` | Pokédex milestone for legendary group | "Legendary pokémon unlocked! Use /tkm legendary" |

#### Delivery

- **session-start hook**: Check state for pending notifications → output in `notifications` array of stdout JSON.
- **Same notification**: Shown once per session. Repeated across sessions until resolved (evolution chosen, etc.) or dismissed.
- **`/tkm notifications`**: View current notifications.
- **`/tkm notifications clear`**: Dismiss all current notifications.

#### Configuration

- `config.json`: `notifications: boolean` (default: `true`).

---

## Milestone 2: Event Encounters + Dashboard & Stats

### M2-A. Event Encounters

#### Event Types

| Type | Condition | Effect |
|------|-----------|--------|
| **Time-of-day** | Local time ranges | Shift encounter pool weighting (e.g., Ghost ↑ at night 21:00-05:00) |
| **Day-of-week** | Specific weekday | Friday: rare encounter probability 2x |
| **Streak** | N consecutive active days | 7-day streak: guaranteed encounter with rare pokémon |
| **Milestone** | Cumulative tokens/sessions | 1M total tokens: one-time special encounter |

#### Stress Prevention Rules

- Event encounters are **additive bonuses** only — they increase probability, never gate content.
- All event pokémon also exist in regular encounter pools (events just boost odds).
- No "today only!" or FOMO language.
- Streak breaks carry **zero penalty** — counter resets to 0, no punishment.

#### Data: `data/events.json`

```json
{
  "time_of_day": [
    {
      "id": "night_shift",
      "hours": [21, 22, 23, 0, 1, 2, 3, 4],
      "type_boost": { "ghost": 2.0, "dark": 1.5 },
      "label": { "en": "Night Shift — Ghost & Dark ↑", "ko": "야간 — 고스트 & 악 타입 ↑" }
    }
  ],
  "day_of_week": [
    {
      "id": "lucky_friday",
      "day": 5,
      "rare_multiplier": 2.0,
      "label": { "en": "Lucky Friday — Rare ↑", "ko": "럭키 프라이데이 — 레어 ↑" }
    }
  ],
  "streak": [
    {
      "id": "weekly_streak",
      "days": 7,
      "reward": "guaranteed_rare_encounter",
      "label": { "en": "7-day streak reward!", "ko": "7일 연속 보상!" }
    }
  ]
}
```

#### State Changes

- `state.stats.streak_days: number` — current consecutive active days.
- `state.stats.longest_streak: number` — personal best.
- `state.stats.last_active_date: string` — ISO date of last session (for streak calculation).

#### Encounter Logic (`encounter.ts`)

```
selectWildPokemon():
  1. determine base pool (region)
  2. check active events:
     - time_of_day → apply type_boost weights
     - day_of_week → apply rare_multiplier
     - streak → if threshold met, force rare selection
     - milestone → if triggered, one-time special encounter
  3. roll from weighted pool
```

### M2-B. Dashboard & Stats

#### CLI: `/tkm dashboard`

Full-screen summary combining party, stats, notifications, and active events.

```
╔══════════════════════════════════════╗
║  Region: Mountain (Lv.30-40)        ║
║  Day streak: 12 (best: 23)          ║
║  Pokédex: 47/107 (43.9%)           ║
╠══════════════════════════════════════╣
║  Party                               ║
║  Infernape  Lv.42  ████████░░  78%  ║
║  Luxray     Lv.38  ██████░░░░  62%  ║
║  Roserade   Lv.35  █████░░░░░  51%  ║
╠══════════════════════════════════════╣
║  Recent Activity (7d)                ║
║  • +2,340 XP earned                 ║
║  • 3 battles (2W/1L)               ║
║  • 2 new pokédex entries            ║
║  • Eevee can evolve!                ║
╠══════════════════════════════════════╣
║  Today's Event                       ║
║  Night Shift — Ghost & Dark ↑       ║
╚══════════════════════════════════════╝
```

All text rendered via i18n — output language follows `config.json` language setting.

#### Stats Tracking (`state.stats`)

```typescript
interface Stats {
  // Activity
  streak_days: number;
  longest_streak: number;
  last_active_date: string;

  // Weekly rolling (reset every Monday)
  weekly_xp: number;
  weekly_battles_won: number;
  weekly_battles_lost: number;
  weekly_catches: number;
  weekly_encounters: number;

  // All-time
  total_xp_earned: number;
  total_battles_won: number;
  total_battles_lost: number;
  total_catches: number;
  total_encounters: number;
}
```

#### CLI: `/tkm stats`

Shorthand for the stats section only (without party/event/notification).

---

## Milestone 3: Pokédex Rewards + Party Management

### M3-A. Pokédex Rewards

#### Milestone Rewards

| Pokédex Count | Reward |
|---------------|--------|
| 10 | Poké Ball ×5 |
| 30 | Permanent XP multiplier +5% |
| 50 | Legendary group 1 unlocked (Lake Trio: Mesprit/Azelf/Uxie) |
| 80 | Legendary group 2 unlocked (Cover Legendary: Dialga/Palkia) |
| 100 | Party slot +1 |
| 107 (complete) | Giratina directly joins party + Pokédex Master title |

#### Type Master Rewards

- Register all pokémon of a single type → **Type Master** title for that type.
- Bonus: 1.2x battle XP when fighting with/against that type (minor, non-essential).
- Displayed in `/tkm pokedex --type <type>` progress view.

#### Type Master Bonus (3 types mastered)

- Legendary group 4 unlocked (Heatran/Regigigas).

#### Evolution Chain Completion

- Register every member of an evolution line → Poké Ball ×2 per chain.

#### Legendary Pokémon Unlock Flow

**Principle**: 1 free pick + the rest enter encounter pool.

```
[Milestone 50 reached — Lake Trio unlocked]

$ /tkm legendary
> Legendary group unlocked: Lake Trio
>   1. Mesprit  (Psychic) — The Emotion Pokémon
>   2. Azelf    (Psychic) — The Willpower Pokémon
>   3. Uxie     (Psychic) — The Knowledge Pokémon
> Choose one to join your team:

> Selected: Azelf
> Azelf joined your party!
> Mesprit and Uxie now appear in wild encounters.
```

- The chosen pokémon is added directly (no battle needed).
- Remaining pokémon join the encounter pool at **low probability** (rarity: legendary).
- Legendary encounters use the standard battle/catch flow — no special mechanics.
- If the encounter pool pokémon is defeated, it stays in the pool for future encounters.

#### Data: `data/pokedex-rewards.json`

```json
{
  "milestones": [
    { "count": 10, "reward": { "type": "pokeball", "amount": 5 } },
    { "count": 30, "reward": { "type": "xp_multiplier", "value": 0.05 } },
    { "count": 50, "reward": { "type": "legendary_unlock", "group": "lake_trio" } },
    { "count": 80, "reward": { "type": "legendary_unlock", "group": "cover_legendary" } },
    { "count": 100, "reward": { "type": "party_slot", "amount": 1 } },
    { "count": 107, "reward": [
      { "type": "legendary_unlock", "group": "giratina" },
      { "type": "title", "name": "pokedex_master" }
    ] }
  ],
  "type_master": {
    "reward_per_type": { "type": "xp_type_bonus", "multiplier": 1.2 },
    "types_mastered_3": { "type": "legendary_unlock", "group": "bonus_legendary" }
  },
  "chain_completion": {
    "reward_per_chain": { "type": "pokeball", "amount": 2 }
  },
  "legendary_groups": {
    "lake_trio": { "pick": 1, "pool": ["mesprit", "azelf", "uxie"] },
    "cover_legendary": { "pick": 1, "pool": ["dialga", "palkia"] },
    "giratina": { "pick": 1, "pool": ["giratina"], "direct": true },
    "bonus_legendary": { "pick": 1, "pool": ["heatran", "regigigas"] }
  }
}
```

#### State Changes

- `state.pokedex_milestones_claimed: string[]` — e.g., `["milestone_10", "milestone_30"]`.
- `state.type_masters: string[]` — e.g., `["fire", "water"]`.
- `state.legendary_pool: string[]` — legendary pokémon currently in encounter pool.
- `state.legendary_pending: { group: string, options: string[] }[]` — groups awaiting user selection.

### M3-B. Party Management

#### New Commands

| Command | Description |
|---------|-------------|
| `/tkm party swap <slot> <pokemon>` | One-step slot replacement |
| `/tkm box` | List all non-party pokémon with level, type, evolution status |
| `/tkm box --sort <level\|type\|name>` | Sort box pokémon |
| `/tkm party suggest` | Recommend party composition for current region |
| `/tkm party reorder <from> <to>` | Move pokémon between slots |

#### `/tkm box`

```
$ /tkm box
> Storage (23 pokémon)
>   Bidoof      Lv.8   Normal           
>   Shinx       Lv.12  Electric         
>   Budew       Lv.15  Grass/Poison     ⚡ Can evolve
>   Eevee       Lv.25  Normal           ⚡ Can evolve (branching)
>   ...
> Use /tkm party add <name> to add to party
```

#### `/tkm party suggest`

```
$ /tkm party suggest
> Current region: Mountain (Rock/Ground types common)
> Recommended:
>   Empoleon    (Water/Steel)    — Type advantage ★★★
>   Roserade    (Grass/Poison)   — Type advantage ★★☆
>   Luxray      (Electric)       — Neutral        ★☆☆
```

Logic: Score each owned pokémon against the region's encounter pool type distribution. Rank by average type effectiveness.

#### `/tkm party swap`

```
$ /tkm party swap 3 luxray
> Slot 3: Roserade → Luxray
```

Atomic operation: removes current occupant to box, adds target from box to slot.

---

## Milestone Summary

| Milestone | Content Feature | QoL Feature | Key Deliverables |
|-----------|----------------|-------------|-----------------|
| **M1** | Branching Evolution | Notification System | `/tkm evolve`, `evolution_ready` state, session-start notifications, `/tkm notifications` |
| **M2** | Event Encounters | Dashboard & Stats | `events.json`, streak tracking, `/tkm dashboard`, `/tkm stats` |
| **M3** | Pokédex Rewards + Legendaries | Party Management | `pokedex-rewards.json`, legendary unlock flow, `/tkm legendary`, `/tkm box`, `/tkm party swap/suggest/reorder` |

## Implementation Order

M1 → M2 → M3 (sequential). Each milestone is independently shippable.

- M1 lays the foundation: branching evolution state + notification infra are prerequisites for M3's legendary notification.
- M2 adds streak/stats tracking that M3's milestone rewards can reference.
- M3 builds on top of both with the full reward + management system.
