# Tokenmon v0.1.0 Implementation Plan

> Collection Expansion + QoL — 3 milestones, sequential delivery

**Spec**: `docs/spec-v0.1.0-collection-qol.md`
**Base version**: v0.0.3 (335 passing tests)
**Target**: v0.1.0

---

## RALPLAN-DR Summary

### Principles

1. **Additive-only changes** — Every new feature extends existing modules; no rewrites of stable v0.0.3 code.
2. **State backward-compatibility** — New state fields have defaults; old save files load without migration scripts.
3. **i18n parity** — Every user-facing string added to both `ko.json` and `en.json` before merge.
4. **Test-first for game logic** — Core modules (evolution, encounter, rewards) get unit tests before CLI wiring.
5. **Milestone isolation** — Each milestone is independently shippable; no cross-milestone hard dependencies within a milestone's PR.

### Decision Drivers

1. **State schema stability** — The `State` and `Config` interfaces are the shared contract between hooks, CLI, and core. Changes here ripple everywhere.
2. **Evolution system complexity** — Branching evolution is the highest-risk change because it modifies the auto-evolution path that every session-start/stop hook triggers.
3. **Data file additions** — New JSON files (`events.json`, `pokedex-rewards.json`) must be loaded, validated, and typed without breaking the existing `pokemon-data.ts` loader pattern.

### Viable Options

#### Option A: Monolithic milestone PRs (1 PR per milestone)

- **Pros**: Fewer PRs to review; milestone coherence is obvious; simpler branch management.
- **Cons**: Large diffs (500-800 lines per PR); harder to bisect regressions; longer review cycles.

#### Option B: Task-level PRs (1 PR per task, ~6-8 PRs per milestone)

- **Pros**: Small focused diffs (100-200 lines); easy to review and revert; parallelizable by multiple agents.
- **Cons**: More PRs to manage; potential merge conflicts between concurrent tasks; overhead of branch hygiene.

**Chosen: Option A with risk-based splits** — Monolithic milestone PRs as default, but split high-risk milestones into two PRs:
- **M1**: PR1 = M1-1 + M1-2 (data + evolution logic, core engine), PR2 = M1-3 through M1-6 (CLI + notifications + hooks). This isolates the highest-risk evolution change into a reviewable, revertible unit.
- **M2, M3**: Single PR each (lower risk).

---

## State Schema Changes (All Milestones)

These changes apply to `src/core/types.ts` (`State` interface) and `src/core/state.ts` (defaults). All new fields use safe defaults so existing save files load without error.

### M1 additions

```
State.notifications: Notification[]              // default: []
State.dismissed_notifications: string[]           // default: []
State.last_known_regions: number                  // default: 1 (initial unlocked region count)

PokemonState.evolution_ready?: boolean            // default: undefined (falsy)
PokemonState.evolution_options?: string[]          // default: undefined

Config.notifications?: boolean                     // default: true
```

### M2 additions

```
State.stats: Stats                                // default: zero-initialized Stats object
State.events_triggered: string[]                  // default: [] (one-time events already claimed)

// Stats interface (new)
Stats.streak_days: number
Stats.longest_streak: number
Stats.last_active_date: string                    // ISO date
Stats.weekly_xp: number
Stats.weekly_battles_won: number
Stats.weekly_battles_lost: number
Stats.weekly_catches: number
Stats.weekly_encounters: number
Stats.total_xp_earned: number
Stats.total_battles_won: number
Stats.total_battles_lost: number
Stats.total_catches: number
Stats.total_encounters: number
Stats.last_reset_week: string                    // ISO week string (e.g., "2026-W14") for weekly reset detection
```

### M3 additions

```
State.pokedex_milestones_claimed: string[]        // default: []
State.type_masters: string[]                      // default: []
State.legendary_pool: string[]                    // default: []
State.legendary_pending: LegendaryPending[]       // default: []
State.titles: string[]                            // default: [] (earned titles like "pokedex_master")

// LegendaryPending interface (new)
LegendaryPending.group: string
LegendaryPending.options: string[]
```

### PokemonData changes (pokemon.json schema)

```
PokemonData.evolves_to?: string | BranchEvolution[]   // new field for branching

// BranchEvolution interface (new)
BranchEvolution.name: string                           // target pokemon ID
BranchEvolution.condition: object                      // condition descriptor
```

### ADR: `line[]`/`stage` vs `evolves_to` for evolution lookup

**Context**: The current evolution system uses `line[stage + 1]` for linear evolution lookup (`evolution.ts:18-21`). This cannot express branching evolution (e.g., Kirlia → Gardevoir or Gallade).

