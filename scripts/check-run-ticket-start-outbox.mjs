import assert from 'node:assert/strict';

import { DurableRunTicketStartOutbox } from '../src/run-ticket-start-outbox.mjs';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const request = {
  ticket_id: '00000000-0000-4000-8000-000000000001',
  run_id: 'run-1',
  mechanic_id: 'marble-sort-swipe',
  variant_id: '00000000-0000-4000-8000-000000000002',
  kind: 'single',
};
const storage = new MemoryStorage();
let mode = 'retry';
let calls = 0;
const startRun = async (received) => {
  calls += 1;
  const persisted = JSON.parse(storage.getItem('queue') || '[]');
  assert.equal(persisted[0].request.ticket_id, received.ticket_id, 'persist-before-send');
  if (mode === 'retry') throw Object.assign(new Error('offline'), { status: 0 });
  if (mode === 'terminal') throw Object.assign(new Error('binding mismatch'), { status: 409 });
  return {
    ticket_id: received.ticket_id,
    run_id: received.run_id,
    state: mode === 'expired' ? 'expired' : 'active',
  };
};
const options = {
  storage,
  queueKey: 'queue',
  deadLetterKey: 'dead',
  startRun,
  now: () => Date.parse('2026-07-13T12:00:00.000Z'),
};

const first = new DurableRunTicketStartOutbox(options);
assert.equal(first.enqueue(request), true);
request.mechanic_id = 'mutated-after-enqueue';
assert.equal(JSON.parse(storage.getItem('queue'))[0].request.mechanic_id, 'marble-sort-swipe');
assert.equal((await first.flush()).status, 'retry');
assert.equal(first.pendingCount(), 1);

// A new page instance recovers and retries the same persisted identity.
mode = 'ok';
const reloaded = new DurableRunTicketStartOutbox(options);
const recovered = await reloaded.flush();
assert.equal(recovered.confirmed, 1);
assert.equal(reloaded.pendingCount(), 0);
assert.equal(calls, 2);

const second = { ...request, mechanic_id: 'marble-sort-swipe', ticket_id: 'ticket-2', run_id: 'run-2' };
assert.equal(reloaded.enqueue(second), true);
assert.equal(reloaded.enqueue({ ...second }), false, 'exact duplicate is idempotent');
assert.throws(() => reloaded.enqueue({ ...second, mechanic_id: 'other' }), /identity conflict/);

mode = 'terminal';
const terminal = await reloaded.flush();
assert.equal(terminal.terminal, 1);
assert.equal(reloaded.pendingCount(), 0);
assert.equal(reloaded.deadLetters()[0].reason, 'http_409');

mode = 'expired';
reloaded.enqueue({ ...second, ticket_id: 'ticket-3', run_id: 'run-3' });
const expired = await reloaded.flush();
assert.equal(expired.terminal, 1);
assert.equal(reloaded.deadLetterCount(), 2);
assert.equal(reloaded.deadLetters()[1].reason, 'ticket_expired');

let forbiddenNetworkCalls = 0;
const blocked = new DurableRunTicketStartOutbox({
  storage: {
    getItem: () => null,
    setItem: () => { throw new Error('storage blocked'); },
  },
  queueKey: 'queue',
  deadLetterKey: 'dead',
  startRun: async () => { forbiddenNetworkCalls += 1; return {}; },
});
assert.throws(() => blocked.enqueue({ ...second, ticket_id: 'ticket-4', run_id: 'run-4' }), /storage blocked/);
assert.equal(forbiddenNetworkCalls, 0, 'an unpersisted start is never sent');

console.log('run-ticket start outbox: 20 assertions passed');
