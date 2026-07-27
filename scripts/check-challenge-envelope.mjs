/**
 * Codex R2 P1 red-then-green: the durable phase envelope must be FAIL-CLOSED.
 *
 * The earlier revision swallowed storage errors, which Codex exploited:
 *   (a) the initial persist failed, yet the first network POST still went out
 *       (networkCallsAfterFailedPersist=1) — the operation had NO durable identity;
 *   (b) a checkpoint failed, the durable phase stayed `init`, and after a reload the
 *       already-committed step ran AGAIN (sourceStarts=2 / the level was re-played).
 *
 * Three probes below. Each is verified to RED on the pre-fix implementation:
 *   ENVELOPE_MODULE=<path-to-legacy-copy> node scripts/check-challenge-envelope.mjs
 * (the default import is the shipping module, which must be GREEN).
 */
import assert from 'node:assert/strict';

import { playSourceChallenge } from '../src/challenge-play.mjs';

const MODULE = process.env.ENVELOPE_MODULE || '../src/challenge-envelope.mjs';
const { openSourceEnvelope, SOURCE_ENVELOPE_KEY } = await import(MODULE);

let assertions = 0;
function equal(a, b, m) { assert.equal(a, b, m); assertions += 1; }
function ok(v, m) { assert.ok(v, m); assertions += 1; }
const isEnvelopeError = (e) => e?.code === 'challenge_envelope_not_persisted';
function throwsEnvelope(fn, m) {
  assert.throws(fn, isEnvelopeError, m);
  assertions += 1;
}

/** Storage double with injectable failure modes. */
function storageDouble(opts = {}) {
  const m = new Map();
  let writes = 0;
  return {
    map: m,
    get writes() { return writes; },
    getItem(k) {
      if (opts.failRead) throw new Error('read blocked');
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      writes += 1;
      if (opts.failWrite) throw new Error('QuotaExceededError');
      if (opts.dropWrites) return;               // silent no-op (the nastiest case)
      if (opts.failWritesAfter != null && writes > opts.failWritesAfter) throw new Error('QuotaExceededError');
      m.set(k, v);
    },
    removeItem(k) {
      if (opts.failRemove) throw new Error('remove blocked');
      m.delete(k);
    },
  };
}

const specDigest = 'a'.repeat(64);
const bundle = { specDigest, expectedSpecHash: 'b'.repeat(64), level: { params: { goal: 'clear' } } };
let uuidN = 0;
const mint = () => `id${++uuidN}`;

/** A source-flow deps double that records effects and dedups by durable id. */
function sourceDeps(counters) {
  return {
    createSourceLevel: (reqId) => {
      counters.network += 1;
      counters.offers.add(reqId);
      return Promise.resolve({
        request_id: reqId, spec_digest: specDigest,
        challengeSpec: { playableId: 'marble-sort-swipe', adapterVersion: 1, schemaVersion: 1, params: { goal: 'clear' } },
      });
    },
    startSourceRun: (req) => { counters.network += 1; counters.sourceStarts += 1; counters.tickets.add(req.ticket_id); return Promise.resolve({}); },
    getLevelBundle: () => { counters.network += 1; return Promise.resolve(bundle); },
    verifyBundleIdentity: () => Promise.resolve(true),
    mountLevel: () => { counters.mounts += 1; return Promise.resolve({ metricValue: 5000 }); },
    postResult: (p) => { counters.network += 1; counters.results.add(p.run_id); return Promise.resolve({}); },
    createChallenge: (p) => {
      counters.network += 1;
      counters.creates.add(p.request_id);
      return Promise.resolve({ challenge_id: 'C-1', deep_link: 'd', share_url: 's' });
    },
  };
}
const newCounters = () => ({
  network: 0, sourceStarts: 0, mounts: 0,
  offers: new Set(), tickets: new Set(), results: new Set(), creates: new Set(),
});

// ══ PROBE 1 — initial-write failure: typed throw, and ZERO network ═══════════
{
  const counters = newCounters();
  const storage = storageDouble({ failWrite: true });
  let env = null;
  throwsEnvelope(() => { env = openSourceEnvelope(storage, mint); }, 'PROBE1: failed initial persist must throw challenge_envelope_not_persisted');
  // A contract-following caller cannot have an envelope → it must not go to network.
  if (env) await playSourceChallenge(sourceDeps(counters), { mechanicId: 'm', variantId: 'v' }, env).catch(() => {});
  equal(counters.network, 0, 'PROBE1: networkCallsAfterFailedPersist must be 0');
  equal(counters.mounts, 0, 'PROBE1: no level mount without durable identity');
}
// PROBE 1b — the silent-drop variant: setItem does not throw but nothing sticks.
{
  const storage = storageDouble({ dropWrites: true });
  throwsEnvelope(() => openSourceEnvelope(storage, mint), 'PROBE1b: read-back verification must catch a dropped write');
}

