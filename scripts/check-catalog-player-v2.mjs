import assert from 'node:assert/strict';

import {
  CatalogPlayerV2ContractError,
  CatalogPlayerV2Session,
  buildCatalogConfigurationFailure,
  buildCatalogFrameNavigation,
  buildCatalogLevelImpression,
  buildCatalogPlayerLevelBinding,
  catalogPlayerV2Enabled,
  validateCatalogTicketLevelSpecBundle,
} from '../src/catalog-player-v2.mjs';

let assertions = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}
function throws(fn, matcher, message) {
  assert.throws(fn, matcher, message);
  assertions += 1;
}

const ids = {
  ticket: '00000000-0000-4000-8000-000000000001',
  decision: '00000000-0000-4000-8000-000000000002',
  entry: '00000000-0000-4000-8000-000000000003',
  series: '00000000-0000-4000-8000-000000000004',
  release: '00000000-0000-4000-8000-000000000005',
  variant: '00000000-0000-4000-8000-000000000006',
  impression: '00000000-0000-4000-8000-000000000007',
  levelImpression: '00000000-0000-4000-8000-000000000008',
};
const contractDigest = 'c'.repeat(64);
const artifactDigest = `sha256:${'d'.repeat(64)}`;
const specHash1 = '1'.repeat(64);
const specHash2 = '2'.repeat(64);

function spec(specHash, seed) {
  return {
    schema: 'sort.level-spec.v1',
    specHash,
    runtimeContractDigest: contractDigest,
    seed,
    params: {
      gridCols: 6,
      gridRows: 5,
      colorsUsed: 3,
      cellColorMap: Array.from({ length: 30 }, (_, index) => index % 3),
      targetStacks: [[0], [1], [2], [0]],
      convSpeedMul: 1,
      modifiers: [],
    },
  };
}

function bundle() {
  const artifactHex = artifactDigest.slice(7);
  return {
    schema: 'catalog.ticket-level-spec-bundle.v1',
    ticketId: ids.ticket,
    ticketState: 'active',
    decisionId: ids.decision,
    catalogEntryId: ids.entry,
    seriesId: ids.series,
    manifestContentHash: 'e'.repeat(64),
    runtime: {
      releaseId: ids.release,
      playableId: 'marble-sort-swipe',
      legacyVariantId: ids.variant,
      runtimeContractDigest: contractDigest,
      runtimeArtifactDigest: artifactDigest,
      indexLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/index.html`,
      sidecarLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/runtime-artifact.json`,
      capabilities: { catalogRequiredHandshake: true, sortLevelSpecV1: true },
    },
    levels: [
      { ordinal: 1, specHash: specHash1, spec: spec(specHash1, 11) },
      { ordinal: 2, specHash: specHash2, spec: spec(specHash2, 12) },
    ],
  };
}

equal(catalogPlayerV2Enabled({}, true), false, 'catalog is off by default');
equal(catalogPlayerV2Enabled({ VITE_CATALOG_PLAYER_V2_ENABLED: 'true' }, false), false, 'CP is a second gate');
equal(catalogPlayerV2Enabled({ VITE_CATALOG_PLAYER_V2_ENABLED: 'TRUE' }, true), true, 'both explicit gates enable the adapter');

const frozenBundle = validateCatalogTicketLevelSpecBundle(bundle());
equal(Object.isFrozen(frozenBundle), true);
equal(Object.isFrozen(frozenBundle.levels[0].spec.params), true);
const mutatedInput = bundle();
const validated = validateCatalogTicketLevelSpecBundle(mutatedInput);
mutatedInput.runtime.playableId = 'changed';
equal(validated.runtime.playableId, 'marble-sort-swipe', 'validated wire is cloned');

const extra = bundle();
extra.untrusted = true;
throws(() => validateCatalogTicketLevelSpecBundle(extra), /unsupported shape/);
const gap = bundle();
gap.levels[1].ordinal = 3;
throws(() => validateCatalogTicketLevelSpecBundle(gap), /contiguous/);
const wrongEmbeddedHash = bundle();
wrongEmbeddedHash.levels[0].spec.specHash = '3'.repeat(64);
throws(() => validateCatalogTicketLevelSpecBundle(wrongEmbeddedHash), /differs from embedded/);
const wrongContract = bundle();
wrongContract.levels[0].spec.runtimeContractDigest = '4'.repeat(64);
throws(() => validateCatalogTicketLevelSpecBundle(wrongContract), /runtime contract differs/);

