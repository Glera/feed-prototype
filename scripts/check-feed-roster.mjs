import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEED_ROSTER_SNAPSHOT_KEY,
  buildBuiltinFeedDecisionV2,
  feedRosterIdentityJcs,
  loadFeedRosterSessionSnapshot,
  loadVerifiedFeedRosterSessionSnapshot,
  parseFeedRosterSessionV1,
  resolveFeedRosterSession,
  stageFeedRosterForNextSession,
  verifyFeedRosterSessionV1,
} from '../src/feed-roster.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Localized copy of the backend-owned golden so this check is self-contained in CI
// (the private swipe-backend repo is not checked out). Drift vs the sibling is
// guarded below.
const fixturePath = path.resolve(root, 'test-fixtures/feed-roster-session-v1.golden.json');
const backendFixturePath = path.resolve(
  root,
  '../swipe-backend/docs/specs/fixtures/feed-roster-session-v1.golden.json',
);
const EXPECTED_FIXTURE_FILE_SHA256 = '03d64c156d706d98d88d4c103b5a940fc5313f310a84a80289a64c2052454272';
let fixtureBytes;
try { fixtureBytes = readFileSync(fixturePath); } catch (error) {
  throw new Error(`canonical roster fixture is required at ${fixturePath}: ${error.message}`);
}
assert.equal(
  createHash('sha256').update(fixtureBytes).digest('hex'),
  EXPECTED_FIXTURE_FILE_SHA256,
  'canonical roster fixture changed without a reviewed schema/version update',
);
// Drift guard: when the private backend is checked out as a sibling, the local
// copy must match it byte-for-byte; in CI (no sibling) this is skipped.
if (existsSync(backendFixturePath)) {
  assert.ok(
    readFileSync(backendFixturePath).equals(fixtureBytes),
    'local test-fixtures/feed-roster-session-v1.golden.json drifted from ../swipe-backend'
      + ` — refresh it: cp "${backendFixturePath}" "${fixturePath}"`,
  );
}
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const golden = fixture.sessionProjection;

assert.deepEqual(parseFeedRosterSessionV1(golden), golden);
assert.equal(feedRosterIdentityJcs(golden), fixture.expectedIdentityJcs);
assert.equal((await verifyFeedRosterSessionV1(golden, webcrypto)).rosterHash, fixture.expectedRosterHash);

assert.throws(
  () => parseFeedRosterSessionV1({ ...golden, unexpected: true }),
  /only schema, activationId, rosterHash and entries/,
);
assert.throws(
  () => parseFeedRosterSessionV1({ ...golden, entries: [...golden.entries, golden.entries[0]] }),
  /must be unique/,
);
await assert.rejects(
  verifyFeedRosterSessionV1({ ...golden, rosterHash: 'f'.repeat(64) }, webcrypto),
  /does not match/,
);

const baked = [
  { id: 'baked-one' }, { id: 'baked-two' }, { id: 'baked-three' }, { id: 'baked-four' },
];
const absent = resolveFeedRosterSession(null, baked, () => true);
assert.equal(absent.source, 'baked');
assert.deepEqual(absent.playables, baked);
assert.deepEqual(absent.entries, baked.map(() => null));

const allAvailable = resolveFeedRosterSession(golden, baked, () => true);
assert.equal(allAvailable.source, 'roster');
assert.deepEqual(allAvailable.playables.map((item) => item.id), [
  'marble-sort-swipe', 'merge-locked-v1-swipe', 'pins-swipe',
]);
assert.deepEqual(allAvailable.entries.map((item) => item.builtinMappingId),
  golden.entries.map((item) => item.builtinMappingId));

const oneUnavailable = resolveFeedRosterSession(
  golden,
  baked,
  (playableId) => playableId !== 'merge-locked-v1-swipe',
);
assert.equal(oneUnavailable.source, 'fallback');
assert.deepEqual(oneUnavailable.playables, baked, '<3 available items restores the complete baked roster');
assert.deepEqual(oneUnavailable.unavailable, [{
  builtinMappingId: golden.entries[1].builtinMappingId,
  playableId: 'merge-locked-v1-swipe',
  reason: 'not_deployed',
}]);

