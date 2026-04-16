import net from 'node:net';
import {
  FRIENDLY_BATTLE_PROTOCOL_VERSION,
  type FriendlyBattleBattleEvent,
  type FriendlyBattleBattleEventMessage,
  type FriendlyBattleChoiceEnvelope,
  type FriendlyBattleHelloAckMessage,
  type FriendlyBattleHelloMessage,
  type FriendlyBattleHelloRejectMessage,
  type FriendlyBattlePartySnapshot,
  type FriendlyBattleReadyState,
  type FriendlyBattleReadyStateMessage,
  type FriendlyBattleStartedMessage,
  type FriendlyBattleSubmitChoiceMessage,
} from '../contracts.js';
import {
  createFriendlyBattleChoiceEnvelope,
} from '../local-harness.js';
import { assertValidFriendlyBattlePartySnapshot } from '../snapshot.js';
import { AsyncQueue } from '../async-queue.js';

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

type GuestReadyMessage = {
  type: 'guest_ready';
};

type HostInboundMessage =
  | FriendlyBattleHelloMessage
  | GuestReadyMessage
  | FriendlyBattleSubmitChoiceMessage;

type GuestInboundMessage =
  | FriendlyBattleHelloAckMessage
  | FriendlyBattleHelloRejectMessage
  | FriendlyBattleReadyStateMessage
  | FriendlyBattleStartedMessage
  | FriendlyBattleBattleEventMessage;

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

const transportTimeoutError = (label: string, _ms: number) =>
  new FriendlyBattleTransportError('timeout', `${label} 대기 중 시간이 초과되었습니다.`);

