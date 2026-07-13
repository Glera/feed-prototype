import assert from 'node:assert/strict';

import { DurableControlPlaneOutbox } from '../src/control-plane-outbox.mjs';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

class FailingStorage extends MemoryStorage {
  setItem() { throw new Error('quota exceeded'); }
}

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
let now = Date.parse('2026-07-13T10:00:00.000Z');
const storage = new MemoryStorage();
const requests = [];
let responseMode = 'mixed';
const fetcher = async (_url, request) => {
  const batch = JSON.parse(request.body).events;
  requests.push(batch);
  if (responseMode === 'throw') throw new Error('offline');
  if (responseMode === 'missing') return { ok: true, json: async () => ({ events: [] }) };
  return {
    ok: true,
    json: async () => ({
      events: batch.map((event, index) => ({
        event_id: event.event_id,
        item_index: index,
        status: responseMode === 'mixed' && index === 1 ? 'rejected'
          : responseMode === 'pending' ? 'pending_dependency' : 'projected',
        reject_reason: responseMode === 'mixed' && index === 1 ? 'invalid_payload' : null,
      })),
    }),
  };
};
const options = {
  storage,
  storageKey: 'cp:test',
  endpoint: 'https://example.test/api/cp/events',
  sessionId: 'session-1',
  authorization: () => 'tma signed',
  fetcher,
  now: () => now,
  uuid,
};

const first = new DurableControlPlaneOutbox(options);
const event0 = first.enqueue('session_resume', {});
const event1 = first.enqueue('session_pause', {});
assert.equal(event0.seq, 0);
assert.equal(event1.seq, 1);
assert.equal(event0.client_instance_id, event1.client_instance_id);
event0.payload.mutated_after_enqueue = true;

// Reload sees the same durable queue and client sequence.
const reloaded = new DurableControlPlaneOutbox(options);
assert.equal(reloaded.pendingCount(), 2);
const mixed = await reloaded.flush();
assert.deepEqual(
  { status: mixed.status, acknowledged: mixed.acknowledged, rejected: mixed.rejected, pending: mixed.pending },
  { status: 'ok', acknowledged: 1, rejected: 1, pending: 0 },
);
assert.equal(reloaded.deadLetterCount(), 1);
assert.equal(reloaded.deadLetters()[0].rejectReason, 'invalid_payload');
assert.equal(requests[0][0].payload.mutated_after_enqueue, undefined);

responseMode = 'pending';
reloaded.enqueue('attempt_start', { run_id: 'r1' });
assert.equal((await reloaded.flush()).acknowledged, 1);
assert.equal(reloaded.pendingCount(), 0, 'pending_dependency is durable on the server');

// A transport failure persists the item and enforces exponential retry time.
responseMode = 'throw';
const retryEvent = reloaded.enqueue('session_pause', {});
const failed = await reloaded.flush();
assert.equal(failed.status, 'transport_error');
assert.equal(failed.retryInMs, 1000);
assert.equal(reloaded.pendingCount(), 1);
assert.equal((await reloaded.flush()).status, 'backoff');

// Forced retry models foreground recovery / a lost response duplicate ACK.
now += 100;
responseMode = 'ok';
assert.equal((await reloaded.flush({ force: true })).pending, 0);
assert.equal(requests.at(-1)[0].event_id, retryEvent.event_id);

responseMode = 'missing';
reloaded.enqueue('session_resume', {});
const missing = await reloaded.flush({ force: true });
assert.equal(missing.status, 'missing_ack');
assert.equal(reloaded.pendingCount(), 1);
responseMode = 'ok';
assert.equal((await reloaded.flush({ force: true })).pending, 0);

const finalReload = new DurableControlPlaneOutbox(options);
const next = finalReload.enqueue('session_pause', {});
assert.equal(next.seq, 5, 'sequence survives ACK removal and page reload');

// Persist-before-ack: a blocked/full storage must not let the caller mark the
// event emitted. The in-memory mutation is rolled back as well.
const blocked = new DurableControlPlaneOutbox({
  ...options,
  storage: new FailingStorage(),
  storageKey: 'cp:blocked',
});
assert.equal(blocked.enqueue('session_pause', {}), null);
assert.equal(blocked.pendingCount(), 0);

// Flush coalescing must not strand an event enqueued on the microtask tail of
// an already-started empty flush (the exact initControlPlane/bootstrap race).
responseMode = 'ok';
const coalesced = new DurableControlPlaneOutbox({ ...options, storageKey: 'cp:coalesced' });
const initiallyEmpty = coalesced.flush();
const coalescedEvent = coalesced.enqueue('session_resume', {});
const joined = coalesced.flush();
assert.equal(joined, initiallyEmpty);
await joined;
assert.equal(coalesced.pendingCount(), 0);
assert.equal(requests.at(-1)[0].event_id, coalescedEvent.event_id);

console.log('control-plane outbox: 28 assertions passed');
