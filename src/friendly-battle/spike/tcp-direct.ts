import net from 'node:net';
import { FRIENDLY_BATTLE_PROTOCOL_VERSION, type FriendlyBattlePartySnapshot } from '../contracts.js';
import { assertValidFriendlyBattlePartySnapshot } from '../snapshot.js';

export type FriendlyBattleReadyState = {
  hostReady: boolean;
  guestReady: boolean;
  canStart: boolean;
};

export type FriendlyBattleAction = {
  actor: 'host' | 'guest';
  value: string;
};

export class FriendlyBattleTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FriendlyBattleTransportError';
    this.code = code;
  }
}

type HostOptions = {
  host: string;
  advertiseHost?: string;
  port: number;
  sessionCode: string;
  generation: string;
  hostPlayerName: string;
};

type GuestOptions = {
  host: string;
  port: number;
  sessionCode: string;
  generation: string;
  guestPlayerName: string;
  guestSnapshot: FriendlyBattlePartySnapshot;
  timeoutMs?: number;
};

type GuestJoinEvent = {
  guestPlayerName: string;
  guestSnapshot: FriendlyBattlePartySnapshot;
};

type HostHelloMessage = {
  type: 'hello';
  protocolVersion: number;
  sessionCode: string;
  generation: string;
  guestPlayerName: string;
  guestSnapshot: FriendlyBattlePartySnapshot;
};

type HostReadyMessage = {
  type: 'guest_ready';
};

type HostActionMessage = {
  type: 'guest_action';
  value: string;
};

type GuestInboundMessage =
  | { type: 'hello_ack'; protocolVersion: number; generation: string; hostPlayerName: string; readyState: FriendlyBattleReadyState }
  | { type: 'hello_reject'; code: 'bad_session_code' | 'room_full' | 'generation_mismatch' | 'unsupported_protocol' | 'invalid_guest_snapshot'; message: string }
  | { type: 'ready_state'; readyState: FriendlyBattleReadyState }
  | { type: 'battle_started' }
  | { type: 'host_action'; value: string };

