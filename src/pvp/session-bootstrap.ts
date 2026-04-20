import type { RoomView } from '../server/projection/index.js';
import {
  createPvpSessionClient,
  type CreatePvpSessionClientOptions,
  type PvpSessionClient,
} from './session-client.js';
import type {
  CreatePvpRoomInput,
  GetPvpRoomInput,
  JoinPvpRoomInput,
  PvpRoomAuthInput,
  PvpRoomHttpClient,
} from './room-http-client.js';

export interface PvpSessionBootstrapSessionClientLike {
  connect?(): unknown;
}

export interface PvpSessionBootstrapResult<
  TSessionClient extends PvpSessionBootstrapSessionClientLike = PvpSessionClient,
> {
  roomView: RoomView;
  roomId: string;
  sessionClient: TSessionClient;
}

export interface CreateSessionFromRoomViewInput extends PvpRoomAuthInput {
  roomView: RoomView;
  autoConnect?: boolean;
}

export interface CreateRoomSessionInput extends CreatePvpRoomInput {
  autoConnect?: boolean;
}

export interface JoinRoomSessionInput extends JoinPvpRoomInput {
  autoConnect?: boolean;
}

export interface ResumeRoomSessionInput extends GetPvpRoomInput {
  autoConnect?: boolean;
}

export interface CreatePvpSessionBootstrapOptions<
  TSessionClient extends PvpSessionBootstrapSessionClientLike = PvpSessionClient,
> extends Omit<CreatePvpSessionClientOptions, 'roomId' | 'token'> {
  roomClient: PvpRoomHttpClient;
  autoConnect?: boolean;
  createSessionClient?: (options: CreatePvpSessionClientOptions) => TSessionClient;
}

export class PvpSessionBootstrapError extends Error {
  readonly code: string;

  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PvpSessionBootstrapError';
    this.code = options.code;
    this.details = options.details ? structuredClone(options.details) : undefined;
  }
}

function extractRoomId(roomView: RoomView): string {
  const roomId = roomView.room.roomId?.trim();
  if (!roomId) {
    throw new PvpSessionBootstrapError({
      code: 'PVP_SESSION_BOOTSTRAP_ROOM_ID_INVALID',
      message: 'The room projection did not include a usable room id.',
    });
  }

  return roomId;
}

export class PvpSessionBootstrap<
  TSessionClient extends PvpSessionBootstrapSessionClientLike = PvpSessionClient,
> {
  private readonly roomClient: PvpRoomHttpClient;

  private readonly sessionClientOptions: Omit<CreatePvpSessionClientOptions, 'roomId' | 'token'>;

  private readonly defaultAutoConnect: boolean;

  private readonly createSessionClientImpl: (options: CreatePvpSessionClientOptions) => TSessionClient;

  constructor(options: CreatePvpSessionBootstrapOptions<TSessionClient>) {
    this.roomClient = options.roomClient;
    this.sessionClientOptions = {
      serverUrl: options.serverUrl,
      createSocket: options.createSocket,
      now: options.now,
      scheduler: options.scheduler,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      multiplier: options.multiplier,
      computeDelayMs: options.computeDelayMs,
    };
    this.defaultAutoConnect = options.autoConnect ?? false;
    this.createSessionClientImpl = options.createSessionClient
      ?? ((sessionOptions) => createPvpSessionClient(sessionOptions) as unknown as TSessionClient);
  }

  async createRoomSession(input: CreateRoomSessionInput): Promise<PvpSessionBootstrapResult<TSessionClient>> {
    const { autoConnect, ...request } = input;
    const roomView = await this.roomClient.createRoom(request);
    return this.createSessionFromRoomView({
      authToken: input.authToken,
      roomView,
      autoConnect,
    });
  }

  async joinRoomSession(input: JoinRoomSessionInput): Promise<PvpSessionBootstrapResult<TSessionClient>> {
    const { autoConnect, ...request } = input;
    const roomView = await this.roomClient.joinRoom(request);
    return this.createSessionFromRoomView({
      authToken: input.authToken,
      roomView,
      autoConnect,
    });
  }

  async resumeRoomSession(input: ResumeRoomSessionInput): Promise<PvpSessionBootstrapResult<TSessionClient>> {
    const { autoConnect, ...request } = input;
    const roomView = await this.roomClient.getRoom(request);
    return this.createSessionFromRoomView({
      authToken: input.authToken,
      roomView,
      autoConnect,
    });
  }

  createSessionFromRoomView(input: CreateSessionFromRoomViewInput): PvpSessionBootstrapResult<TSessionClient> {
    const roomId = extractRoomId(input.roomView);
    const sessionClient = this.createSessionClientImpl({
      ...this.sessionClientOptions,
      roomId,
      token: input.authToken,
    });

    if (input.autoConnect ?? this.defaultAutoConnect) {
      sessionClient.connect?.();
    }

    return {
      roomView: structuredClone(input.roomView),
      roomId,
      sessionClient,
    };
  }
}

export function createPvpSessionBootstrap<
  TSessionClient extends PvpSessionBootstrapSessionClientLike = PvpSessionClient,
>(
  options: CreatePvpSessionBootstrapOptions<TSessionClient>,
): PvpSessionBootstrap<TSessionClient> {
  return new PvpSessionBootstrap(options);
}