const binding = buildCatalogPlayerLevelBinding(bundle(), 1, 7);
equal(binding.ordinal, 1);
equal(binding.specHash, specHash1);
equal(Object.isFrozen(binding.spec), true);
throws(() => buildCatalogPlayerLevelBinding(bundle(), 3, 7), /outside the immutable ticket manifest/);
throws(() => buildCatalogPlayerLevelBinding(bundle(), 1, 0), /frameEpoch/);

const navigation = buildCatalogFrameNavigation(binding, 'http://localhost:4173/feed/path');
equal(navigation.src, `http://localhost:4173/runtime-releases/marble-sort-swipe/${'d'.repeat(64)}/index.html?level_config=catalog_required&expected_spec_hash=${specHash1}`);
equal(navigation.expectedOrigin, 'http://localhost:4173');
equal(navigation.referrerPolicy, 'origin');
const absoluteBundle = bundle();
absoluteBundle.runtime.indexLocator = `https://runtime.example.test/runtime-releases/marble-sort-swipe/${'d'.repeat(64)}/index.html`;
const absoluteBinding = buildCatalogPlayerLevelBinding(absoluteBundle, 1, 1);
equal(buildCatalogFrameNavigation(absoluteBinding, 'https://feed.example.test').expectedOrigin, 'https://runtime.example.test');
const nestedIndexBundle = bundle();
nestedIndexBundle.runtime.indexLocator = `runtime-releases/marble-sort-swipe/${'d'.repeat(64)}/game/player.html`;
equal(
  buildCatalogFrameNavigation(
    buildCatalogPlayerLevelBinding(nestedIndexBundle, 1, 1),
    'https://feed.example.test',
  ).src,
  `https://feed.example.test/runtime-releases/marble-sort-swipe/${'d'.repeat(64)}/game/player.html?level_config=catalog_required&expected_spec_hash=${specHash1}`,
  'the server-owned descriptor may use any safe file below the exact digest root',
);
const mutableBundle = bundle();
mutableBundle.runtime.indexLocator = 'runtime-releases/marble-sort-swipe/latest/index.html';
throws(() => buildCatalogFrameNavigation(buildCatalogPlayerLevelBinding(mutableBundle, 1, 1), 'https://feed.example.test'), /content-addressed/);

const failure = buildCatalogConfigurationFailure(binding, 'mount');
deepEqual(Object.keys(failure).sort(), [
  'decision_id', 'expected_spec_hash', 'ordinal', 'reason', 'runtime_release_id', 'series_id', 'ticket_id',
]);
equal('impression_id' in failure, false, 'pre-reveal failure cannot invent an impression');
const impression = buildCatalogLevelImpression(binding, ids.impression, ids.levelImpression);
deepEqual(Object.keys(impression).sort(), [
  'applied_spec_hash', 'catalog_entry_id', 'decision_id', 'impression_id', 'level_impression_id',
  'level_spec_hash', 'ordinal', 'runtime_artifact_digest', 'runtime_contract_digest',
  'runtime_release_id', 'series_id', 'ticket_id',
]);
equal(impression.applied_spec_hash, specHash1);
equal(Object.isFrozen(impression), true);

const frameSource = {};
const session = new CatalogPlayerV2Session({
  bundle: bundle(),
  ordinal: 1,
  frameEpoch: 9,
  frameSource,
  baseUrl: 'https://feed.example.test/app',
});
throws(() => { session.binding = {}; }, TypeError, 'session identity is non-writable');
equal(session.setVisible(true, 9).effects.length, 0, 'visibility alone cannot reveal');
const readyData = {
  type: 'configure_ready',
  nonce: 'a'.repeat(32),
  runtimeContractDigest: contractDigest,
  runtimeArtifactDigest: artifactDigest,
};
equal(session.handleMessage({ source: {}, origin: 'https://feed.example.test', data: readyData }, 9).reason, 'source');
equal(session.handleMessage({ source: frameSource, origin: 'https://evil.example', data: readyData }, 9).reason, 'origin');
equal(session.handleMessage({ source: frameSource, origin: 'https://feed.example.test', data: readyData }, 8).reason, 'stale_epoch');
const ready = session.handleMessage({ source: frameSource, origin: 'https://feed.example.test', data: readyData }, 9);
equal(ready.status, 'accepted');
equal(ready.phase, 'awaiting_configured');
equal(ready.effects[0].type, 'post_configure_level');
equal(ready.effects[0].targetOrigin, 'https://feed.example.test');
equal(ready.effects[0].message.nonce, 'a'.repeat(32));
equal(ready.effects[0].message.spec.specHash, specHash1);

