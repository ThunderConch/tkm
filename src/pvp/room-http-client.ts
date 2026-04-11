import type { ErrorEnvelope } from '../server/http/http-types.js';
import type { RoomView } from '../server/projection/index.js';

export interface PvpRoomHttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PvpRoomHttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type PvpFetchLikeResponse = PvpRoomHttpResponseLike;

export type PvpRoomHttpFetch = (
  url: string,
  init?: PvpRoomHttpRequestInit,
) => Promise<PvpRoomHttpResponseLike>;

export type PvpRoomHttpOperation = 'create_room' | 'join_room' | 'get_room';

export type PvpRoomHttpErrorKind = 'network_error' | 'http_error' | 'invalid_response';

export interface PvpRoomAuthInput {
  authToken: string;
}

export interface CreatePvpRoomInput extends PvpRoomAuthInput {
  generation: string;
  visibility: string;
  rulesetKey?: string;
}

export interface JoinPvpRoomInput extends PvpRoomAuthInput {
  roomId: string;
  roomCode: string;
  generation: string;
}

export interface GetPvpRoomInput extends PvpRoomAuthInput {
  roomId: string;
}

export interface PvpRoomHttpClient {
  createRoom(input: CreatePvpRoomInput): Promise<RoomView>;
  joinRoom(input: JoinPvpRoomInput): Promise<RoomView>;
  getRoom(input: GetPvpRoomInput): Promise<RoomView>;
}

export interface CreatePvpRoomHttpClientOptions {
  serverUrl: string;
  fetch: PvpRoomHttpFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRoomView(value: unknown): value is RoomView {
  if (!isRecord(value)) {
    return false;
  }

  const room = value.room;
  const you = value.you;
  const opponent = value.opponent;
  const match = value.match;

  return isRecord(room)
    && typeof room.roomId === 'string'
    && typeof room.roomCode === 'string'
    && typeof room.mode === 'string'
    && typeof room.status === 'string'
    && typeof room.generation === 'string'
    && typeof room.rulesetKey === 'string'
    && typeof room.createdAt === 'string'
    && (typeof room.expiresAt === 'string' || room.expiresAt === null)
    && isRecord(you)
    && typeof you.seat === 'string'
    && typeof you.partySnapshotId === 'string'
    && typeof you.partyValidationStatus === 'string'
    && typeof you.presence === 'string'
    && typeof you.battleReady === 'boolean'
    && (opponent === null || (
      isRecord(opponent)
      && typeof opponent.seat === 'string'
      && typeof opponent.presence === 'string'
      && typeof opponent.battleReady === 'boolean'
      && typeof opponent.displayName === 'string'
    ))
    && isRecord(match)
    && typeof match.freezeStatus === 'string'
    && (typeof match.battleId === 'string' || match.battleId === null)
    && (typeof match.battleStartedAt === 'string' || match.battleStartedAt === null);
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return isRecord(value)
    && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean';
}

function joinUrl(serverUrl: string, pathname: string): string {
  const url = new URL(serverUrl);
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}${pathname}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function safeReadJson(response: PvpRoomHttpResponseLike): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function cloneDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return details ? structuredClone(details) : undefined;
}

export class PvpRoomHttpClientError extends Error {
  readonly kind: PvpRoomHttpErrorKind;

  readonly operation: PvpRoomHttpOperation;

  readonly status: number | null;

  readonly code: string;

  readonly retryable: boolean;

  readonly details?: Record<string, unknown>;

  constructor(options: {
    kind: PvpRoomHttpErrorKind;
    operation: PvpRoomHttpOperation;
    status: number | null;
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PvpRoomHttpClientError';
    this.kind = options.kind;
    this.operation = options.operation;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = cloneDetails(options.details);
  }
}

export class DefaultPvpRoomHttpClient implements PvpRoomHttpClient {
  private readonly serverUrl: string;

  private readonly fetchImpl: PvpRoomHttpFetch;

  constructor(options: CreatePvpRoomHttpClientOptions) {
    this.serverUrl = options.serverUrl;
    this.fetchImpl = options.fetch;
  }

  async createRoom(input: CreatePvpRoomInput): Promise<RoomView> {
    return this.requestRoomView('create_room', '/api/pvp/rooms', input.authToken, {
      method: 'POST',
      body: {
        generation: input.generation,
        visibility: input.visibility,
        rulesetKey: input.rulesetKey,
      },
    });
  }

  async joinRoom(input: JoinPvpRoomInput): Promise<RoomView> {
    return this.requestRoomView(
      'join_room',
      `/api/pvp/rooms/${encodeURIComponent(input.roomId)}/join`,
      input.authToken,
      {
        method: 'POST',
        body: {
          roomCode: input.roomCode,
          generation: input.generation,
        },
      },
    );
  }

  async getRoom(input: GetPvpRoomInput): Promise<RoomView> {
    return this.requestRoomView(
      'get_room',
      `/api/pvp/rooms/${encodeURIComponent(input.roomId)}`,
      input.authToken,
      { method: 'GET' },
    );
  }

  private async requestRoomView(
    operation: PvpRoomHttpOperation,
    pathname: string,
    authToken: string,
    options: {
      method: 'GET' | 'POST';
      body?: Record<string, unknown>;
    },
  ): Promise<RoomView> {
    const url = joinUrl(this.serverUrl, pathname);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${authToken.trim()}`,
    };
    const init: PvpRoomHttpRequestInit = {
      method: options.method,
      headers,
    };

    if (options.body) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: PvpRoomHttpResponseLike;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new PvpRoomHttpClientError({
        kind: 'network_error',
        operation,
        status: null,
        code: 'PVP_ROOM_HTTP_NETWORK_ERROR',
        message: 'The PvP room HTTP request failed before the server responded.',
        retryable: true,
        details: {
          url,
          method: options.method,
        },
        cause: error,
      });
    }

    const payload = await safeReadJson(response);
    if (response.status < 200 || response.status >= 300) {
      if (isErrorEnvelope(payload)) {
        throw new PvpRoomHttpClientError({
          kind: 'http_error',
          operation,
          status: response.status,
          code: payload.error.code,
          message: payload.error.message,
          retryable: payload.error.retryable,
          details: payload.error.details,
        });
      }

      throw new PvpRoomHttpClientError({
        kind: 'invalid_response',
        operation,
        status: response.status,
        code: 'PVP_ROOM_HTTP_INVALID_ERROR_ENVELOPE',
        message: 'The PvP room server returned an invalid error payload.',
        retryable: response.status >= 500,
        details: {
          url,
          method: options.method,
          responseStatus: response.status,
        },
      });
    }

    if (!isRoomView(payload)) {
      throw new PvpRoomHttpClientError({
        kind: 'invalid_response',
        operation,
        status: response.status,
        code: 'PVP_ROOM_HTTP_INVALID_RESPONSE',
        message: 'The PvP room server returned a malformed room payload.',
        retryable: false,
        details: {
          url,
          method: options.method,
          responseStatus: response.status,
        },
      });
    }

    return structuredClone(payload);
  }
}

export function createPvpRoomHttpClient(options: CreatePvpRoomHttpClientOptions): PvpRoomHttpClient {
  return new DefaultPvpRoomHttpClient(options);
}