type HostInboundMessage = HostHelloMessage | HostReadyMessage | HostActionMessage;

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (value: T) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  fail(error: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  shift(timeoutMs: number, label: string): Promise<T> {
    if (this.values.length > 0) {
      return Promise.resolve(this.values.shift() as T);
    }

    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject } as { resolve: (value: T) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new FriendlyBattleTransportError('timeout', `${label} 대기 중 시간이 초과되었습니다.`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function parseDelimitedMessages<T>(buffer: string, onMessage: (message: T) => void): string {
  let remainder = buffer;
  while (true) {
    const newlineIndex = remainder.indexOf('\n');
    if (newlineIndex < 0) return remainder;
    const line = remainder.slice(0, newlineIndex).trim();
    remainder = remainder.slice(newlineIndex + 1);
    if (!line) continue;
    onMessage(JSON.parse(line) as T);
  }
}

function writeMessage(socket: net.Socket, payload: object): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function toReadyState(hostReady: boolean, guestReady: boolean): FriendlyBattleReadyState {
  return { hostReady, guestReady, canStart: hostReady && guestReady };
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '::0';
}

export async function createFriendlyBattleSpikeHost(options: HostOptions) {
  const guestJoinQueue = new AsyncQueue<GuestJoinEvent>();
  const guestActionQueue = new AsyncQueue<FriendlyBattleAction>();
  const readyStateQueue = new AsyncQueue<FriendlyBattleReadyState>();
  const actionLog: FriendlyBattleAction[] = [];
  const server = net.createServer();

  let socket: net.Socket | null = null;
  let hostReady = false;
  let guestReady = false;
  let battleStarted = false;
  let closed = false;
  let guestPlayerName: string | null = null;

  const listenAddress = await new Promise<{ host: string; port: number }>((resolve, reject) => {
    const onListenError = (error: NodeJS.ErrnoException) => {
      reject(
        new FriendlyBattleTransportError(
          'listen_failed',
          `host가 ${options.host}:${options.port}에서 listen하지 못했습니다. 이미 사용 중인 포트인지, host 주소가 유효한지 확인하세요. (${error.code ?? 'unknown'})`,
        ),
      );
    };

    server.once('error', onListenError);
    server.listen(options.port, options.host, () => {
      server.off('error', onListenError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new FriendlyBattleTransportError('listen_failed', 'friendly battle spike host가 바인딩 주소를 확인하지 못했습니다.'));
        return;
      }
      resolve({ host: address.address, port: address.port });
    });
  });

  if (isWildcardHost(listenAddress.host) && !options.advertiseHost) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new FriendlyBattleTransportError(
      'advertise_host_required',
      `host가 ${listenAddress.host} 같은 wildcard 주소로 listen할 때는 guest에게 전달할 --join-host(광고용 host)가 필요합니다.`,
    );
  }

  if (options.advertiseHost && isWildcardHost(options.advertiseHost)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new FriendlyBattleTransportError(
      'advertise_host_required',
      `--join-host는 guest가 실제로 접속할 수 있는 구체적인 host여야 합니다. ${options.advertiseHost} 같은 wildcard 주소는 사용할 수 없습니다.`,
    );
  }

  const advertisedHost = options.advertiseHost ?? listenAddress.host;

  const destroyQueues = (error: Error) => {
    guestJoinQueue.fail(error);
    readyStateQueue.fail(error);
    guestActionQueue.fail(error);
  };

  server.on('connection', (incomingSocket) => {
    if (socket) {
      writeMessage(incomingSocket, {
        type: 'hello_reject',
        code: 'room_full',
        message: '이미 guest가 연결되어 있습니다.',
      });
      incomingSocket.end();
      return;
    }

    socket = incomingSocket;
    incomingSocket.setEncoding('utf8');
    let buffer = '';
    let handshakeAccepted = false;

    incomingSocket.on('data', (chunk: string) => {
      buffer = parseDelimitedMessages<HostInboundMessage>(buffer + chunk, (message) => {
        if (message.type === 'hello') {
          if (message.protocolVersion !== FRIENDLY_BATTLE_PROTOCOL_VERSION) {
            writeMessage(incomingSocket, {
              type: 'hello_reject',
              code: 'unsupported_protocol',
              message: `지원하지 않는 friendly battle protocol 버전입니다. host=${FRIENDLY_BATTLE_PROTOCOL_VERSION}, guest=${message.protocolVersion}`,
            });
            if (socket === incomingSocket) {
              socket = null;
            }
            incomingSocket.end();
            return;
          }

          if (message.sessionCode !== options.sessionCode) {
            writeMessage(incomingSocket, {
              type: 'hello_reject',
              code: 'bad_session_code',
              message: `세션 코드가 일치하지 않습니다. host가 보여준 session code(${options.sessionCode})를 다시 확인하세요.`,
            });
            if (socket === incomingSocket) {
              socket = null;
            }
            incomingSocket.end();
            return;
          }

          if (message.generation !== options.generation) {
            writeMessage(incomingSocket, {
              type: 'hello_reject',
              code: 'generation_mismatch',
              message: `세대가 일치하지 않습니다. host=${options.generation}, guest=${message.generation}`,
            });
            if (socket === incomingSocket) {
              socket = null;
            }
            incomingSocket.end();
            return;
          }

          try {
            assertValidFriendlyBattlePartySnapshot(message.guestSnapshot);
          } catch (error) {
            writeMessage(incomingSocket, {
              type: 'hello_reject',
              code: 'invalid_guest_snapshot',
              message: `guest snapshot 검증에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
            });
            if (socket === incomingSocket) {
              socket = null;
            }
            incomingSocket.end();
            return;
          }

          if (message.guestSnapshot.generation !== options.generation) {
            writeMessage(incomingSocket, {
              type: 'hello_reject',
              code: 'generation_mismatch',
              message: `guest snapshot 세대가 host 세대와 다릅니다. host=${options.generation}, snapshot=${message.guestSnapshot.generation}`,
            });
            if (socket === incomingSocket) {
              socket = null;
            }
            incomingSocket.end();
            return;
          }

          handshakeAccepted = true;
          guestPlayerName = message.guestPlayerName;
          guestJoinQueue.push({
            guestPlayerName: message.guestPlayerName,
            guestSnapshot: structuredClone(message.guestSnapshot),
          });
          writeMessage(incomingSocket, {
            type: 'hello_ack',
            protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
            generation: options.generation,
            hostPlayerName: options.hostPlayerName,
            readyState: toReadyState(hostReady, guestReady),
          });
          return;
        }

        if (message.type === 'guest_ready') {
          guestReady = true;
          const readyState = toReadyState(hostReady, guestReady);
          readyStateQueue.push(readyState);
          writeMessage(incomingSocket, {
            type: 'ready_state',
            readyState,
          });
          return;
        }

        if (message.type === 'guest_action') {
          const action: FriendlyBattleAction = { actor: 'guest', value: message.value };
          actionLog.push(action);
          guestActionQueue.push(action);
        }
      });
    });

    incomingSocket.on('close', () => {
      if (socket === incomingSocket) {
        socket = null;
      }
      if (!closed && handshakeAccepted) {
        destroyQueues(new FriendlyBattleTransportError('socket_closed', 'guest 연결이 종료되었습니다.'));
      }
    });

    incomingSocket.on('error', () => {
      // close handler will propagate a queued error if needed.
    });
  });

  const ensureSocket = (): net.Socket => {
    if (!socket) {
      throw new FriendlyBattleTransportError('not_connected', '아직 guest가 연결되지 않았습니다. join 정보를 확인하세요.');
    }
    return socket;
  };

  const emitReadyState = (): FriendlyBattleReadyState => {
    const readyState = toReadyState(hostReady, guestReady);
    readyStateQueue.push(readyState);
    if (socket) {
      writeMessage(socket, {
        type: 'ready_state',
        readyState,
      });
    }
    return readyState;
  };

  const waitForReadyState = async (
    timeoutMs: number,
    predicate: (readyState: FriendlyBattleReadyState) => boolean,
    label: string,
  ): Promise<FriendlyBattleReadyState> => {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const readyState = toReadyState(hostReady, guestReady);
      if (predicate(readyState)) {
        return readyState;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new FriendlyBattleTransportError('timeout', `${label} 대기 중 시간이 초과되었습니다.`);
      }

      const nextReadyState = await readyStateQueue.shift(remainingMs, label);
      if (predicate(nextReadyState)) {
        return nextReadyState;
      }
    }
  };

  return {
    connectionInfo: {
      host: advertisedHost,
      listenHost: listenAddress.host,
      port: listenAddress.port,
      sessionCode: options.sessionCode,
      joinHint: `tokenmon friendly-battle spike join --host ${advertisedHost} --port ${listenAddress.port} --session-code ${options.sessionCode} --generation ${options.generation}`,
    },
    async waitForGuestJoin(timeoutMs: number): Promise<GuestJoinEvent> {
      return guestJoinQueue.shift(timeoutMs, 'guest join');
    },
    markHostReady(): FriendlyBattleReadyState {
      hostReady = true;
      return emitReadyState();
    },
    async waitUntilCanStart(timeoutMs: number): Promise<FriendlyBattleReadyState> {
      return waitForReadyState(timeoutMs, (readyState) => readyState.canStart, 'battle start readiness');
    },
    async startBattle(): Promise<void> {
      const activeSocket = ensureSocket();
      if (!hostReady || !guestReady) {
        throw new FriendlyBattleTransportError('not_ready', '둘 다 ready 상태가 되어야 battle을 시작할 수 있습니다.');
      }
      battleStarted = true;
      writeMessage(activeSocket, { type: 'battle_started' });
    },
    async waitForGuestAction(timeoutMs: number): Promise<FriendlyBattleAction> {
      return guestActionQueue.shift(timeoutMs, 'guest action');
    },
    submitHostAction(value: string): FriendlyBattleAction {
      const activeSocket = ensureSocket();
      if (!battleStarted) {
        throw new FriendlyBattleTransportError('battle_not_started', 'battle이 시작되기 전에는 행동을 보낼 수 없습니다.');
      }
      const action: FriendlyBattleAction = { actor: 'host', value };
      actionLog.push(action);
      writeMessage(activeSocket, { type: 'host_action', value });
      return action;
    },
    getActionLog(): FriendlyBattleAction[] {
      return [...actionLog];
    },
    async close(): Promise<void> {
      closed = true;
      if (socket && !socket.destroyed) {
        socket.end();
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function connectFriendlyBattleSpikeGuest(options: GuestOptions) {
  const readyStateQueue = new AsyncQueue<FriendlyBattleReadyState>();
  const startedQueue = new AsyncQueue<void>();
  const hostActionQueue = new AsyncQueue<FriendlyBattleAction>();
  const socket = new net.Socket();

  let closed = false;
  let battleStarted = false;
  let lastReadyState: FriendlyBattleReadyState | null = null;
  const timeoutMs = options.timeoutMs ?? 1_000;

  const waitForReadyState = async (
    timeoutMs: number,
    predicate: (readyState: FriendlyBattleReadyState) => boolean,
    label: string,
  ): Promise<FriendlyBattleReadyState> => {
    const deadline = Date.now() + timeoutMs;

    if (lastReadyState && predicate(lastReadyState)) {
      return lastReadyState;
    }

    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new FriendlyBattleTransportError('timeout', `${label} 대기 중 시간이 초과되었습니다.`);
      }

      const readyState = await readyStateQueue.shift(remainingMs, label);
      lastReadyState = readyState;
      if (predicate(readyState)) {
        return readyState;
      }
    }
  };

  const connectPromise = new Promise<void>((resolve, reject) => {
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new FriendlyBattleTransportError(
          'connection_failed',
          `host에 연결하지 못했습니다. host가 실행 중인지, 주소(${options.host})와 포트(${options.port})가 맞는지 확인하세요. (${error.code ?? 'unknown'})`,
        ),
      );
    });

    socket.connect(options.port, options.host, () => {
      socket.removeAllListeners('error');
      resolve();
    });
  });

  await connectPromise;

  socket.setEncoding('utf8');
  let buffer = '';

  const closeWithError = (error: Error) => {
    readyStateQueue.fail(error);
    startedQueue.fail(error);
    hostActionQueue.fail(error);
  };

  socket.on('data', (chunk: string) => {
    buffer = parseDelimitedMessages<GuestInboundMessage>(buffer + chunk, (message) => {
      if (message.type === 'hello_reject') {
        closeWithError(new FriendlyBattleTransportError(message.code, message.message));
        socket.end();
        return;
      }

      if (message.type === 'hello_ack') {
        if (message.protocolVersion !== FRIENDLY_BATTLE_PROTOCOL_VERSION) {
          closeWithError(
            new FriendlyBattleTransportError(
              'unsupported_protocol',
              `protocol version이 맞지 않습니다. host=${message.protocolVersion}, guest=${FRIENDLY_BATTLE_PROTOCOL_VERSION}`,
            ),
          );
          socket.end();
          return;
        }

        if (message.generation !== options.generation) {
          closeWithError(
            new FriendlyBattleTransportError(
              'generation_mismatch',
              `host generation이 guest generation과 다릅니다. host=${message.generation}, guest=${options.generation}`,
            ),
          );
          socket.end();
          return;
        }

        lastReadyState = message.readyState;
        readyStateQueue.push(message.readyState);
        return;
      }

      if (message.type === 'ready_state') {
        lastReadyState = message.readyState;
        readyStateQueue.push(message.readyState);
        return;
      }

      if (message.type === 'battle_started') {
        battleStarted = true;
        startedQueue.push();
        return;
      }

      if (message.type === 'host_action') {
        hostActionQueue.push({ actor: 'host', value: message.value });
      }
    });
  });

  socket.on('close', () => {
    if (!closed) {
      closeWithError(new FriendlyBattleTransportError('socket_closed', 'host 연결이 종료되었습니다.'));      
    }
  });

  socket.on('error', () => {
    // errors after connect are surfaced through close/queue failure.
  });

  writeMessage(socket, {
    type: 'hello',
    protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
    sessionCode: options.sessionCode,
    generation: options.generation,
    guestPlayerName: options.guestPlayerName,
    guestSnapshot: options.guestSnapshot,
  } satisfies HostHelloMessage);

  await waitForReadyState(timeoutMs, () => true, 'hello acknowledgement');

  return {
    async markReady(): Promise<FriendlyBattleReadyState> {
      writeMessage(socket, { type: 'guest_ready' } satisfies HostReadyMessage);
      return waitForReadyState(timeoutMs, (readyState) => readyState.guestReady, 'ready state');
    },
    async waitForStarted(timeoutMs: number): Promise<void> {
      return startedQueue.shift(timeoutMs, 'battle start');
    },
    async submitAction(value: string): Promise<FriendlyBattleAction> {
      if (!battleStarted) {
        throw new FriendlyBattleTransportError('battle_not_started', 'battle이 시작되기 전에는 행동을 보낼 수 없습니다.');
      }
      const action: FriendlyBattleAction = { actor: 'guest', value };
      writeMessage(socket, { type: 'guest_action', value } satisfies HostActionMessage);
      return action;
    },
    async waitForHostAction(timeoutMs: number): Promise<FriendlyBattleAction> {
      return hostActionQueue.shift(timeoutMs, 'host action');
    },
    async close(): Promise<void> {
      closed = true;
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
      socket.destroy();
    },
  };
}
