import type { BattleCommandEnvelope } from '../server/battle/index.js';
import type { PvpWsErrorEnvelope, PvpWsOutboundEnvelope, PvpWsPongEnvelope } from '../server/ws/index.js';
import {
  applyPvpServerEvent,
  createBattleCommandEnvelope,
  createPvpSessionState,
  type CreateBattleCommandEnvelopeOptions,
  type PvpSessionState,
} from './session-store.js';

export type PvpClientInboundEnvelope = PvpWsOutboundEnvelope;
export type PvpClientOutboundEnvelope = BattleCommandEnvelope | PvpWsPongEnvelope;

export interface PvpClientState {
  session: PvpSessionState;
  lastTransportError: PvpWsErrorEnvelope | null;
  lastTransportMessageAt: string | null;
  lastTransportMessageType: PvpClientInboundEnvelope['type'] | null;
  lastPingAt: string | null;
  lastPongSentAt: string | null;
}

export interface ApplyPvpTransportEnvelopeOptions {
  pongSentAt?: string;
}

export interface AppliedPvpTransportEnvelope {
  state: PvpClientState;
  outbound: PvpClientOutboundEnvelope[];
}

export interface CreatedPvpClientCommand {
  state: PvpClientState;
  envelope: BattleCommandEnvelope;
}

function cloneTransportError(envelope: PvpWsErrorEnvelope): PvpWsErrorEnvelope {
  return {
    ...envelope,
    details: envelope.details ? structuredClone(envelope.details) : undefined,
  };
}

export function createPvpClientState(): PvpClientState {
  return {
    session: createPvpSessionState(),
    lastTransportError: null,
    lastTransportMessageAt: null,
    lastTransportMessageType: null,
    lastPingAt: null,
    lastPongSentAt: null,
  };
}

export function applyPvpTransportEnvelope(
  state: PvpClientState,
  envelope: PvpClientInboundEnvelope,
  options: ApplyPvpTransportEnvelopeOptions = {},
): AppliedPvpTransportEnvelope {
  const baseState: PvpClientState = {
    ...state,
    lastTransportMessageAt: envelope.sentAt,
    lastTransportMessageType: envelope.type,
  };

  if (envelope.type === 'ws.ping') {
    const pongSentAt = options.pongSentAt ?? envelope.sentAt;
    return {
      state: {
        ...baseState,
        lastPingAt: envelope.sentAt,
        lastPongSentAt: pongSentAt,
      },
      outbound: [
        {
          type: 'ws.pong',
          sentAt: pongSentAt,
        },
      ],
    };
  }

  if (envelope.type === 'ws.error') {
    return {
      state: {
        ...baseState,
        lastTransportError: cloneTransportError(envelope),
      },
      outbound: [],
    };
  }

  return {
    state: {
      ...baseState,
      session: applyPvpServerEvent(state.session, envelope),
      lastTransportError: null,
    },
    outbound: [],
  };
}

export function createPvpClientCommand(
  state: PvpClientState,
  options: CreateBattleCommandEnvelopeOptions,
): CreatedPvpClientCommand {
  const created = createBattleCommandEnvelope(state.session, options);

  return {
    state: {
      ...state,
      session: created.state,
    },
    envelope: created.envelope,
  };
}
