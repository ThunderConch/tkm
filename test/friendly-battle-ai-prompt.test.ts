import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAiActionChoice, renderAiActionPrompt } from '../src/friendly-battle/ai-prompt.js';
import type { FogState, FriendlyBattleLiveBattleState } from '../src/friendly-battle/contracts.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures', 'friendly-battle-ai-prompt.md');

const liveState: FriendlyBattleLiveBattleState = {
  host: {
    active: {
      pokemonId: 483,
      name: 'Dialga',
      level: 53,
      hp: 169,
      maxHp: 169,
      fainted: false,
      moves: [
        { index: 1, moveId: 337, nameKo: '용의파동', pp: 10, maxPp: 10, disabled: false },
        { index: 2, moveId: 232, nameKo: '파동탄', pp: 20, maxPp: 20, disabled: false },
      ],
    },
    party: [
      { index: 1, pokemonId: 483, name: 'Dialga', level: 53, hp: 169, maxHp: 169, fainted: false },
      { index: 2, pokemonId: 448, name: 'Lucario', level: 50, hp: 88, maxHp: 140, fainted: false },
      { index: 3, pokemonId: 149, name: 'Dragonite', level: 49, hp: 0, maxHp: 155, fainted: true },
    ],
  },
  guest: {
    active: {
      pokemonId: 445,
      name: 'Garchomp',
      level: 52,
      hp: 120,
      maxHp: 180,
      fainted: false,
      moves: [],
    },
    party: [
      { index: 1, pokemonId: 445, name: 'Garchomp', level: 52, hp: 120, maxHp: 180, fainted: false },
      { index: 2, pokemonId: 248, name: 'Tyranitar', level: 50, hp: 90, maxHp: 170, fainted: false },
      { index: 3, pokemonId: 212, name: 'Scizor', level: 49, hp: 0, maxHp: 150, fainted: true },
    ],
  },
};

const fogState: FogState = {
  opponentActive: {
    species: 'Garchomp',
    level: 52,
    hpPercent: 67,
    visibleStatus: null,
    revealedMoves: ['Earthquake', 'Dragon Claw'],
  },
  opponentBenchRevealed: [
    { species: 'Tyranitar', level: 50, hpPercent: 53 },
  ],
  opponentBenchHidden: 1,
};

describe('friendly-battle ai prompt', () => {
  it('renders the explicit ai prompt byte-for-byte against the fixture', () => {
    const rendered = renderAiActionPrompt({
      role: 'host',
      liveState,
      fogState,
      moveOptions: liveState.host.active.moves.map((move) => ({
        index: move.index,
        nameKo: move.nameKo,
        pp: move.pp,
        maxPp: move.maxPp,
        disabled: move.disabled,
      })),
      partyOptions: liveState.host.party.map((entry) => ({
        index: entry.index,
        name: entry.name,
        hp: entry.hp,
        maxHp: entry.maxHp,
        fainted: entry.fainted,
      })),
    });

    assert.equal(rendered, readFileSync(FIXTURE_PATH, 'utf8'));
  });

  it('parses move choices', () => {
    assert.equal(parseAiActionChoice('move:1', { moveCount: 4, partyCount: 6 }), 'move:1');
  });

  it('parses switch choices', () => {
    assert.equal(parseAiActionChoice('switch:3', { moveCount: 4, partyCount: 6 }), 'switch:3');
  });

  it('parses surrender choices case-insensitively', () => {
    assert.equal(parseAiActionChoice('SURRENDER', { moveCount: 4, partyCount: 6 }), 'surrender');
  });

  it('normalizes surrounding whitespace', () => {
    assert.equal(parseAiActionChoice('  move:2  ', { moveCount: 4, partyCount: 6 }), 'move:2');
  });

  it('rejects move indexes below range', () => {
    assert.equal(parseAiActionChoice('move:0', { moveCount: 4, partyCount: 6 }), null);
  });

  it('rejects move indexes above range', () => {
    assert.equal(parseAiActionChoice('move:5', { moveCount: 4, partyCount: 6 }), null);
  });

  it('rejects switch indexes above range', () => {
    assert.equal(parseAiActionChoice('switch:7', { moveCount: 4, partyCount: 6 }), null);
  });

  it('rejects malformed multi-line responses', () => {
    assert.equal(parseAiActionChoice('move:1\nbecause it is strong', { moveCount: 4, partyCount: 6 }), null);
  });

  it('rejects unknown formats', () => {
    assert.equal(parseAiActionChoice('attack 1', { moveCount: 4, partyCount: 6 }), null);
  });
});
