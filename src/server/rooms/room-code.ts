import { randomInt } from 'node:crypto';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

export function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

export function isRoomCodeFormat(roomCode: string): boolean {
  return /^[A-Z2-9]{6}$/.test(normalizeRoomCode(roomCode));
}

function defaultIndexGenerator(): number {
  return randomInt(ROOM_CODE_ALPHABET.length);
}

export function createRoomCode(nextIndex: () => number = defaultIndexGenerator): string {
  let roomCode = '';

  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const rawIndex = nextIndex();
    const normalizedIndex = Number.isInteger(rawIndex)
      ? Math.abs(rawIndex) % ROOM_CODE_ALPHABET.length
      : Math.floor(Math.abs(rawIndex) * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length;
    roomCode += ROOM_CODE_ALPHABET[normalizedIndex] ?? ROOM_CODE_ALPHABET[0];
  }

  return roomCode;
}
