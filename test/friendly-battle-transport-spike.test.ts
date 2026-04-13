import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRIENDLY_BATTLE_PROTOCOL_VERSION,
  type FriendlyBattleBattleEvent,
} from '../src/friendly-battle/contracts.js';
import {
  FriendlyBattleTransportError,
  connectFriendlyBattleSpikeGuest,
  createFriendlyBattleSpikeHost,
} from '../src/friendly-battle/spike/tcp-direct.js';
import { buildFriendlyBattlePartySnapshot } from '../src/friendly-battle/snapshot.js';
import { makeConfig, makeState } from './helpers.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_GENERATION = 'gen4';

function makeGuestSnapshot(options: {
  generation?: string;
  snapshotId?: string;
} = {}) {
  return buildFriendlyBattlePartySnapshot({
    config: makeConfig({ party: ['387'] }),
    state: makeState({
      pokemon: {
        '387': {
          id: 387,
          xp: 100,
          level: 16,
          friendship: 0,
          ev: 0,
          moves: [33, 45],
        },
      },
    }),
    generation: options.generation ?? DEFAULT_GENERATION,
    pluginRoot,
    snapshotId: options.snapshotId ?? 'guest-snapshot-001',
    createdAt: '2026-04-12T12:34:56.000Z',
  });
}

function createInitialBattleEvents(battleId: string): FriendlyBattleBattleEvent[] {
  return [
    {
      type: 'battle_initialized',
      battleId,
      turn: 1,
    },
    {
      type: 'choices_requested',
      turn: 1,
      waitingFor: ['guest'],
      phase: 'waiting_for_choices',
    },
  ];
}

function createResolvedBattleEvents(): FriendlyBattleBattleEvent[] {
  return [
    {
      type: 'turn_resolved',
      turn: 1,
      messages: ['authoritative spike transport resolved turn 1'],
      waitingFor: [],
      nextPhase: 'completed',
      winner: 'host',
    },
    {
      type: 'battle_finished',
      winner: 'host',
      reason: 'completed',
    },
  ];
}

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

