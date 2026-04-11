import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPvpOpsRoutes } from '../src/server/http/pvp-ops-routes.js';
import type { BattleDebugView } from '../src/server/battle/battle-types.js';

function makeDebugView(roomId = 'room_001'): BattleDebugView {
  return {
    roomId,
    battleId: 'battle_001',
    phase: 'waiting_for_commands',
    turn: 3,
    requestState: null,
    commands: [],
    events: [],
    timeouts: {
      host: {
        warnings: 0,
        consecutive: 0,
        lastDeadlineAt: null,
        lastTimedOutAt: null,
      },
      guest: {
        warnings: 1,
        consecutive: 1,
        lastDeadlineAt: '2026-04-11T09:30:00.000Z',
        lastTimedOutAt: '2026-04-11T09:30:05.000Z',
      },
    },
    result: null,
  };
}

test('ops debug route는 인증이 없으면 401을 반환한다', () => {
  const routes = createPvpOpsRoutes({
    getBattleDebugView: () => makeDebugView(),
  });

  const response = routes.getBattleDebug({
    params: { roomId: 'room_001' },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'PVP_UNAUTHORIZED');
});

test('ops debug route는 operator가 아니면 403을 반환한다', () => {
  const routes = createPvpOpsRoutes({
    getBattleDebugView: () => makeDebugView(),
  });

  const response = routes.getBattleDebug({
    auth: { playerId: 'player-1' },
    params: { roomId: 'room_001' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'PVP_OPERATOR_FORBIDDEN');
});

test('ops debug route는 roomId가 없으면 400을 반환한다', () => {
  const routes = createPvpOpsRoutes({
    getBattleDebugView: () => makeDebugView(),
  });

  const response = routes.getBattleDebug({
    auth: { playerId: 'ops-user', operator: true },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'PVP_INVALID_REQUEST');
});

test('ops debug route는 room을 찾지 못하면 404를 반환한다', () => {
  const routes = createPvpOpsRoutes({
    getBattleDebugView: () => undefined,
  });

  const response = routes.getBattleDebug({
    auth: { playerId: 'ops-user', operator: true },
    params: { roomId: 'missing_room' },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'PVP_BATTLE_DEBUG_NOT_FOUND');
});

test('ops debug route는 operator에게 battle debug view를 그대로 반환한다', () => {
  const expected = makeDebugView('room_live_777');
  const routes = createPvpOpsRoutes({
    getBattleDebugView: (roomId) => {
      assert.equal(roomId, 'room_live_777');
      return expected;
    },
  });

  const response = routes.getBattleDebug({
    auth: { playerId: 'ops-user', operator: true },
    params: { roomId: 'room_live_777' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, expected);
});
