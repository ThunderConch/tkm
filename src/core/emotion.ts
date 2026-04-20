/**
 * EV-based emotion string for call speech bubbles.
 * Shared between status-line.ts (hook) and tokenmon.ts (CLI sprite command).
 */
export function getEmotionInner(ev: number): string {
  if (ev <= 0)        return ' ?   ';
  if (ev <= 50)       return '...  ';
  if (ev <= 120)      return ':)   ';
  if (ev <= 200)      return '<3   ';
  return '<3!  ';
}