**Decision**: `evolves_to` overrides `line[]` when present.
- When `evolves_to` is defined (string or array), evolution check uses `evolves_to` instead of `line[stage + 1]`.
- `line[]` remains for display purposes only (pokédex chain view, chain completion tracking).
- For pokemon without `evolves_to`, existing `line[]`/`stage` behavior is unchanged.

**Branching scope (v0.1.0)**: Gen 4 natives only — Kirlia→Gardevoir/Gallade, Snorunt→Glalie/Froslass, Burmy 3 forms. Eevee (#133) is out of scope (not in Gen 4 dataset, deferred to future Gen 1-3 expansion).

**Spec divergence note**: The spec defines `evolves_to` as `string | string[]` (plain ID arrays). The plan extends this to `string | BranchEvolution[]` (objects with `name` and `condition` fields) to embed evolution conditions directly in the data rather than hardcoding them in logic. This is an intentional improvement — the spec should be updated to reflect `BranchEvolution[]`.

**Consequences**:
- Two evolution code paths: legacy (`line[]`) and new (`evolves_to`). The legacy path is untouched for backward compatibility.
- Future work: migrate all pokemon to `evolves_to` and deprecate `line[]`-based evolution lookup.

---

## Milestone 1: Branching Evolution + Notification System

### Task M1-1: Branching evolution data + types (Size: M)

**Files to modify:**
- `src/core/types.ts` — Add `BranchEvolution`, extend `PokemonData` with `evolves_to`, extend `PokemonState` with `evolution_ready` / `evolution_options`
- `data/pokemon.json` — Two categories of changes:
  - **NEW entries to ADD** (not in dataset): Ralts (#280), Kirlia (#281), Gardevoir (#282), Snorunt (#361), Glalie (#362). Must include full data: name, types, base_stats, rarity, region assignment, exp_group, line, stage.
  - **EXISTING entries to MODIFY**: Gallade (#475) — update `line` to include pre-evos `["280","281","475"]`, add `evolves_to` is not needed (Gallade is a target, not a source). Froslass (#478) — same treatment. Burmy (#412) — restructure from linear `[412,413,414]` to branching: add `evolves_to` array for Wormadam (#413) / Mothim (#414).
  - **Add `evolves_to: BranchEvolution[]`** on: Kirlia (#281, → Gardevoir/Gallade), Snorunt (#361, → Glalie/Froslass), Burmy (#412, → Wormadam/Mothim).
  - (Eevee #133 is not in Gen 4 dataset; deferred to future Gen 1-3 expansion.)
  - **Note**: Adding 5 new pokemon changes the total from 107 to 112. M3-1 adds 8 legendary pokemon, bringing the total to 120. **Pokédex counting rule**: Legendary pokemon are **excluded** from milestone thresholds — milestones count only non-legendary pokemon. The "complete" milestone updates from 107 to 112 (all non-legendary). Legendaries are tracked in pokédex (seen/caught) but do not count toward milestone progress. Update both spec and `pokedex-rewards.json` accordingly.
- `src/core/pokemon-data.ts` — Update loader to handle `evolves_to: string | BranchEvolution[]`

**What to implement:**
- Type definitions for branching evolution (note: spec says `string[]` but plan uses `BranchEvolution[]` to embed conditions — this is an intentional enhancement over the spec, see ADR)
- Add 5 new pokemon entries to pokemon.json with full data
- Modify 3 existing entries (Gallade, Froslass line arrays; Burmy branching)
- Loader validation that `evolves_to` arrays reference valid pokemon IDs

**Acceptance criteria:**
- `getPokemonDB()` returns correctly typed data with `evolves_to` fields
- Existing single-path evolutions still work (no regression)
- All branching pokemon have valid condition objects

**Test strategy:** Unit tests for data loading; snapshot test for branching pokemon entries.

**i18n:** None (data only).

**Dependencies:** None.

---

### Task M1-2: Evolution logic for branching (Size: L)

**Files to modify:**
- `src/core/evolution.ts` — Modify `checkEvolution()` to detect branching; add `checkBranchingEvolution()`, `getEligibleBranches()`, `applyBranchEvolution()`

**What to implement:**
- `checkEvolution()`: When `evolves_to` is an array, do NOT auto-evolve. Instead, set `evolution_ready = true` and `evolution_options = eligible branch names` on the PokemonState.
- `getEligibleBranches(pokemonName, context)`: Filter branches by condition (friendship, time-of-day, item, region, etc.). Return `{ name, conditionMet: boolean, conditionLabel: string }[]`.
- `applyBranchEvolution(state, config, pokemonName, targetName)`: Execute the chosen evolution — same as `applyEvolution()` but for user-selected target. Clear `evolution_ready` and `evolution_options`.
- Preserve existing single-path auto-evolution unchanged.

**Acceptance criteria:**
- Single-path evolution: unchanged behavior (auto on level-up)
- Branching evolution: pokemon enters `evolution_ready` state, no auto-evolve
- `getEligibleBranches()` correctly filters by condition
- `applyBranchEvolution()` updates state, config party, pokedex

**Test strategy:**
- Unit: `checkEvolution()` with branching data returns null (blocks auto-evolve) and sets flags
- Unit: `getEligibleBranches()` with various condition combos
- Unit: `applyBranchEvolution()` state mutations
- Regression: existing evolution.test.ts still passes

**i18n:** Condition labels for each branch type (en + ko): `"evolution.condition.friendship"`, `"evolution.condition.item"`, etc.

**Dependencies:** M1-1.

---

### Task M1-3: `/tkm evolve` CLI command (Size: M)

**Files to modify:**
- `src/cli/tokenmon.ts` — Add `cmdEvolve(pokemonName?, targetName?)` function and wire to command dispatch

**What to implement:**
- `/tkm evolve` (no args): List all pokemon in party/box with `evolution_ready = true`
- `/tkm evolve <pokemon>`: Show eligible branches with numbered list, condition status (met/not met). Prompt user to select.
- `/tkm evolve <pokemon> <target>`: Direct evolution to specified target (skip prompt).
- Confirmation even when only 1 branch is eligible.
- Lock-protected state mutation via `withLock()`.

**Acceptance criteria:**
- Running `/tkm evolve kirlia` shows numbered branch list with condition status
- Selecting a valid number executes evolution
- Invalid selection shows error
- Pokemon without `evolution_ready` shows "not ready" message

**Test strategy:** Integration test for CLI output format (mock stdin for interactive selection).

**i18n:** ~15 new keys: `cli.evolve.*` (title, prompt, condition_met, condition_not_met, selected, error_not_ready, error_invalid, confirm).

**Dependencies:** M1-2.

---

### Task M1-4: Notification system infrastructure (Size: L)

**Files to modify:**
- `src/core/types.ts` — Add `Notification` interface, extend `State` with `notifications` / `dismissed_notifications`, extend `Config` with `notifications` boolean
- `src/core/notifications.ts` — **NEW FILE** — Core notification logic
- `src/core/state.ts` — Add defaults for new fields
- `src/core/config.ts` — Add `notifications` default

**What to implement:**
- `Notification` type: `{ id: string, type: NotificationType, message: string, created: string, data?: object }`
- `NotificationType`: `'evolution_ready' | 'region_unlocked' | 'achievement_near' | 'legendary_unlocked'`
- `checkPendingNotifications(state, config)`: Scan state for conditions that should generate notifications. Return new notifications not already dismissed. Concrete trigger implementations:
  - `evolution_ready`: Scan `state.pokemon` for any with `evolution_ready === true`
  - `region_unlocked`: Compare current region count against `state.last_known_regions` (new field, default: initial region count). If more regions available now, generate notification.
  - `achievement_near`: For each unclaimed achievement, compute `current_progress / threshold`. If >= 0.9, notify. Requires reading achievement thresholds from `achievements.json`.
  - `legendary_unlocked`: Check if `state.legendary_pending` has any entries.
- `dismissNotification(state, id)` / `dismissAll(state)`: Mark as dismissed.
- `getActiveNotifications(state)`: Return non-dismissed notifications.
- Deduplication: same notification type+target shown once per session, repeated across sessions until resolved or dismissed.

**Acceptance criteria:**
- `checkPendingNotifications()` detects `evolution_ready` pokemon and returns notification
- Dismissed notifications are not re-shown
- Resolved conditions (evolution completed) auto-remove the notification
- `config.notifications = false` suppresses all notifications

**Test strategy:**
- Unit: notification generation for each event type
- Unit: dismiss/resolve lifecycle
- Unit: deduplication across sessions

**i18n:** ~8 keys: `notification.*` (evolution_ready, region_unlocked, achievement_near, legendary_unlocked, title, empty, cleared).

**Dependencies:** M1-2 (evolution_ready state).

---

### Task M1-5: Notification delivery in hooks + CLI (Size: M)

**Files to modify:**
- `src/hooks/session-start.ts` — Call `checkPendingNotifications()`, include in `system_message`
- `src/cli/tokenmon.ts` — Add `cmdNotifications(subcmd?)` for `/tkm notifications` and `/tkm notifications clear`

**What to implement:**
- Session-start hook: After existing achievement check, call `checkPendingNotifications()`. Format as part of stdout JSON `system_message`.
- CLI: `/tkm notifications` lists active notifications with icons. `/tkm notifications clear` dismisses all.
- Respect `config.notifications` setting.

**Acceptance criteria:**
- Session start outputs notifications in system_message when present
- `/tkm notifications` shows formatted list
- `/tkm notifications clear` empties the list
- `config.notifications = false` silences session-start output

**Test strategy:**
- Unit: session-start hook output includes notification text
- Integration: CLI output format

**i18n:** ~5 keys: `cli.notifications.*` (header, empty, cleared, clear_usage).

**Dependencies:** M1-4.

---

### Task M1-6: Help text + config key updates (Size: S)

**Files to modify:**
- `src/cli/tokenmon.ts` — Update `cmdHelp()` with evolve/notifications commands; add `notifications` to config set keys
- `src/i18n/en.json`, `src/i18n/ko.json` — All new keys from M1-2 through M1-5

**What to implement:**
- Update help text with evolve/notifications commands
- Add `notifications` to config set keys
- **i18n parity test**: Automated test that validates all keys in `en.json` exist in `ko.json` and vice versa. Fails on missing/extra keys.

**Acceptance criteria:**
- `/tkm help` lists evolve and notifications commands
- `/tkm config set notifications false` works
- All i18n keys present in both en.json and ko.json
- i18n parity test passes

**Dependencies:** M1-3, M1-5.

---

## Milestone 2: Event Encounters + Dashboard & Stats

### Task M2-1: Events data + types (Size: M)

**Files to create:**
- `data/events.json` — Time-of-day, day-of-week, streak event definitions per spec

**Files to modify:**
- `src/core/types.ts` — Add `EventsDB`, `TimeEvent`, `DayEvent`, `StreakEvent`, `Stats` interfaces; extend `State` with `stats` and `events_triggered`
- `src/core/pokemon-data.ts` — Add `getEventsDB()` loader
- `src/core/state.ts` — Add `stats` default (zero-initialized `Stats` object) with **deep-merge guard**: `stats: { ...DEFAULT_STATS, ...(parsed.stats ?? {}) }` to prevent partial stats objects from missing fields on upgrade.

**What to implement:**
- `events.json` with time_of_day, day_of_week, streak definitions from spec
- Type definitions for all event and stats types
- Loader with validation
- Deep-merge initializer for nested `Stats` object in `readState()`

**Acceptance criteria:**
- `getEventsDB()` returns typed event data
- `Stats` interface matches spec exactly
- Default state includes zero-initialized stats

**Test strategy:** Unit: loader returns valid data; schema validation.

**i18n:** Event labels from events.json are already bilingual (embedded `label.en` / `label.ko`).

**Dependencies:** M1 complete.

---

### Task M2-2: Streak tracking + stats accumulation (Size: M)

**Files to modify:**
- `src/hooks/session-start.ts` — Update streak calculation, increment stats
- `src/core/state.ts` — Weekly reset logic (check if Monday has passed)
- `src/hooks/stop.ts` — Update stats after battles/encounters (if not already tracked)

**What to implement:**
- `updateStreak(state)`: Compare `state.stats.last_active_date` to today. If consecutive day, increment `streak_days`. If gap, reset to 1. Update `longest_streak`. Update `last_active_date`.
- `resetWeeklyStats(state)`: If current week (Monday-based) differs from last recorded week, zero out `weekly_*` fields.
- Wire stats accumulation: `weekly_xp`, `weekly_battles_won/lost`, `weekly_catches`, `weekly_encounters` incremented alongside existing `battle_wins`, `catch_count`, etc.
- `total_xp_earned` accumulated from XP awards.

**Acceptance criteria:**
- Streak increments on consecutive days, resets on gap
- Weekly stats reset on Monday boundary
- All-time stats accumulate correctly
- No penalty for streak breaks (counter resets to 0, nothing lost)

**Test strategy:**
- Unit: streak logic with mocked dates (consecutive, gap, same day)
- Unit: weekly reset boundary
- Integration: session-start updates streak

**i18n:** None (internal state only).

**Dependencies:** M2-1.

---

### Task M2-3: Event encounter logic (Size: L)

**Files to modify:**
- `src/core/encounter.ts` — Modify `selectWildPokemon()` to apply event modifiers. **Breaking internal API change**: signature changes from `selectWildPokemon(config: Config)` to `selectWildPokemon(state: State, config: Config)`. Update caller in `processEncounter()` (encounter.ts:85).

**What to implement:**
- `getActiveEvents(state)`: Check current time/day/streak against events.json. Return list of active events.
- Modify `selectWildPokemon(state, config)` (updated signature):
  1. Determine base pool (existing)
  2. Call `getActiveEvents(state)` 
  3. Apply `type_boost` weights from time_of_day events (multiply rarity weight for matching types)
  4. Apply `rare_multiplier` from day_of_week events (multiply rare/legendary weights)
  5. If streak threshold met, force rare selection (override pool to rare-only)
  6. If milestone trigger (1M tokens), one-time special encounter (check `events_triggered`)
  7. Roll from modified weighted pool
- All modifications are additive (increase probability, never gate content)

**Acceptance criteria:**
- Night hours boost ghost/dark type weights
- Friday doubles rare encounter probability
- 7-day streak guarantees rare encounter
- Milestone encounters fire once only
- Base encounter behavior unchanged when no events active

**Test strategy:**
- Unit: `getActiveEvents()` with mocked time/date
- Unit: weight modification for each event type
- Unit: streak-forced rare selection
- Unit: milestone one-time guard
- Regression: existing encounter.test.ts passes

**i18n:** None (logic only; event labels already in events.json).

**Dependencies:** M2-2 (streak tracking).

---

### Task M2-4: `/tkm dashboard` command (Size: L)

**Files to modify:**
- `src/cli/tokenmon.ts` — Add `cmdDashboard()` function

**What to implement:**
- Box-drawing dashboard layout per spec:
  - Region + level range
  - Day streak + personal best
  - Pokedex progress (count + percentage)
  - Party list with level bars
  - Recent activity (7-day rolling from weekly stats)
  - Active events (from `getActiveEvents()`)
  - Pending notifications
- All text via i18n `t()` calls
- Respects terminal width (graceful degradation for narrow terminals)

**Acceptance criteria:**
- Dashboard renders all sections from spec
- Data matches actual state
- Box-drawing characters render correctly
- Language follows config setting

**Test strategy:** Snapshot test for dashboard output with known state.

**i18n:** ~20 keys: `cli.dashboard.*` (title, region, streak, pokedex, party, activity, events, xp_earned, battles, catches, entries).

**Dependencies:** M2-2, M2-3.

---

### Task M2-5: `/tkm stats` command (Size: S)

**Files to modify:**
- `src/cli/tokenmon.ts` — Add `cmdStats()` function

**What to implement:**
- Stats-only view (subset of dashboard): all-time stats, weekly stats, streak info
- Formatted output with i18n

**Acceptance criteria:**
- Shows all Stats fields in formatted output
- Weekly vs all-time clearly separated

**Test strategy:** Snapshot test.

**i18n:** ~10 keys: `cli.stats.*` (header, weekly_header, alltime_header, streak, xp, battles, catches, encounters).

**Dependencies:** M2-2.

---

### Task M2-6: Help + event display in session-start (Size: S)

**Files to modify:**
- `src/hooks/session-start.ts` — Show active events in system_message
- `src/cli/tokenmon.ts` — Update help with dashboard/stats commands

**Acceptance criteria:**
- Session start shows "Active event: Night Shift" when applicable
- Help lists dashboard and stats commands

**Dependencies:** M2-3, M2-4, M2-5.

---

## Milestone 3: Pokedex Rewards + Party Management

### Task M3-1: Pokedex rewards data + types (Size: M)

**Files to create:**
- `data/pokedex-rewards.json` — Milestone rewards, type master config, chain completion, legendary groups per spec

**Files to modify:**
- `src/core/types.ts` — Add `PokedexRewardsDB`, `MilestoneReward`, `LegendaryGroup`, `LegendaryPending` interfaces; extend `State` with `pokedex_milestones_claimed`, `type_masters`, `legendary_pool`, `legendary_pending`
- `src/core/pokemon-data.ts` — Add `getPokedexRewardsDB()` loader
- `src/core/state.ts` — Add defaults for new fields
- `data/pokemon.json` — Add legendary pokemon entries (Mesprit, Azelf, Uxie, Dialga, Palkia, Giratina, Heatran, Regigigas) with `rarity: "legendary"`

**Acceptance criteria:**
- `getPokedexRewardsDB()` returns typed reward data
- All legendary pokemon exist in pokemon.json with correct types/stats
- State defaults prevent crashes on old save files

**Test strategy:** Unit: loader validation; legendary pokemon data correctness.

**i18n:** Legendary pokemon names in both `data/i18n/ko.json` and `data/i18n/en.json` (note: these are data-level i18n files, separate from `src/i18n/`).

**Dependencies:** M2 complete.

---

### Task M3-2: Pokedex milestone reward engine (Size: L)

**Files to create:**
- `src/core/pokedex-rewards.ts` — **NEW FILE** — Reward checking and claiming logic

**Files to modify:**
- `src/core/battle.ts` — Wire type master 1.2x XP bonus into `resolveBattle()` / battle XP calculation
- `src/cli/tokenmon.ts` — Modify `/tkm pokedex --type` to show type master progress and status

**What to implement:**
- `checkMilestoneRewards(state, config)`: Compare `caught` count against milestones in pokedex-rewards.json. For unclaimed milestones where count >= threshold, apply reward and add to `pokedex_milestones_claimed`.
- Reward application by type:
  - `pokeball`: add to `state.items.pokeball`
  - `xp_multiplier`: add to `state.xp_bonus_multiplier`
  - `legendary_unlock`: add to `state.legendary_pending` (user picks later)
  - `party_slot`: increment `config.max_party_size`
  - `title`: add to new `state.titles` array
- `checkTypeMasters(state)`: For each type, check if all pokemon of that type are caught. Add to `state.type_masters`. At 3 types mastered, unlock bonus legendary group.
- `checkChainCompletion(state)`: For each evolution line, check if all members caught. Award pokeball x2 per completed chain.
- **Type master 1.2x battle XP bonus**: Wire into `src/core/battle.ts` — after calculating base battle XP, check `state.type_masters`. If the battling pokemon's type or the wild pokemon's type matches a mastered type, multiply battle XP by 1.2. This requires modifying `processEncounter()` in battle.ts to accept `state.type_masters`.
- **`/tkm pokedex --type` progress display**: Modify existing pokedex CLI command to show type master status and progress (e.g., "Fire: 8/12 caught" or "Fire: Type Master ✓ (1.2x XP)").
- Integration point: call from `session-start.ts` after pokedex sync.

**Acceptance criteria:**
- Milestone 10 caught -> 5 pokeballs
- Milestone 30 -> +5% XP multiplier
- Milestone 50 -> Lake Trio added to `legendary_pending`
- Milestone 80 -> Cover Legendary added to `legendary_pending`
- Milestone 100 -> party slot +1
- Milestone 112 (all non-legendary) -> Giratina direct + title
- Type master detection works
- Chain completion detection works
- Rewards only claimed once (idempotent)

**Test strategy:**
- Unit: each milestone reward type
- Unit: type master detection with partial/full coverage
- Unit: chain completion with partial/full chains
- Unit: idempotency (calling twice doesn't double rewards)

**i18n:** ~10 keys: `rewards.*` (milestone_reached, pokeball_reward, xp_multiplier_reward, legendary_unlock, party_slot, title_earned, type_master, chain_complete).

**Dependencies:** M3-1.

---

### Task M3-3: `/tkm legendary` command + legendary encounter flow (Size: L)

**Files to modify:**
- `src/cli/tokenmon.ts` — Add `cmdLegendary()` function
- `src/core/encounter.ts` — Add legendary pool to encounter selection

**What to implement:**
- `/tkm legendary`: Show pending legendary groups. If none pending, show already-claimed groups.
- For pending group: numbered list of options, user selects one. Selected pokemon joins party directly (via `withLock`). Remaining pokemon added to `state.legendary_pool`.
- `selectWildPokemon()` modification: After base pool selection, with low probability (e.g., 2%), check `legendary_pool`. If non-empty, substitute with random legendary from pool.
- Legendary encounters use standard battle/catch flow.
- If legendary is defeated, it stays in pool (per spec).

**Acceptance criteria:**
- `/tkm legendary` shows pending groups with descriptions
- Selection adds chosen pokemon to party and state
- Unchosen pokemon appear in encounter pool
- Legendary encounter probability is low but non-zero
- Defeated legendaries remain in pool

**Test strategy:**
- Unit: legendary selection state mutations
- Unit: encounter pool integration
- Unit: defeated legendary stays in pool
- Integration: CLI output

**i18n:** ~12 keys: `cli.legendary.*` (header, no_pending, group_label, choose_prompt, selected, pool_added, already_claimed).

**Dependencies:** M3-2.

---

### Task M3-4: Party management commands (Size: L)

**Files to modify:**
- `src/cli/tokenmon.ts` — Add `cmdBox()`, `cmdPartySwap()`, `cmdPartyReorder()`, `cmdPartySuggest()` functions

**What to implement:**
- `/tkm box`: List all non-party pokemon (from `state.unlocked` minus `config.party`). Show level, type, evolution status. Support `--sort level|type|name`.
- `/tkm party swap <slot> <pokemon>`: Atomic swap — current occupant goes to box, target comes from box to slot. Validate slot number, pokemon exists in box.
- `/tkm party reorder <from> <to>`: Move party member between slot positions.
- `/tkm party suggest`: Score each owned pokemon against current region's encounter pool type distribution. Rank by average type effectiveness. Show top recommendations with star ratings.
- All mutations via `withLock()`.

**Acceptance criteria:**
- `/tkm box` lists non-party pokemon with correct info
- `/tkm box --sort level` sorts by level descending
- `/tkm party swap 3 luxray` performs atomic swap
- `/tkm party reorder 1 3` moves slot 1 to slot 3
- `/tkm party suggest` shows type-advantage-based recommendations
- Edge cases: swap with full party, swap pokemon already in party, reorder same slot

**Test strategy:**
- Unit: box list generation
- Unit: swap state mutations
- Unit: reorder logic
- Unit: suggest scoring algorithm
- Edge case tests for invalid inputs

**i18n:** ~20 keys: `cli.box.*` (header, empty, sort_hint, can_evolve, can_evolve_branching), `cli.party.swap_*`, `cli.party.reorder_*`, `cli.party.suggest_*`.

**Dependencies:** M3-1 (legendary pokemon may appear in box).

---

### Task M3-5: Wire rewards into hooks + final integration (Size: M)

**Files to modify:**
- `src/hooks/session-start.ts` — Call `checkMilestoneRewards()`, `checkTypeMasters()`, `checkChainCompletion()` after pokedex sync
- `src/core/notifications.ts` — Add `legendary_unlocked` notification generation from `legendary_pending`
- `src/cli/tokenmon.ts` — Update help with all new commands

**What to implement:**
- Session-start: after incrementing session count and checking achievements, sync pokedex and check rewards. Generate notifications for new milestones/legendaries.
- Notification for legendary unlock triggers `/tkm legendary` hint.
- Update help text with box, swap, reorder, suggest, legendary commands.

**Acceptance criteria:**
- Session start auto-checks pokedex milestones
- New milestone -> notification in system_message
- Legendary unlock -> notification with `/tkm legendary` hint
- Help text complete for all v0.1.0 commands

**Test strategy:**
- Integration: session-start with state at milestone boundary
- Unit: notification generation for each reward type

**i18n:** ~5 keys for help entries.

**Dependencies:** M3-2, M3-3, M3-4.

---

## Task Ordering & Dependency Graph

```
M1-1 (data+types)
  └─> M1-2 (evolution logic)
        ├─> M1-3 (/tkm evolve CLI)
        └─> M1-4 (notification infra)
              └─> M1-5 (notification delivery)
                    └─> M1-6 (help + i18n finalize)

M2-1 (events data+types)
  └─> M2-2 (streak+stats)
        ├─> M2-3 (event encounter logic)
        │     └─> M2-6 (session-start events + help)
        ├─> M2-4 (/tkm dashboard)
        └─> M2-5 (/tkm stats)

M3-1 (rewards data+types)
  └─> M3-2 (reward engine)
        ├─> M3-3 (/tkm legendary)
        └─> M3-5 (hooks + integration)
  └─> M3-4 (party management)
        └─> M3-5
```

**Critical path**: M1-1 -> M1-2 -> M1-4 -> M1-5 -> M2-1 -> M2-2 -> M2-3 -> M3-1 -> M3-2 -> M3-5

**Parallelizable within milestones:**
- M1: Tasks M1-3 and M1-4 can run in parallel after M1-2
- M2: Tasks M2-4 and M2-5 can run in parallel after M2-2; M2-3 independent of M2-4/M2-5
- M3: Tasks M3-3 and M3-4 can run in parallel after M3-1

---

## Risk Areas & Mitigation

### Risk 1: Evolution logic regression (HIGH)

**Impact**: Breaking auto-evolution for the 100+ existing single-path pokemon.
**Mitigation**: 
- `checkEvolution()` change is a single branch: `if evolves_to is array -> new path, else -> existing path`.
- Run full existing `evolution.test.ts` suite as gate before merging M1-2.
- Add explicit regression test: "single-path pokemon still auto-evolves after branching code added."

### Risk 2: State schema bloat (MEDIUM)

**Impact**: State file grows significantly; read/write performance degrades.
**Mitigation**:
- New fields use primitives and small arrays (not nested objects).
- `Stats` is a flat struct (~15 numbers).
- `notifications` array is bounded (max ~10 active at any time, auto-pruned on resolution).

### Risk 3: Encounter weight math errors (MEDIUM)

**Impact**: Event modifiers could make encounters impossible (all weights zero) or trivial (always legendary).
**Mitigation**:
- Additive multipliers only (never subtract weight).
- Floor of 0.01 on any weight to prevent zero-probability.
- Cap total legendary probability at 10% even with all events stacked.
- Unit tests with extreme multiplier combinations.

### Risk 4: Interactive CLI in hook context (LOW)

**Impact**: `/tkm evolve` and `/tkm legendary` use readline for user input. If called from a non-interactive context, stdin hangs.
**Mitigation**:
- Direct-selection syntax (`/tkm evolve eevee leafeon`) bypasses interactive prompt.
- Document that interactive commands are for CLI use only, not hooks.

### Risk 5: i18n key drift (LOW)

**Impact**: Missing translations cause key-as-text fallback.
**Mitigation**:
- Each task specifies approximate key count.
- Final task per milestone includes i18n audit step.
- Add test: "all keys in en.json exist in ko.json and vice versa."

---

## Estimated Complexity Summary

| Task | Size | New Files | Modified Files | Est. New i18n Keys | Est. New Tests |
|------|------|-----------|----------------|-------------------|----------------|
| M1-1 | M | 0 | 3 | 0 | 5 |
| M1-2 | L | 0 | 1 | 8 | 12 |
| M1-3 | M | 0 | 1 | 15 | 5 |
| M1-4 | L | 1 | 3 | 8 | 10 |
| M1-5 | M | 0 | 2 | 5 | 5 |
| M1-6 | S | 0 | 3 | 0 | 2 |
| M2-1 | M | 1 | 3 | 0 | 5 |
| M2-2 | M | 0 | 3 | 0 | 8 |
| M2-3 | L | 0 | 1 | 0 | 12 |
| M2-4 | L | 0 | 1 | 20 | 3 |
| M2-5 | S | 0 | 1 | 10 | 2 |
| M2-6 | S | 0 | 2 | 5 | 2 |
| M3-1 | M | 1 | 4 | 10 | 5 |
| M3-2 | L | 1 | 2 | 10 | 15 |
| M3-3 | L | 0 | 2 | 12 | 8 |
| M3-4 | L | 0 | 1 | 20 | 12 |
| M3-5 | M | 0 | 3 | 5 | 5 |
| **Total** | | **4 new** | **~15 unique** | **~128** | **~116** |

---

## ADR: Architecture Decision Record

**Decision**: Implement v0.1.0 as 3 sequential milestones with monolithic PRs, extending existing module patterns.

**Drivers**:
1. State schema is the shared contract — changes must be backward-compatible.
2. Evolution system modification is highest risk — must be isolated and regression-tested.
3. Single-developer project — PR overhead should be minimized.

**Alternatives considered**:
- **Task-level PRs**: Rejected — overhead of 17 branches/PRs for a single developer outweighs review benefits.
- **Feature flags**: Considered for incremental rollout, but rejected because milestones are already independently shippable and the plugin has no multi-user deployment concern.
- **Separate notification microservice**: Rejected — over-engineering for a CLI plugin. Flat array in state is sufficient.

**Why chosen**: Monolithic milestone PRs match the project's scale (single developer, ~2k LOC, 335 tests). Each milestone is a natural shippable unit. The existing codebase patterns (pokemon-data loader, withLock mutations, i18n t() calls) are well-established and should be extended, not redesigned.

**Consequences**:
- Larger diffs per milestone (~500-800 lines) but fewer merge operations.
- If a milestone is blocked, subsequent milestones cannot begin (sequential dependency).
- State schema grows by ~20 fields total; acceptable for JSON file-based storage.

**Follow-ups**:
- After v0.1.0, evaluate whether state file size warrants lazy loading or splitting.
- i18n key parity test added in M1-6 (automated, not deferred to CI).
- **CLI extraction**: `tokenmon.ts` will exceed 1200 lines after all new commands. Recommend extracting to `src/cli/commands/*.ts` modules before or during M2. Non-blocking for v0.1.0 but strongly recommended to prevent monolith.
- Evaluate party suggest algorithm quality after real usage data.
