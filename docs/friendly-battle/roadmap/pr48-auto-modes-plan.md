# PR48 — Friendly-battle heuristic + AI auto-pick modes

> Status: plan drafted, implementation delegated to Codex
> Base branch: `feat/friendly-battle-pvp-leave` (`8631e4c`)
> Head branch (new): `feat/friendly-battle-pvp-auto-modes`
> Authoritative behavior spec: `.omc/specs/deep-interview-pr48-heuristic-ai-modes.md`

## 1. Purpose

PR48 extends friendly battle with two non-manual control modes while preserving the existing remote PvP transport and engine boundaries:

- `heuristic`: daemon-side pure auto-pick
- `ai`: skill-side inline prompt/render/parse action selection

The goal is to let each side opt into a fixed battle-long player mode without redesigning transport, battle core, or the friendly-battle session model already established in PR43-PR47.

## 2. Non-goals

- engine-core changes under `src/core/**`
- Anthropic SDK or any new dependency
- gym / battle-tui / setup / hooks changes
- reconnect, persistence redesign, or dynamic mid-battle mode switching
- widening the protocol beyond `playerMode`, `liveState`, and `fogState`

## 3. Deliverables

### 3-1. Contracts and session record

- `src/friendly-battle/contracts.ts`
  - add `PlayerMode = 'manual' | 'heuristic' | 'ai' | 'local'`
  - add `FogState`
  - add optional `fogState` to battle envelopes that already carry optional `liveState`
- `src/friendly-battle/session-store.ts`
  - persist optional `playerMode`
  - validate it during record reads for backward compatibility

### 3-2. Heuristic decision module

- `src/friendly-battle/heuristic.ts`
  - pure `pickHeuristicAction(state, role): DaemonAction`
  - reuse `calculateDamage` from `src/core/turn-battle.ts`
  - priority order exactly matches the deep-interview spec
  - PP exhaustion falls through to Struggle/max-damage fallback

### 3-3. Fog derivation

- `src/friendly-battle/fog.ts`
  - pure `deriveFogState(state, role)`
  - helper accumulation path for turn/switch reveal state
  - revealed opponent moves and bench species preserved across envelopes

### 3-4. Daemon and CLI wiring

- `src/friendly-battle/daemon.ts`
  - persist `playerMode`
  - embed `fogState` alongside `liveState`
  - host heuristic short-circuit replaces the blocking local action wait
  - guest heuristic path reuses host-authored `liveState`
- `src/cli/friendly-battle-turn.ts`
  - `--init-host` / `--init-join` accept `--player-mode <manual|heuristic|ai>`
  - `--status` returns the chosen mode

### 3-5. Skill update

- `skills/friendly-battle/SKILL.md`
  - `open [heuristic|ai|local]`
  - `join [heuristic|ai] <code>@<host>:<port>`
  - manual path unchanged in spirit
  - heuristic path polls only
  - ai path renders the explicit one-line action prompt and parses `move:N | switch:N | surrender`

### 3-6. Tests

- heuristic unit tests (priority tiers, switching, surrender, PP exhaustion, edge cases)
- fog unit tests (reveal accumulation, hidden bench count, HP bucketing)
- AI prompt golden fixture + parser cases
- optional daemon heuristic integration smoke if low-risk

## 4. Task list

1. Add contract/session-store/player-mode plumbing.
2. Implement pure heuristic picker.
3. Implement fog derivation and accumulation helpers.
4. Wire daemon host/guest auto-pick behavior and envelope propagation.
5. Tighten CLI `--player-mode` surface.
6. Update `skills/friendly-battle/SKILL.md` to the new mode contract.
7. Add heuristic, fog, and AI prompt tests plus fixture.
8. Run `npm run build`.
9. Run `CI=1 npm test`.
10. Commit once and push the branch. No PR creation in this plan.

## 5. Success criteria

- `heuristic` host and guest paths submit only valid daemon actions
- `ai` mode consumes `liveState` + `fogState` and emits one of the allowed action tokens
- `playerMode` persists in session status output
- all new tests pass
- build and full suite are green
- branch is pushed without opening a PR

## 6. Risks

1. Guest heuristic must not invent a second battle engine; it should reconstruct only the minimal state needed from authoritative live envelopes.
2. Fog accumulation must preserve revealed information without leaking hidden opponent team data.
3. The skill prompt and parser must stay byte-stable enough for golden-fixture tests.
4. CLI mode validation must stay narrower than the broader skill-level `local` routing token.