export async function createFriendlyBattleSpikeHost(options: HostOptions) {
  const guestJoinQueue = new AsyncQueue<GuestJoinEvent>(transportTimeoutError);
  const guestChoiceQueue = new AsyncQueue<FriendlyBattleChoiceEnvelope>(transportTimeoutError);
  const readyStateQueue = new AsyncQueue<FriendlyBattleReadyState>(transportTimeoutError);
  const battleEventLog: FriendlyBattleBattleEvent[] = [];
  const submittedChoiceLog: FriendlyBattleChoiceEnvelope[] = [];
  const server = net.createServer();

  let socket: net.Socket | null = null;
  let hostReady = false;
  let guestReady = false;
  let battleStarted = false;
  let closed = false;

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
    guestChoiceQueue.fail(error);
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

        if (message.type === 'submit_choice') {
          submittedChoiceLog.push(message.envelope);
          guestChoiceQueue.push(structuredClone(message.envelope));
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
    async startBattle(battleId: string): Promise<void> {
      const activeSocket = ensureSocket();
      if (!hostReady || !guestReady) {
        throw new FriendlyBattleTransportError('not_ready', '둘 다 ready 상태가 되어야 battle을 시작할 수 있습니다.');
      }
      battleStarted = true;
      writeMessage(activeSocket, { type: 'battle_started', battleId });
    },
    async waitForGuestChoice(timeoutMs: number): Promise<FriendlyBattleChoiceEnvelope> {
      return guestChoiceQueue.shift(timeoutMs, 'guest choice');
    },
    sendBattleEvent(event: FriendlyBattleBattleEvent): FriendlyBattleBattleEvent {
      const activeSocket = ensureSocket();
      if (!battleStarted) {
        throw new FriendlyBattleTransportError('battle_not_started', 'battle이 시작되기 전에는 이벤트를 보낼 수 없습니다.');
      }
      battleEventLog.push(structuredClone(event));
      writeMessage(activeSocket, { type: 'battle_event', event });
      return event;
    },
    sendBattleEvents(events: FriendlyBattleBattleEvent[]): FriendlyBattleBattleEvent[] {
      return events.map((event) => this.sendBattleEvent(event));
    },
    getSubmittedChoiceLog(): FriendlyBattleChoiceEnvelope[] {
      return structuredClone(submittedChoiceLog);
    },
    getBattleEventLog(): FriendlyBattleBattleEvent[] {
      return structuredClone(battleEventLog);
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
  const readyStateQueue = new AsyncQueue<FriendlyBattleReadyState>(transportTimeoutError);
  const startedQueue = new AsyncQueue<FriendlyBattleStartedMessage>(transportTimeoutError);
  const battleEventQueue = new AsyncQueue<FriendlyBattleBattleEvent>(transportTimeoutError);
  const socket = new net.Socket();

  let closed = false;
  let failed = false;
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
    if (failed) {
      return;
    }
    failed = true;
    readyStateQueue.fail(error);
    startedQueue.fail(error);
    battleEventQueue.fail(error);
  };

  const failAndDestroy = (error: Error) => {
    closeWithError(error);
    if (!socket.destroyed) {
      socket.destroy();
    }
  };

  socket.on('data', (chunk: string) => {
    buffer = parseDelimitedMessages<GuestInboundMessage>(buffer + chunk, (message) => {
      if (message.type === 'hello_reject') {
        failAndDestroy(new FriendlyBattleTransportError(message.code, message.message));
        return;
      }

      if (message.type === 'hello_ack') {
        if (message.protocolVersion !== FRIENDLY_BATTLE_PROTOCOL_VERSION) {
          failAndDestroy(
            new FriendlyBattleTransportError(
              'unsupported_protocol',
              `protocol version이 맞지 않습니다. host=${message.protocolVersion}, guest=${FRIENDLY_BATTLE_PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        if (message.generation !== options.generation) {
          failAndDestroy(
            new FriendlyBattleTransportError(
              'generation_mismatch',
              `generation이 맞지 않습니다. host=${message.generation}, guest=${options.generation}`,
            ),
          );
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
        startedQueue.push(message);
        return;
      }

      if (message.type === 'battle_event') {
        battleEventQueue.push(structuredClone(message.event));
      }
    });
  });

  socket.on('close', () => {
    if (!closed) {
      closeWithError(new FriendlyBattleTransportError('socket_closed', 'host 연결이 종료되었습니다.'));
    }
  });

  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (!closed) {
      closeWithError(
        new FriendlyBattleTransportError(
          'socket_error',
          `friendly battle socket error: ${error.code ?? 'unknown'}`,
        ),
      );
    }
  });

  writeMessage(socket, {
    type: 'hello',
    protocolVersion: FRIENDLY_BATTLE_PROTOCOL_VERSION,
    sessionCode: options.sessionCode,
    generation: options.generation,
    guestPlayerName: options.guestPlayerName,
    guestSnapshot: options.guestSnapshot,
  });

  try {
    await waitForReadyState(timeoutMs, () => true, 'hello handshake');
  } catch (error) {
    failAndDestroy(
      error instanceof Error
        ? error
        : new FriendlyBattleTransportError('timeout', 'hello handshake 대기 중 시간이 초과되었습니다.'),
    );
    throw error;
  }

  return {
    async markReady(): Promise<FriendlyBattleReadyState> {
      writeMessage(socket, { type: 'guest_ready' });
      return waitForReadyState(timeoutMs, (readyState) => readyState.guestReady, 'host ready');
    },
    async waitForStarted(waitTimeoutMs: number): Promise<FriendlyBattleStartedMessage> {
      if (battleStarted) {
        return { type: 'battle_started', battleId: '' };
      }
      return startedQueue.shift(waitTimeoutMs, 'battle start');
    },
    async submitChoice(value: string): Promise<FriendlyBattleChoiceEnvelope> {
      if (!battleStarted) {
        throw new FriendlyBattleTransportError('battle_not_started', 'battle 시작 신호를 받기 전에는 행동을 보낼 수 없습니다.');
      }
      const envelope = createFriendlyBattleChoiceEnvelope('guest', value);
      writeMessage(socket, { type: 'submit_choice', envelope });
      return envelope;
    },
    async waitForBattleEvent(waitTimeoutMs: number): Promise<FriendlyBattleBattleEvent> {
      return battleEventQueue.shift(waitTimeoutMs, 'battle event');
    },
    async close(): Promise<void> {
      closed = true;
      if (!socket.destroyed) {
        socket.end();
        socket.destroy();
      }
    },
  };
}