// ══ PROBE 2 — checkpoint failure + reload: abort, resume, level played ONCE ═══
{
  const counters = newCounters();
  // Allow exactly the initial persist (1 write); every later checkpoint fails.
  const storage = storageDouble({ failWritesAfter: 1 });
  const env1 = openSourceEnvelope(storage, mint);
  const idsSnapshot = { ...env1.ids };
  await assert.rejects(
    playSourceChallenge(sourceDeps(counters), { mechanicId: 'm', variantId: 'v' }, env1),
    isEnvelopeError,
    'PROBE2: a failed checkpoint must reject with challenge_envelope_not_persisted',
  );
  assertions += 1;
  // The flow ABORTED at the failed checkpoint: nothing past it may have happened.
  equal(counters.mounts, 0, 'PROBE2: no mount after a failed checkpoint (flow aborted)');
  equal(counters.results.size, 0, 'PROBE2: nothing reported after a failed checkpoint');
  equal(counters.creates.size, 0, 'PROBE2: no challenge created after a failed checkpoint');

  // "reload" with healed storage: same durable ids, resume, finish.
  const healed = storageDouble();
  healed.map.set(SOURCE_ENVELOPE_KEY, storage.map.get(SOURCE_ENVELOPE_KEY));
  const env2 = openSourceEnvelope(healed, mint);
  assert.deepEqual(env2.ids, idsSnapshot, 'PROBE2: reload reuses the durable ids'); assertions += 1;
  await playSourceChallenge(sourceDeps(counters), { mechanicId: 'm', variantId: 'v' }, env2);
  equal(counters.mounts, 1, 'PROBE2: the level is played EXACTLY once across failure+reload');
  equal(counters.offers.size, 1, 'PROBE2: exactly one offer identity');
  equal(counters.tickets.size, 1, 'PROBE2: exactly one source ticket (repeat run.start is an idempotent replay)');
  equal(counters.results.size, 1, 'PROBE2: exactly one reported run');
  equal(counters.creates.size, 1, 'PROBE2: exactly one challenge create identity');
}

// ══ PROBE 3 — terminal-clear failure: never resumed, clear retried ═══════════
{
  const counters = newCounters();
  const storage = storageDouble({ failRemove: true });
  const env = openSourceEnvelope(storage, mint);
  const finishedIds = { ...env.ids };
  const out = await playSourceChallenge(sourceDeps(counters), { mechanicId: 'm', variantId: 'v' }, env);
  equal(out.created.challenge_id, 'C-1', 'PROBE3: source flow completed');
  equal(env.clear(), false, 'PROBE3: clear() reports failure without throwing');
  ok(storage.map.has(SOURCE_ENVELOPE_KEY), 'PROBE3: the terminal record survived the failed clear');

  // A NEW tap must NOT resume the finished op (that would re-share / re-issue).
  const env2 = openSourceEnvelope(storage, mint);
  equal(env2.getPhase(), 'init', 'PROBE3: a terminal envelope is treated as finished, not resumed');
  ok(env2.ids.requestId !== finishedIds.requestId, 'PROBE3: the new operation gets fresh ids');
  const before = counters.mounts;
  await playSourceChallenge(sourceDeps(counters), { mechanicId: 'm', variantId: 'v' }, env2);
  equal(counters.mounts, before + 1, 'PROBE3: the new op plays its own level once');
  equal(counters.creates.size, 2, 'PROBE3: the new op creates its OWN challenge (no re-issue of the old one)');
}

// ══ corrupt / unreadable existing envelope → fail closed, ids NOT re-minted ══
{
  const storage = storageDouble();
  storage.map.set(SOURCE_ENVELOPE_KEY, '{not json');
  const before = storage.map.get(SOURCE_ENVELOPE_KEY);
  throwsEnvelope(() => openSourceEnvelope(storage, mint), 'corrupt envelope must fail closed');
  equal(storage.map.get(SOURCE_ENVELOPE_KEY), before, 'corrupt envelope is NOT replaced with fresh ids');
}
{
  const storage = storageDouble({ failRead: true });
  throwsEnvelope(() => openSourceEnvelope(storage, mint), 'unreadable storage must fail closed');
}

console.log(`check-challenge-envelope: ${assertions} assertions passed (fail-closed: initial write, checkpoint, terminal clear)`);
