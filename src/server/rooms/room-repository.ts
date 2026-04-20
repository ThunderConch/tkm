import type { BattleRoomRecord } from './room-types.js';
import { isParticipationLockedStatus } from './room-validator.js';

export interface RoomRepository {
  getRoom(roomId: string): BattleRoomRecord | undefined;
  findActiveRoomByPlayerId(playerId: string): BattleRoomRecord | undefined;
  hasRoomCode(roomCode: string): boolean;
  saveRoom(room: BattleRoomRecord): void;
  createRoomId(): string;
  seedRooms(rooms: readonly BattleRoomRecord[]): void;
}

function cloneRoom(room: BattleRoomRecord): BattleRoomRecord {
  return structuredClone(room);
}

function isPlayerBound(room: BattleRoomRecord, playerId: string): boolean {
  return room.host.userId === playerId || room.guest?.userId === playerId;
}

function extractRoomSequence(roomId: string): number | undefined {
  const matched = /^room_(\d{6})$/.exec(roomId);
  if (!matched) {
    return undefined;
  }

  return Number(matched[1]);
}

export class InMemoryRoomRepository implements RoomRepository {
  private readonly roomsById = new Map<string, BattleRoomRecord>();

  private roomSequence = 0;

  getRoom(roomId: string): BattleRoomRecord | undefined {
    const room = this.roomsById.get(roomId);
    return room ? cloneRoom(room) : undefined;
  }

  findActiveRoomByPlayerId(playerId: string): BattleRoomRecord | undefined {
    for (const room of this.roomsById.values()) {
      if (!isPlayerBound(room, playerId)) {
        continue;
      }

      if (!isParticipationLockedStatus(room.room.status)) {
        continue;
      }

      return cloneRoom(room);
    }

    return undefined;
  }

  hasRoomCode(roomCode: string): boolean {
    for (const room of this.roomsById.values()) {
      if (room.room.roomCode === roomCode) {
        return true;
      }
    }

    return false;
  }

  saveRoom(room: BattleRoomRecord): void {
    this.roomsById.set(room.room.roomId, cloneRoom(room));
    this.syncSequence(room.room.roomId);
  }

  createRoomId(): string {
    this.roomSequence += 1;
    return `room_${String(this.roomSequence).padStart(6, '0')}`;
  }

  seedRooms(rooms: readonly BattleRoomRecord[]): void {
    for (const room of rooms) {
      this.roomsById.set(room.room.roomId, cloneRoom(room));
      this.syncSequence(room.room.roomId);
    }
  }

  private syncSequence(roomId: string): void {
    const sequence = extractRoomSequence(roomId);
    if (!sequence) {
      return;
    }

    if (sequence > this.roomSequence) {
      this.roomSequence = sequence;
    }
  }
}
