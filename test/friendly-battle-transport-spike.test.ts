import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  FriendlyBattleTransportError,
  connectFriendlyBattleSpikeGuest,
  createFriendlyBattleSpikeHost,
} from '../src/friendly-battle/spike/tcp-direct.js';

async function reserveUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to reserve test port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe('friendly battle TCP direct transport spike', () => {
  it('supports host/join/ready/start and bidirectional action exchange on one machine', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        guestPlayerName: 'Guest',
      });

      try {
        const joined = await host.waitForGuestJoin(1_000);
        assert.equal(joined.guestPlayerName, 'Guest');

        assert.deepEqual(host.markHostReady(), {
          hostReady: true,
          guestReady: false,
          canStart: false,
        });

        assert.deepEqual(await guest.markReady(), {
          hostReady: true,
          guestReady: true,
          canStart: true,
        });

        assert.deepEqual(await host.waitUntilCanStart(1_000), {
          hostReady: true,
          guestReady: true,
          canStart: true,
        });

        await host.startBattle();
        await guest.waitForStarted(1_000);

        const guestAction = await guest.submitAction('move:1');
        assert.equal(guestAction.actor, 'guest');
        assert.equal(guestAction.value, 'move:1');

        const hostObservedGuestAction = await host.waitForGuestAction(1_000);
        assert.deepEqual(hostObservedGuestAction, guestAction);

        const hostAction = host.submitHostAction('move:2');
        assert.equal(hostAction.actor, 'host');
        assert.equal(hostAction.value, 'move:2');

        const guestObservedHostAction = await guest.waitForHostAction(1_000);
        assert.deepEqual(guestObservedHostAction, hostAction);
        assert.deepEqual(host.getActionLog(), [guestAction, hostAction]);
      } finally {
        await guest.close();
      }
    } finally {
      await host.close();
    }
  });

  it('returns an actionable error when the host is unreachable', async () => {
    const unusedPort = await reserveUnusedPort();

    await assert.rejects(
      connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: unusedPort,
        sessionCode: 'alpha-123',
        guestPlayerName: 'Guest',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FriendlyBattleTransportError);
        assert.equal(error.code, 'connection_failed');
        assert.match(error.message, /host.*실행|주소|포트/i);
        return true;
      },
    );
  });

  it('lets the host wait for guest readiness instead of relying on a fixed delay', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        guestPlayerName: 'Guest',
      });

      try {
        await host.waitForGuestJoin(1_000);
        host.markHostReady();

        await assert.rejects(
          host.startBattle(),
          (error: unknown) => {
            assert.ok(error instanceof FriendlyBattleTransportError);
            assert.equal(error.code, 'not_ready');
            return true;
          },
        );

        const canStartPromise = host.waitUntilCanStart(1_000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await guest.markReady();

        assert.deepEqual(await canStartPromise, {
          hostReady: true,
          guestReady: true,
          canStart: true,
        });
      } finally {
        await guest.close();
      }
    } finally {
      await host.close();
    }
  });

  it('fails readiness wait immediately when a joined guest disconnects before ready', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        guestPlayerName: 'Guest',
      });

      await host.waitForGuestJoin(1_000);
      host.markHostReady();

      const readinessPromise = host.waitUntilCanStart(1_000);
      await guest.close();

      await assert.rejects(
        readinessPromise,
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'socket_closed');
          assert.match(error.message, /연결이 종료/);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  it('returns an actionable error when the host cannot bind the requested port', async () => {
    const occupiedServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = occupiedServer.address();
    assert.ok(address && typeof address !== 'string', 'expected occupied server to have a TCP address');

    try {
      await assert.rejects(
        createFriendlyBattleSpikeHost({
          host: '127.0.0.1',
          port: address.port,
          sessionCode: 'alpha-123',
          hostPlayerName: 'Host',
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'listen_failed');
          assert.match(error.message, /listen.*포트|사용 중|host 주소/i);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects a join attempt with the wrong session code and explains what to fix', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      hostPlayerName: 'Host',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'wrong-code',
          guestPlayerName: 'Guest',
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'bad_session_code');
          assert.match(error.message, /session code|세션 코드/i);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  it('keeps the host available after a wrong session code so the guest can retry', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      hostPlayerName: 'Host',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'wrong-code',
          guestPlayerName: 'Guest',
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'bad_session_code');
          return true;
        },
      );

      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        guestPlayerName: 'Guest',
      });

      try {
        const joined = await host.waitForGuestJoin(1_000);
        assert.equal(joined.guestPlayerName, 'Guest');
      } finally {
        await guest.close();
      }
    } finally {
      await host.close();
    }
  });
});
