import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PvpWsOutboundEnvelope } from '../src/server/ws/index.js';
import type { ViewerVisibleState } from '../src/server/battle/index.js';
import {
  applyPvpTransportEnvelope,
  createPvpClientCommand,
  createPvpClientState,
} from '../src/pvp/index.js';

const BASE_VISIBLE_STATE: ViewerVisibleState = {
  self: {
    active: {
      slot: 1,
      speciesId: '001',
      nickname: 'Bulba',
      levelActual: 55,
      levelEffective: 52,
      hp: 120,
      hpMax: 120,
      status: null,
      fainted: false,
      moves: [
        { slot: 1, id: 'tackle', disabled: false, currentPp: 35 },
        { slot: 2, id: 'growl', disabled: false, currentPp: 40 },
      ],
    },
    bench: [
      { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
      { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: false },
    ],
  },
  opponent: {
    active: {
      slot: 1,
      speciesId: '133',
      nickname: 'Eevee',
      levelActual: 54,
      levelEffective: 52,
      hp: 110,
      hpMax: 110,
      status: null,
      fainted: false,
    },
    benchCount: 2,
  },
};

function cloneVisibleState(): ViewerVisibleState {
  return {
    self: {
      active: { ...BASE_VISIBLE_STATE.self.active },
      bench: BASE_VISIBLE_STATE.self.bench.map((entry) => ({ ...entry })),
    },
    opponent: {
      active: { ...BASE_VISIBLE_STATE.opponent.active },
      benchCount: BASE_VISIBLE_STATE.opponent.benchCount,
    },
  };
}

function makeSnapshot(seq = 1): PvpWsOutboundEnvelope {
  return {
    type: 'room.snapshot',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      roomStatus: 'in_progress',
      battleStatus: 'awaiting_actions',
      generation: 'gen4',
      rulesetKey: 'tkm-friendly-gen4-v1',
      yourSeat: 'host',
      turn: 3,
      visibleState: cloneVisibleState(),
      pendingRequest: {
        kind: 'choose_move_or_switch',
        deadlineMs: 30_000,
        commandSubmitted: false,
      },
    },
  };
}

function makeActionRequest(seq = 2): PvpWsOutboundEnvelope {
  return {
    type: 'battle.request_action',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      turn: 3,
      phase: 'awaiting_actions',
      requestId: 'req-turn-3',
      deadlineMs: 25_000,
      request: {
        kind: 'choose_move_or_switch',
        activePokemon: { ...cloneVisibleState().self.active },
        availableMoves: [
          { slot: 1, id: 'tackle', disabled: false, currentPp: 35 },
          { slot: 2, id: 'growl', disabled: false, currentPp: 40 },
        ],
        availableSwitches: [
          { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
          { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: false },
        ],
      },
    },
  };
}

describe('pvp client protocol', () => {
  it('applies battle events through the session store', () => {
    const result = applyPvpTransportEnvelope(createPvpClientState(), makeSnapshot());

    assert.equal(result.outbound.length, 0);
    assert.equal(result.state.session.roomId, 'room_000001');
    assert.equal(result.state.session.pendingRequest?.kind, 'choose_move_or_switch');
    assert.equal(result.state.lastTransportMessageType, 'room.snapshot');
    assert.equal(result.state.lastTransportMessageAt, '2026-04-11T10:00:01.000Z');
  });

  it('answers ws.ping with ws.pong and tracks timestamps', () => {
    const result = applyPvpTransportEnvelope(
      createPvpClientState(),
      {
        type: 'ws.ping',
        sentAt: '2026-04-11T10:05:00.000Z',
      },
      {
        pongSentAt: '2026-04-11T10:05:00.123Z',
      },
    );

    assert.deepEqual(result.outbound, [{ type: 'ws.pong', sentAt: '2026-04-11T10:05:00.123Z' }]);
    assert.equal(result.state.lastTransportMessageType, 'ws.ping');
    assert.equal(result.state.lastTransportMessageAt, '2026-04-11T10:05:00.000Z');
    assert.equal(result.state.lastPingAt, '2026-04-11T10:05:00.000Z');
    assert.equal(result.state.lastPongSentAt, '2026-04-11T10:05:00.123Z');
  });

  it('records ws.error envelopes as transport errors', () => {
    const result = applyPvpTransportEnvelope(createPvpClientState(), {
      type: 'ws.error',
      sentAt: '2026-04-11T10:06:00.000Z',
      code: 'PVP_WS_BAD_MESSAGE',
      message: 'invalid envelope',
      retryable: true,
      details: { field: 'payload.type' },
    });

    assert.equal(result.outbound.length, 0);
    assert.equal(result.state.lastTransportMessageType, 'ws.error');
    assert.equal(result.state.lastTransportError?.code, 'PVP_WS_BAD_MESSAGE');
    assert.equal(result.state.lastTransportError?.message, 'invalid envelope');
    assert.deepEqual(result.state.lastTransportError?.details, { field: 'payload.type' });
  });

  it('creates battle.command envelopes through the session-store wrapper', () => {
    const snapshot = applyPvpTransportEnvelope(createPvpClientState(), makeSnapshot()).state;
    const actionable = applyPvpTransportEnvelope(snapshot, makeActionRequest()).state;

    const result = createPvpClientCommand(actionable, {
      clientCommandId: 'cmd-1',
      sentAt: '2026-04-11T10:00:03.000Z',
      command: {
        type: 'choose_move',
        moveSlot: 1,
      },
    });

    assert.equal(result.envelope.type, 'battle.command');
    assert.equal(result.envelope.roomId, 'room_000001');
    assert.equal(result.envelope.battleId, 'battle_000001');
    assert.equal(result.envelope.payload.clientCommandId, 'cmd-1');
    assert.deepEqual(result.envelope.payload.command, {
      type: 'choose_move',
      moveSlot: 1,
    });
    assert.equal(result.state.session.pendingCommand?.clientCommandId, 'cmd-1');
    assert.equal(result.state.session.pendingCommand?.status, 'created');
    assert.equal(result.state.session.nextClientSeq, 2);
  });
});
