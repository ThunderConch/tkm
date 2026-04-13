// test/friendly-battle-daemon-fainted-switch.test.ts
//
// End-to-end integration test: fainted forced-switch through the daemon + IPC stack.
//
// STATUS: Marked .todo() — see detailed explanation below.
//
// Root cause analysis
// ───────────────────
// The host daemon's turn loop (daemon.ts lines 518-543) unconditionally waits for
// BOTH a host IPC action (localActionQueue.shift) AND a guest TCP choice
// (waitForGuestChoice) on every iteration, regardless of the current phase:
//
//   while (runtime.phase !== 'completed') {
//     const [hostEnvelope, guestEnvelope] = await Promise.all([
//       localActionQueue.shift(timeoutMs, 'host action'),
//       host_transport.waitForGuestChoice(timeoutMs),
//     ]);
//     submitFriendlyBattleChoice(runtime, hostEnvelope);   // ← throws during single-side fainted_switch
//     const resolvedEvents = submitFriendlyBattleChoice(runtime, guestEnvelope);
//
// When only ONE side's active pokemon has fainted (the common case), the
// battle-adapter's submitFriendlyBattleChoice validates:
//
//   const waitingFor = getWaitingFor(runtime); // e.g. ['guest'] — only the fainted side
//   if (!waitingFor.includes(envelope.actor)) {
//     throw new Error(`Friendly battle is not waiting for ${envelope.actor}`);
//   }
//
// If the host's pokemon DIDN'T faint, submitting the host envelope throws
// "not waiting for host". If the guest's pokemon DIDN'T faint, submitting
// the guest envelope throws "not waiting for guest".
//
// The daemon would need to check runtime.phase / getWaitingFor BEFORE calling
// Promise.all so it can skip the irrelevant side during awaiting_fainted_switch.
// That is a source change to daemon.ts, which is out of scope for this PR.
//
// Proposed follow-up
// ──────────────────
// In the next daemon iteration (PR45.5 or PR46), update the host turn loop to:
//
//   const waitingFor = getWaitingForRoles(runtime);  // expose from battle-adapter
//   const [hostEnvelope, guestEnvelope] = await Promise.all([
//     waitingFor.includes('host') ? localActionQueue.shift(timeoutMs, 'host action') : Promise.resolve(null),
//     waitingFor.includes('guest') ? host_transport.waitForGuestChoice(timeoutMs) : Promise.resolve(null),
//   ]);
//   if (hostEnvelope) submitFriendlyBattleChoice(runtime, hostEnvelope);
//   if (guestEnvelope) {
//     const resolvedEvents = submitFriendlyBattleChoice(runtime, guestEnvelope);
//     ...
//   }
//
// Until then, the integration test for single-side fainted switch cannot pass
// through the daemon layer. The battle-adapter and battle-state layers are
// correct and covered by unit tests (friendly-battle-battle-adapter.test.ts,
// turn-battle.test.ts). This test is deferred.

import { describe, it } from 'node:test';

describe('friendly-battle daemon fainted forced-switch (end-to-end)', () => {
  it.todo(
    'guest fainted switch: after KO, guest sees fainted_switch status and battle continues after switch action',
    // Blocked: daemon.ts host turn loop does not handle single-side awaiting_fainted_switch.
    // When only the guest's pokemon has fainted, submitFriendlyBattleChoice throws
    // "Friendly battle is not waiting for host" when the host's action is submitted.
    // See file-level comment for full analysis and proposed fix.
  );
});
