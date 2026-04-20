import type { BattleCommandEnvelope } from '../battle/index.js';

export interface PvpWsPongEnvelope {
  type: 'ws.pong';
  sentAt: string;
}

export type PvpWsInboundEnvelope = BattleCommandEnvelope | PvpWsPongEnvelope;

export type RoutedPvpWsMessage =
  | { type: 'battle.command'; envelope: BattleCommandEnvelope }
  | { type: 'ws.pong'; envelope: PvpWsPongEnvelope };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBattleCommandEnvelope(value: unknown): value is BattleCommandEnvelope {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    value.type === 'battle.command' &&
    typeof value.roomId === 'string' &&
    typeof value.battleId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.sentAt === 'string' &&
    isObjectRecord(value.payload) &&
    typeof value.payload.clientCommandId === 'string' &&
    typeof value.payload.turn === 'number' &&
    typeof value.payload.phase === 'string' &&
    isObjectRecord(value.payload.command) &&
    typeof value.payload.command.type === 'string'
  );
}

function isPongEnvelope(value: unknown): value is PvpWsPongEnvelope {
  return isObjectRecord(value) && value.type === 'ws.pong' && typeof value.sentAt === 'string';
}

export class MessageRouter {
  route(message: unknown): RoutedPvpWsMessage {
    if (isBattleCommandEnvelope(message)) {
      return {
        type: 'battle.command',
        envelope: message,
      };
    }

    if (isPongEnvelope(message)) {
      return {
        type: 'ws.pong',
        envelope: message,
      };
    }

    throw new Error('PVP_WS_MESSAGE_INVALID');
  }
}
