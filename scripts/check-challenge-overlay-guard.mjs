/**
 * P1-4 red-then-green: the overlay gameplay guard must reject a post-navigation
 * cross-origin win. Codex's adversarial probe:
 *   legit runtime configures (origin R) → iframe navigates to a FOREIGN origin F
 *   → the foreign page (still event.source === the iframe's contentWindow) posts
 *   {type:'completed',success:true}.
 * The OLD code accepted it (it checked only event.source === contentWindow). The
 * guard now requires source AND origin AND a live, un-revoked configured epoch.
 */
import assert from 'node:assert/strict';

import { gameplayMessageAccepted } from '../src/challenge-overlay-guard.mjs';

let assertions = 0;
function ok(v, m) { assert.equal(v, true, m); assertions += 1; }
function no(v, m) { assert.equal(v, false, m); assertions += 1; }

const frameWindow = { id: 'iframe-contentWindow' }; // stand-in for frame.contentWindow
const RUNTIME_ORIGIN = 'https://play.swipe.example';
const FOREIGN_ORIGIN = 'https://evil.example';

const configured = { frameSource: frameWindow, expectedOrigin: RUNTIME_ORIGIN, phase: 'configured', solveStarted: true, revoked: false };

// GREEN: a genuine win from the pinned runtime origin, same frame, live epoch.
ok(gameplayMessageAccepted({ source: frameWindow, origin: RUNTIME_ORIGIN }, configured),
  'genuine win from the configured runtime origin is accepted');

// --- Codex adversarial probe (this is the RED case the fix turns green) ---
// The navigated-away page keeps the SAME contentWindow (source matches) — the OLD
// source-only check would ACCEPT it. Prove the source matches, then prove the
// guard REJECTS it on the origin mismatch.
const sourceOnlyWouldAccept = ({ source }) => source === frameWindow;
assert.equal(sourceOnlyWouldAccept({ source: frameWindow }), true); assertions += 1; // RED: old logic accepts
no(gameplayMessageAccepted({ source: frameWindow, origin: FOREIGN_ORIGIN }, configured),
  'GREEN: post-navigation cross-origin completed is REJECTED (origin mismatch)');

// Re-navigation revokes the epoch even if the attacker spoofs the runtime origin.
no(gameplayMessageAccepted({ source: frameWindow, origin: RUNTIME_ORIGIN }, { ...configured, revoked: true }),
  'a revoked (re-navigated) epoch rejects even a right-origin win');

// A foreign window (different source) is rejected.
no(gameplayMessageAccepted({ source: { id: 'other' }, origin: RUNTIME_ORIGIN }, configured),
  'a message from a different window is rejected');

// Gameplay before configured / before the solve clock started is rejected.
no(gameplayMessageAccepted({ source: frameWindow, origin: RUNTIME_ORIGIN }, { ...configured, phase: 'awaiting_configured' }),
  'gameplay before configured is rejected');
no(gameplayMessageAccepted({ source: frameWindow, origin: RUNTIME_ORIGIN }, { ...configured, solveStarted: false }),
  'gameplay before reveal/solve-start is rejected');

console.log(`check-challenge-overlay-guard: ${assertions} assertions passed (P1-4 cross-origin win closed)`);
