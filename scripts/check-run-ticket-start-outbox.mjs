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

const v2Request = {
  schema: 'run.start.v2',
  ticket_id: '00000000-0000-4000-8000-000000000011',
  run_id: 'catalog-root-1',
  mechanic_id: 'marble-sort-swipe',
  variant_id: '00000000-0000-4000-8000-000000000012',
  kind: 'series',
  decision_id: '00000000-0000-4000-8000-000000000013',
  challenge_id: null,
};
function v2View(received, state = 'active') {
  return {
    schema: 'run.ticket.v2',
    ticket_id: received.ticket_id,
    run_id: received.run_id,
    kind: 'series',
    mechanic_id: received.mechanic_id,
    variant_id: received.variant_id,
    decision_id: received.decision_id,
    catalog_entry_id: '00000000-0000-4000-8000-000000000014',
    series_id: '00000000-0000-4000-8000-000000000015',
    runtime_release_id: '00000000-0000-4000-8000-000000000016',
    runtime_contract_digest: 'c'.repeat(64),
    runtime_artifact_digest: `sha256:${'d'.repeat(64)}`,
    manifest_content_hash: 'e'.repeat(64),
    levels: [
      { ordinal: 1, spec_hash: '1'.repeat(64) },
      { ordinal: 2, spec_hash: '2'.repeat(64) },
    ],
    expected_levels: 2,
    completed_levels: 0,
    next_result_at: '2026-07-13T12:00:01+00:00',
    expires_at: '2026-07-13T12:10:00+00:00',
    state,
  };
}

const v2Storage = new MemoryStorage();
let v2Mode = 'active';
const v2Outbox = new DurableRunTicketStartOutbox({
  storage: v2Storage,
  queueKey: 'v2-queue',
  deadLetterKey: 'v2-dead',
  startRun: async (received) => {
    if (v2Mode === 'stable-code') {
      throw Object.assign(new Error('decision binding mismatch'), {
        status: 409,
        code: 'catalog_ticket_idempotency_conflict',
      });
    }
    const view = v2View(received, v2Mode === 'revoked' ? 'revoked' : 'active');
    if (v2Mode === 'invalid-manifest') view.levels[1].ordinal = 3;
    return view;
  },
});
assert.equal(v2Outbox.enqueue(v2Request), true);
const v2Confirmed = await v2Outbox.flush();
assert.equal(v2Confirmed.status, 'ok');
assert.equal(v2Confirmed.confirmed, 1);
assert.equal(v2Confirmed.latest.schema, 'run.ticket.v2');
assert.equal(v2Confirmed.latest.levels[1].ordinal, 2);

v2Mode = 'invalid-manifest';
v2Outbox.enqueue({ ...v2Request, ticket_id: '00000000-0000-4000-8000-000000000021', run_id: 'catalog-root-2' });
const invalidManifest = await v2Outbox.flush();
assert.equal(invalidManifest.status, 'invalid_response');
assert.equal(invalidManifest.pending, 1, 'an invalid v2 response remains durable');
v2Mode = 'active';
assert.equal((await v2Outbox.flush()).confirmed, 1);

v2Mode = 'revoked';
v2Outbox.enqueue({ ...v2Request, ticket_id: '00000000-0000-4000-8000-000000000022', run_id: 'catalog-root-3' });
const revoked = await v2Outbox.flush();
assert.equal(revoked.terminal, 1);
assert.equal(v2Outbox.deadLetters().at(-1).reason, 'ticket_revoked');

v2Mode = 'stable-code';
v2Outbox.enqueue({ ...v2Request, ticket_id: '00000000-0000-4000-8000-000000000023', run_id: 'catalog-root-4' });
assert.equal((await v2Outbox.flush()).terminal, 1);
assert.equal(v2Outbox.deadLetters().at(-1).reason, 'catalog_ticket_idempotency_conflict');
assert.throws(
  () => v2Outbox.enqueue({
    ...v2Request,
    ticket_id: '00000000-0000-4000-8000-000000000024',
    run_id: 'catalog-root-5',
    challenge_id: undefined,
  }),
  /exact catalog wire/,
);
assert.throws(
  () => v2Outbox.enqueue({
    ...v2Request,
    ticket_id: '00000000-0000-4000-8000-000000000025',
    run_id: 'catalog-root-6',
    decision_id: undefined,
  }),
  /decision_id must be a canonical UUID/,
);

console.log('run-ticket start outbox: legacy + strict catalog-v2 checks passed');