const fourthEntry = {
  builtinMappingId: '88888888-8888-4888-8888-888888888888',
  playableId: 'fourth-playable',
  variantId: '99999999-9999-4999-8999-999999999999',
  catalogMechanic: 'fourth',
  mappingDigest: '4'.repeat(64),
  mappingState: 'active',
};
const skipOne = resolveFeedRosterSession(
  { ...golden, entries: [...golden.entries, fourthEntry] },
  baked,
  (playableId) => playableId !== 'merge-locked-v1-swipe',
);
assert.equal(skipOne.source, 'roster');
assert.equal(skipOne.availableCount, 3);
assert.deepEqual(skipOne.playables.map((item) => item.id), [
  'marble-sort-swipe', 'pins-swipe', 'fourth-playable',
], 'one unavailable unit is skipped while a viable server roster remains');

const retiredProjection = {
  ...golden,
  entries: golden.entries.map((entry, index) => index === 2
    ? { ...entry, mappingState: 'retired' }
    : entry),
};
const retired = resolveFeedRosterSession(retiredProjection, baked, () => true);
assert.equal(retired.source, 'fallback');
assert.equal(retired.unavailable[0].reason, 'retired');

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
assert.equal(loadFeedRosterSessionSnapshot(storage), null);
assert.equal((await stageFeedRosterForNextSession(storage, golden, webcrypto)).status, 'staged');
const currentSessionSnapshot = loadFeedRosterSessionSnapshot(storage);
assert.equal(currentSessionSnapshot.activationId, golden.activationId);
assert.equal(
  (await loadVerifiedFeedRosterSessionSnapshot(storage, webcrypto)).activationId,
  golden.activationId,
);

const reversedEntries = [...golden.entries].reverse();
const reversedIdentityJcs = JSON.stringify({
  entries: reversedEntries.map((entry) => ({ builtinMappingId: entry.builtinMappingId })),
  schema: golden.schema,
});
const reversed = {
  ...golden,
  activationId: '55555555-5555-4555-8555-555555555555',
  rosterHash: createHash('sha256').update(reversedIdentityJcs).digest('hex'),
  entries: reversedEntries,
};
assert.equal((await stageFeedRosterForNextSession(storage, reversed, webcrypto)).status, 'staged');
assert.deepEqual(
  currentSessionSnapshot.entries.map((entry) => entry.playableId),
  golden.entries.map((entry) => entry.playableId),
  'staging a response cannot mutate the snapshot already selected for this session',
);
assert.deepEqual(
  loadFeedRosterSessionSnapshot(storage).entries.map((entry) => entry.playableId),
  reversedEntries.map((entry) => entry.playableId),
  'the newly staged activation applies on the next session load',
);

assert.equal((await stageFeedRosterForNextSession(storage, undefined, webcrypto)).status, 'baked');
assert.equal(storage.getItem(FEED_ROSTER_SNAPSHOT_KEY), null, 'absent server field clears stale authority');
storage.setItem(FEED_ROSTER_SNAPSHOT_KEY, '{corrupt');
assert.equal(loadFeedRosterSessionSnapshot(storage), null);
assert.equal(storage.getItem(FEED_ROSTER_SNAPSHOT_KEY), null);
storage.setItem(FEED_ROSTER_SNAPSHOT_KEY, JSON.stringify({ ...golden, rosterHash: 'e'.repeat(64) }));
assert.equal(await loadVerifiedFeedRosterSessionSnapshot(storage, webcrypto), null);
assert.equal(storage.getItem(FEED_ROSTER_SNAPSHOT_KEY), null, 'hash-mismatched persisted snapshot is discarded');

assert.deepEqual(buildBuiltinFeedDecisionV2(
  '66666666-6666-4666-8666-666666666666',
  golden.entries[0],
  golden.activationId,
  7,
), {
  decision_id: '66666666-6666-4666-8666-666666666666',
  mapping_id: golden.entries[0].builtinMappingId,
  roster_activation_id: golden.activationId,
  feed_position: 7,
});

console.log('feed roster contract: 37 assertions');
