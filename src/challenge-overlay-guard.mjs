/**
 * Share / Challenge v1 overlay message guard (P1-4 security fix).
 *
 * The handshake (ChallengePlayerSession) already checks source + origin, but a
 * GAMEPLAY signal ({type:'completed',success:true}) arriving AFTER `configured`
 * must be gated just as strictly — otherwise the adversarial sequence
 *   legit runtime configures → iframe navigates to a FOREIGN origin → the foreign
 *   page posts {type:'completed',success:true}
 * would be accepted as a win (the iframe's contentWindow is unchanged by
 * navigation). Extracted as a pure predicate so the adversarial probe is a
 * node red-then-green test (check-challenge-overlay-guard.mjs), not a live-only
 * browser assertion.
 *
 * A gameplay message is honored ONLY when ALL of these hold simultaneously:
 *   1. exact frame identity: event.source === the configured contentWindow
 *   2. exact origin: event.origin === the content-addressed runtime origin
 *      (the SAME origin the configure_level handshake was pinned to)
 *   3. live configured epoch: phase === 'configured', the solve clock has started,
 *      and the epoch has NOT been revoked by a re-navigation / re-handshake
 * Any mismatch → the message is ignored (fail-closed).
 */

/**
 * @param {{source?: unknown, origin?: string}} event
 * @param {{frameSource: unknown, expectedOrigin: string, phase: string, solveStarted: boolean, revoked: boolean}} ctx
 * @returns {boolean}
 */
export function gameplayMessageAccepted(event, ctx) {
  if (!event) return false;
  if (ctx.revoked) return false;                       // (3) re-navigation/re-handshake invalidated the epoch
  if (ctx.phase !== 'configured') return false;        // (3) not in the configured phase
  if (!ctx.solveStarted) return false;                 // (3) reveal/solve clock has not started
  if (event.source !== ctx.frameSource) return false;  // (1) exact frame identity
  if (event.origin !== ctx.expectedOrigin) return false; // (2) exact content-addressed origin
  return true;
}