async function createHelloAckHost(options: {
  protocolVersion?: number;
  generation?: string;
}) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => {
      sockets.delete(socket);
    });

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) break;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        const message = JSON.parse(line) as { type?: string };
        if (message.type !== 'hello') continue;

        socket.write(
          `${JSON.stringify({
            type: 'hello_ack',
            protocolVersion: options.protocolVersion ?? FRIENDLY_BATTLE_PROTOCOL_VERSION,
            generation: options.generation ?? DEFAULT_GENERATION,
            hostPlayerName: 'Host',
            readyState: {
              hostReady: false,
              guestReady: false,
              canStart: false,
            },
          })}\n`,
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to create hello_ack host');
  }

  return {
    port: address.port,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('friendly battle TCP direct transport spike', () => {
  it('supports host/join/ready/start and authoritative battle event exchange on one machine', async () => {
    const guestSnapshot = makeGuestSnapshot({ snapshotId: 'guest-snapshot-happy-path' });
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot,
      });

      try {
        const joined = await host.waitForGuestJoin(1_000);
        assert.equal(joined.guestPlayerName, 'Guest');
        assert.deepEqual(joined.guestSnapshot, guestSnapshot);

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

        const battleId = 'alpha-battle';
        await host.startBattle(battleId);
        const started = await guest.waitForStarted(1_000);
        assert.equal(started.type, 'battle_started');
        assert.ok(started.battleId === '' || started.battleId === battleId);

        const initialEvents = createInitialBattleEvents(battleId);
        assert.deepEqual(host.sendBattleEvents(initialEvents), initialEvents);
        assert.deepEqual(await guest.waitForBattleEvent(1_000), initialEvents[0]);
        assert.deepEqual(await guest.waitForBattleEvent(1_000), initialEvents[1]);

        const guestChoice = await guest.submitChoice('move:1');
        assert.equal(guestChoice.actor, 'guest');
        assert.deepEqual(guestChoice.choice, {
          type: 'move',
          moveIndex: 1,
        });

        const hostObservedGuestChoice = await host.waitForGuestChoice(1_000);
        assert.deepEqual(hostObservedGuestChoice, guestChoice);

        const resolvedEvents = createResolvedBattleEvents();
        assert.deepEqual(host.sendBattleEvents(resolvedEvents), resolvedEvents);
        assert.deepEqual(await guest.waitForBattleEvent(1_000), resolvedEvents[0]);
        assert.deepEqual(await guest.waitForBattleEvent(1_000), resolvedEvents[1]);

        assert.deepEqual(host.getSubmittedChoiceLog(), [guestChoice]);
        assert.deepEqual(host.getBattleEventLog(), [...initialEvents, ...resolvedEvents]);
      } finally {
        await guest.close();
      }
    } finally {
      await host.close();
    }
  });

  it('preserves a queued battle_started signal even if the guest waits slightly late', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-queued-start',
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-queued-start',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-queued-start' }),
      });

      try {
        await host.waitForGuestJoin(1_000);
        host.markHostReady();
        await guest.markReady();
        await host.waitUntilCanStart(1_000);

        await host.startBattle('alpha-queued-start-battle');
        await new Promise((resolve) => setTimeout(resolve, 25));
        await guest.waitForStarted(1_000);
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
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-unreachable-host' }),
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
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-ready-wait' }),
      });

      try {
        await host.waitForGuestJoin(1_000);
        host.markHostReady();

        await assert.rejects(
          host.startBattle('alpha-ready-check'),
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
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      const guest = await connectFriendlyBattleSpikeGuest({
        host: '127.0.0.1',
        port: host.connectionInfo.port,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-disconnect-before-ready' }),
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
          generation: DEFAULT_GENERATION,
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

  it('rejects wildcard advertise hosts so the guest-facing join info stays concrete', async () => {
    for (const advertiseHost of ['0.0.0.0', '::']) {
      await assert.rejects(
        createFriendlyBattleSpikeHost({
          host: '127.0.0.1',
          advertiseHost,
          port: 0,
          sessionCode: 'alpha-123',
          generation: DEFAULT_GENERATION,
          hostPlayerName: 'Host',
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'advertise_host_required');
          assert.match(error.message, /--join-host/i);
          assert.match(error.message, /wildcard/i);
          return true;
        },
      );
    }
  });

  it('rejects a join attempt with the wrong session code and explains what to fix', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-123',
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'wrong-code',
          generation: DEFAULT_GENERATION,
          guestPlayerName: 'Guest',
          guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-wrong-code' }),
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
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'wrong-code',
          generation: DEFAULT_GENERATION,
          guestPlayerName: 'Guest',
          guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-wrong-code-retry' }),
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
        generation: DEFAULT_GENERATION,
        guestPlayerName: 'Guest',
        guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-retry-success' }),
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

  it('requires an advertised join host when listening on a wildcard address', async () => {
    await assert.rejects(
      createFriendlyBattleSpikeHost({
        host: '0.0.0.0',
        port: 0,
        sessionCode: 'alpha-123',
        generation: DEFAULT_GENERATION,
        hostPlayerName: 'Host',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FriendlyBattleTransportError);
        assert.equal(error.code, 'advertise_host_required');
        assert.match(error.message, /--join-host|advertise/i);
        assert.match(error.message, /0\.0\.0\.0/);
        return true;
      },
    );
  });

  it('advertises the guest-facing join host separately from the listen host', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '0.0.0.0',
      advertiseHost: '192.168.0.24',
      port: 0,
      sessionCode: 'alpha-123',
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    try {
      assert.equal(host.connectionInfo.host, '192.168.0.24');
      assert.equal(host.connectionInfo.listenHost, '0.0.0.0');
      assert.match(host.connectionInfo.joinHint, /--host 192\.168\.0\.24 /);
      assert.match(host.connectionInfo.joinHint, /--generation gen4$/);
    } finally {
      await host.close();
    }
  });

  it('rejects hello_ack when the host reports an unsupported protocol version', async () => {
    const host = await createHelloAckHost({
      protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION + 1,
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.port,
          sessionCode: 'alpha-unsupported-protocol',
          generation: DEFAULT_GENERATION,
          guestPlayerName: 'Guest',
          guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-unsupported-protocol' }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'unsupported_protocol');
          assert.match(error.message, /protocol version/i);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  it('rejects hello_ack when the host generation does not match the guest generation', async () => {
    const host = await createHelloAckHost({
      generation: 'gen5',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.port,
          sessionCode: 'alpha-hello-ack-generation-mismatch',
          generation: DEFAULT_GENERATION,
          guestPlayerName: 'Guest',
          guestSnapshot: makeGuestSnapshot({ snapshotId: 'guest-snapshot-hello-ack-generation-mismatch' }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'generation_mismatch');
          assert.match(error.message, /generation|세대/i);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  it('rejects a join attempt when the guest generation does not match the host generation', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-generation-mismatch',
      generation: 'gen4',
      hostPlayerName: 'Host',
    });

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'alpha-generation-mismatch',
          generation: 'gen5',
          guestPlayerName: 'Guest',
          guestSnapshot: makeGuestSnapshot({
            generation: 'gen5',
            snapshotId: 'guest-snapshot-generation-mismatch',
          }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'generation_mismatch');
          assert.match(error.message, /generation|세대/i);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  it('rejects a join attempt when the guest snapshot is invalid', async () => {
    const host = await createFriendlyBattleSpikeHost({
      host: '127.0.0.1',
      port: 0,
      sessionCode: 'alpha-invalid-snapshot',
      generation: DEFAULT_GENERATION,
      hostPlayerName: 'Host',
    });

    const invalidSnapshot = makeGuestSnapshot({
      snapshotId: 'guest-snapshot-invalid',
    });
    invalidSnapshot.partySize = 99;

    try {
      await assert.rejects(
        connectFriendlyBattleSpikeGuest({
          host: '127.0.0.1',
          port: host.connectionInfo.port,
          sessionCode: 'alpha-invalid-snapshot',
          generation: DEFAULT_GENERATION,
          guestPlayerName: 'Guest',
          guestSnapshot: invalidSnapshot,
        }),
        (error: unknown) => {
          assert.ok(error instanceof FriendlyBattleTransportError);
          assert.equal(error.code, 'invalid_guest_snapshot');
          assert.match(error.message, /snapshot/i);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });
});