const configuredData = {
  type: 'configured',
  appliedSpecHash: specHash1,
  runtimeContractDigest: contractDigest,
  runtimeArtifactDigest: artifactDigest,
};
const configured = session.handleMessage({
  source: frameSource,
  origin: 'https://feed.example.test',
  data: configuredData,
}, 9);
equal(configured.status, 'accepted');
equal(configured.effects.length, 1);
equal(configured.effects[0].type, 'catalog_reveal_ready');
equal(session.snapshot().revealClaimed, true);
equal(session.handleMessage({ source: frameSource, origin: 'https://feed.example.test', data: configuredData }, 9).reason, 'duplicate_configured');
equal(session.setVisible(true, 9).effects.length, 0, 'reveal is claimed once');
equal(session.dispose(8), false, 'stale disposal cannot fence the current frame');
equal(session.dispose(9), true);
equal(session.snapshot().phase, 'disposed');

const warmFrame = {};
const warmSession = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 20, frameSource: warmFrame, baseUrl: 'https://feed.example.test',
});
equal(warmSession.handleMessage({
  source: warmFrame, origin: 'https://feed.example.test', data: readyData,
}, 20).effects[0].type, 'post_configure_level');
equal(warmSession.handleMessage({
  source: warmFrame, origin: 'https://feed.example.test', data: configuredData,
}, 20).effects.length, 0, 'configured offscreen content is not an impression');
equal(warmSession.setVisible(true, 20).effects[0].type, 'catalog_reveal_ready');

const badRuntime = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 2, frameEpoch: 10, frameSource, baseUrl: 'https://feed.example.test',
});
const badRuntimeResult = badRuntime.handleMessage({
  source: frameSource,
  origin: 'https://feed.example.test',
  data: { ...readyData, runtimeArtifactDigest: `sha256:${'f'.repeat(64)}` },
}, 10);
equal(badRuntimeResult.status, 'failed');
equal(badRuntimeResult.reason, 'runtime');
equal(badRuntimeResult.effects[0].type, 'catalog_configuration_failure');
equal(badRuntimeResult.effects[0].payload.ordinal, 2);
equal(badRuntimeResult.effects[0].payload.expected_spec_hash, specHash2);
equal('impression_id' in badRuntimeResult.effects[0].payload, false);
equal(badRuntime.setVisible(true, 10).effects.length, 0, 'failed configuration can never reveal');

const wrongAppliedFrame = {};
const wrongApplied = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 21, frameSource: wrongAppliedFrame, baseUrl: 'https://feed.example.test',
});
wrongApplied.handleMessage({
  source: wrongAppliedFrame, origin: 'https://feed.example.test', data: readyData,
}, 21);
equal(wrongApplied.handleMessage({
  source: wrongAppliedFrame,
  origin: 'https://feed.example.test',
  data: { ...configuredData, appliedSpecHash: specHash2 },
}, 21).reason, 'digest', 'applied hash must equal the current manifest ordinal');

const premature = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 11, frameSource, baseUrl: 'https://feed.example.test',
});
equal(premature.handleMessage({
  source: frameSource, origin: 'https://feed.example.test', data: configuredData,
}, 11).reason, 'contract', 'configured before ready fails closed');

const malformed = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 12, frameSource, baseUrl: 'https://feed.example.test',
});
equal(malformed.handleMessage({
  source: frameSource,
  origin: 'https://feed.example.test',
  data: { ...readyData, extra: true },
}, 12).reason, 'contract', 'trusted protocol envelopes require exact keys');

const runtimeFailure = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 13, frameSource, baseUrl: 'https://feed.example.test',
});
equal(runtimeFailure.handleMessage({
  source: frameSource,
  origin: 'https://feed.example.test',
  data: { type: 'configure_failed', reason: 'mount' },
}, 13).reason, 'mount');

const hostTimeout = new CatalogPlayerV2Session({
  bundle: bundle(), ordinal: 1, frameEpoch: 14, frameSource, baseUrl: 'https://feed.example.test',
});
equal(hostTimeout.fail('timeout', 13).reason, 'stale_epoch');
const hostTimeoutResult = hostTimeout.fail('timeout', 14);
equal(hostTimeoutResult.status, 'failed');
equal(hostTimeoutResult.effects[0].payload.reason, 'timeout');

throws(
  () => buildCatalogLevelImpression(binding, 'not-a-uuid', ids.levelImpression),
  (error) => error instanceof CatalogPlayerV2ContractError && error.code === 'invalid_uuid',
);

console.log(`catalog player v2 transport: ${assertions} assertions passed`);
