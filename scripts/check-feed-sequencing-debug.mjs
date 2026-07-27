import nodeAssert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedSequencingDebugContractError,
  SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT,
  SEQUENCING_DEBUG_HISTORY_LIMIT_MAX,
  SEQUENCING_DEBUG_HISTORY_SCHEMA,
  SEQUENCING_DEBUG_PATHS,
  SEQUENCING_DEBUG_PROFILE_SCHEMA,
  SEQUENCING_DEBUG_WHY_NOW_SCHEMA,
  buildSequencingDebugPath,
  buildSequencingDebugView,
  formatSequencingJson,
  formatSequencingSnapshotAge,
  formatSequencingTimestamp,
  normalizeSequencingHistoryLimit,
  normalizeSequencingSubject,
  parseSequencingDebugHistoryV1,
  parseSequencingDebugProfileV1,
  parseSequencingDebugWhyNowV1,
  sequencingSnapshotSections,
  sequencingSubjectEchoWarning,
} from '../src/feed-sequencing-debug.mjs';

let assertions = 0;
const assert = new Proxy(nodeAssert, {
  get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => {
      assertions += 1;
      return value.apply(target, args);
    };
  },
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── fixtures ────────────────────────────────────────────────────────────────
// Shapes are transcribed from the accepted backend contract
// (swipe-backend-feed-sequencing/app/api_feed_sequencing_debug.py plus the
// stored documents it echoes) down to the inner sections:
//   * profile          — feed_episode_projection.ProfileProjection/FamilyProjection
//   * epoch            — feed_personalization_reset.EpochWatermarks
//   * snapshot         — feed_sequence_planner._snapshot_document
//   * satiationAndGaps — feed_pacing_projection.FavoriteGapProjection (+ the
//                        snapshot's own naturalBuiltinEvaluated)
//   * regret           — feed_pacing_projection.RegretProjection
//   * explorationFloor — feed_sequence_planner._FloorState
//   * coldStart        — feed_sequence_planner._ColdStartState
//   * chosen/rejected  — feed_sequence_planner._Candidate (+ per-branch detail)
//   * constraintConflicts — the planner's `code`-keyed conflict records
// The backend is frozen; this client adapts.

const EPOCH = {
  personalizationEpoch: 2,
  personalizationWatermark: '2026-07-20T08:00:00.000Z',
  exposuresEpoch: 1,
  exposuresWatermark: null,
  onboardingEpoch: 1,
};

const FAMILY_SORT = {
  familyId: 'sort',
  score: '0.412000000000',
  confidencePpm: 640000,
  contributionSum: '1.236000000000',
  decayedSeenUnits: '3.000000000000',
  normalizationDenominator: '3.000000000000',
  independentAnchorIds: ['0f5b2d0a-8a0d-4c1f-9d5e-1f5a2b3c4d5e'],
  independentEpisodeCount: 2,
  lastStrongTerminalAt: '2026-07-26T11:02:31.000Z',
  satiation: '0.250000000000',
  state: 'promising',
  favoriteEligible: false,
  inFavoriteSet: false,
};

const FAMILY_MATCH = {
  familyId: 'match',
  score: '0.910000000000',
  confidencePpm: 1000000,
  contributionSum: '4.550000000000',
  decayedSeenUnits: '5.000000000000',
  normalizationDenominator: '5.000000000000',
  independentAnchorIds: [
    '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
  ],
  independentEpisodeCount: 3,
  lastStrongTerminalAt: '2026-07-27T06:14:02.500Z',
  satiation: '0.720000000000',
  state: 'favorite',
  favoriteEligible: true,
  inFavoriteSet: true,
};

const PROFILE_DOCUMENT = {
  schema: 'feed.family-profile-projection.v1',
  asOf: '2026-07-27T07:00:00.000Z',
  favoriteSet: ['match'],
  families: [FAMILY_MATCH, FAMILY_SORT],
};

const PROFILE_FULL = {
  schema: SEQUENCING_DEBUG_PROFILE_SCHEMA,
  subjectUserId: '42692410',
  readOnly: true,
  recomputed: false,
  sources: [{
    kind: 'episode_materialization',
    id: '3c9f1c7a-2b44-4a51-9f0e-6d2c1b8a7e10',
    digest: 'a'.repeat(64),
    asOf: '2026-07-27T07:00:00.000Z',
  }],
  snapshotAsOf: '2026-07-27T07:00:00.000Z',
  snapshotAgeSeconds: 3725,
  epoch: EPOCH,
  configs: {
    affinity: {
      kind: 'affinity',
      version: 'v2-pilot',
      digest: 'b'.repeat(64),
      schema: 'feed.affinity-config.v2',
    },
    sourceAffinity: {
      kind: 'affinity',
      version: 'v1-pilot',
      digest: 'c'.repeat(64),
      schema: 'feed.affinity-config.v1',
    },
    ontology: {
      activationId: '4d0a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      ontologyId: '5e1b2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      configVersion: 'ontology-v1',
      configDigest: 'd'.repeat(64),
    },
    satiationInput: { schema: 'feed.satiation-input.v1', digest: 'e'.repeat(64) },
    coverageDigest: 'f'.repeat(64),
  },
  profile: PROFILE_DOCUMENT,
};

// Absent snapshot: the honest empty answer, not an error (§12.1).
const PROFILE_EMPTY = {
  schema: SEQUENCING_DEBUG_PROFILE_SCHEMA,
  subjectUserId: '900000000000001',
  readOnly: true,
  recomputed: false,
  sources: [],
  snapshotAsOf: null,
  snapshotAgeSeconds: null,
  epoch: EPOCH,
  configs: null,
  profile: null,
};

const PLAN_SNAPSHOT = {
  schema: 'feed.sequence-plan-snapshot.v1',
  implementationVersion: 'feed-sequence-planner.v1',
  planId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  userId: '42692410',
  opportunity: {
    sourceDecisionId: '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e',
    sourceEventId: null,
    feedPosition: 12,
    forcedIdentity: false,
    acquisition: 'organic',
  },
  asOf: '2026-07-27T07:05:00.000Z',
  causalWatermark: '2026-07-27T07:04:59.000Z',
  configs: {
    slot: {
      kind: 'slot',
      version: 'v3-pilot',
      digest: '1'.repeat(64),
      schema: 'feed.slot-config.v3',
    },
    affinity: {
      kind: 'affinity',
      version: 'v2-pilot',
      digest: 'b'.repeat(64),
      schema: 'feed.affinity-config.v2',
    },
    coldStart: {
      kind: 'cold_start',
      version: 'cold-v1',
      digest: '2'.repeat(64),
      schema: 'feed.cold-start-config.v1',
    },
    ontology: { version: 'ontology-v1', digest: 'd'.repeat(64) },
    coldStartActivationId: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
    coverageDigest: 'f'.repeat(64),
    satiationInputDigest: 'e'.repeat(64),
    pacingInputDigest: '3'.repeat(64),
  },
  epoch: EPOCH,
  ontologyMembership: [
    { catalogMechanic: 'sort/base', familyId: 'sort' },
    { catalogMechanic: 'match/base', familyId: 'match' },
  ],
  profile: PROFILE_DOCUMENT,
  satiationAndGaps: [
    {
      schema: 'feed.favorite-gap-projection.v1',
      familyId: 'match',
      previousFavoriteImpressionId: 'ff0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      currentGapSeenUnits: 4,
      minGapSeenUnits: 2,
      targetGapSeenUnits: 4,
      maxGapSeenUnits: 7,
      drawBucket: 3,
      drawDigest: 'a1'.repeat(32),
      anchorBlockedByMinGap: false,
      obligationDue: true,
      obligationApproaching: false,
      fulfilment: 'target',
      forcedUnitsSinceAppearance: 0,
      previousAppearanceForced: false,
      naturalBuiltinEvaluated: false,
    },
  ],
  regret: {
    schema: 'feed.regret-projection.v1',
    consecutiveRegrets: 1,
    regretImpressionIds: ['ff0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f'],
    lastResetReason: null,
    rescueDue: false,
    rescueFamilyId: null,
    rescueUnavailableReason: null,
  },
  explorationFloor: {
    windowSeenUnits: 20,
    minimumExplorationUnits: 3,
    orderedMembership: ['favorite_anchor', 'exploration', 'favorite_anchor'],
    explorationInWindow: 3,
    debt: 0,
    forcedNow: false,
    infeasible: false,
  },
  coldStart: {
    active: false,
    probesSeen: 4,
    familiesCovered: ['match', 'sort'],
    promisingExists: true,
    exitReason: 'promising_found',
    nextProbeFamilyId: null,
    nextProbeCatalogMechanic: null,
  },
  continuity: { pendingTriggerId: null, pendingTriggerMechanic: null },
  runway: [
    { familyId: 'match', eligibleUnseenSeries: 2 },
    { familyId: 'sort', eligibleUnseenSeries: 0 },
  ],
  exploration: { candidate: null, rejected: [] },
  // _Candidate.as_document(): slotType/familyId/reason/admitted plus the exact
  // per-branch detail keys, nothing else.
  chosen: {
    slotType: 'favorite_anchor',
    familyId: 'match',
    reason: 'target_gap_reached',
    admitted: true,
    targetGapSeenUnits: 4,
  },
  chosenSlotType: 'favorite_anchor',
  rejected: [
    {
      slotType: 'favorite_anchor',
      familyId: 'sort',
      reason: 'min_gap_blocks_anchor',
      admitted: false,
      currentGapSeenUnits: 1,
      minGapSeenUnits: 2,
    },
    { slotType: 'exploration', familyId: null, reason: 'forced_identity_outside_quotas', admitted: false },
  ],
  constraintConflicts: [
    { code: 'exploration_floor_infeasible', explorationDebt: 2, windowSeenUnits: 20 },
  ],
  authority: {
    createsDecision: false,
    createsAuthorization: false,
    createsHold: false,
    createsTicket: false,
    consumesContinuityTrigger: false,
    playerWireExposure: 'none',
  },
};

const WHY_NOW_FULL = {
  schema: SEQUENCING_DEBUG_WHY_NOW_SCHEMA,
  subjectUserId: '42692410',
  readOnly: true,
  recomputed: false,
  sources: [{
    kind: 'sequence_plan_snapshot',
    id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
    digest: '4'.repeat(64),
    asOf: '2026-07-27T07:05:00.000Z',
  }],
  planId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  chosenSlotType: 'favorite_anchor',
  chosenFamilyId: 'match',
  constraintConflict: true,
  coldStartPhase: false,
  snapshot: PLAN_SNAPSHOT,
  snapshotDigest: '4'.repeat(64),
};

const WHY_NOW_EMPTY = {
  schema: SEQUENCING_DEBUG_WHY_NOW_SCHEMA,
  subjectUserId: '900000000000001',
  readOnly: true,
  recomputed: false,
  sources: [],
  planId: null,
  chosenSlotType: null,
  chosenFamilyId: null,
  constraintConflict: null,
  coldStartPhase: null,
  snapshot: null,
  snapshotDigest: null,
};

const HISTORY_FULL = {
  schema: SEQUENCING_DEBUG_HISTORY_SCHEMA,
  subjectUserId: '42692410',
  readOnly: true,
  recomputed: false,
  sources: [
    {
      kind: 'generated_offer_miss',
      id: 'aa0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      digest: '5'.repeat(64),
      asOf: '2026-07-27T06:59:00.000Z',
    },
    {
      kind: 'favorite_delivery_miss',
      id: 'bb0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      digest: '6'.repeat(64),
      asOf: '2026-07-27T06:58:00.000Z',
    },
  ],
  limit: 20,
  units: [
    {
      decisionId: 'cc0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      issuedAt: '2026-07-27T07:05:01.000Z',
      slotType: 'favorite_anchor',
      policyVersion: 'feed-policy-v3',
      arm: 'treatment',
      mechanicId: 'marble-sort-swipe',
      builtinMappingId: 'dd0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      rosterActivationId: 'ee0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      seen: true,
      impressionId: 'ff0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      revealedAt: '2026-07-27T07:05:03.250Z',
    },
    {
      decisionId: '110d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      issuedAt: '2026-07-27T07:04:40.000Z',
      slotType: 'exploration',
      policyVersion: 'feed-policy-v3',
      arm: 'control',
      mechanicId: 'pins',
      builtinMappingId: null,
      rosterActivationId: null,
      // Issued without a reveal: the chain the panel must show as an open unit.
      seen: false,
      impressionId: null,
      revealedAt: null,
    },
  ],
  generatedOfferMisses: [{
    schema: 'feed.generated-offer-miss.v1',
    requestId: 'aa0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
    userId: '42692410',
    asOf: '2026-07-27T06:59:00.000Z',
    selectionReason: 'no_eligible_series',
    preferredFamily: 'sort',
    configs: {
      affinity: { kind: 'affinity', version: 'v2-pilot', digest: 'b'.repeat(64) },
      slot: { kind: 'slot', version: 'v3-pilot', digest: '1'.repeat(64) },
      runway: { kind: 'runway', version: 'runway-v1', digest: '7'.repeat(64) },
    },
    eligiblePoolDigest: '8'.repeat(64),
    constraintSummary: { seenAll: true, holdsActive: 0 },
    authority: {
      createsDecision: false,
      createsAllocation: false,
      createsHold: false,
      createsTicket: false,
      consumesRunway: false,
      contentIdentity: null,
    },
  }],
  favoriteDeliveryMisses: [{
    schema: 'feed.favorite-delivery-miss.v1',
    userId: '42692410',
    familyId: 'match',
    obligationKey: 'match:2026-07-27',
    planId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
    asOf: '2026-07-27T06:58:00.000Z',
    gap: { familyId: 'match', currentGapSeenUnits: 4, obligationKey: 'match:2026-07-27' },
    naturalBuiltinEvaluated: false,
    missBound: 'upper',
  }],
  resets: [{
    resetId: '220d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
    scope: 'personalization',
    effectiveAt: '2026-07-20T08:00:00.000Z',
    newEpoch: 2,
    receiptDigest: '9'.repeat(64),
  }],
};

const HISTORY_EMPTY = {
  schema: SEQUENCING_DEBUG_HISTORY_SCHEMA,
  subjectUserId: '900000000000001',
  readOnly: true,
  recomputed: false,
  sources: [],
  limit: 50,
  units: [],
  generatedOfferMisses: [],
  favoriteDeliveryMisses: [],
  resets: [],
};

// ── verbatim pass-through ───────────────────────────────────────────────────
const profile = parseSequencingDebugProfileV1(PROFILE_FULL);
assert.equal(profile.subjectUserId, '42692410');
assert.equal(profile.present, true);
assert.deepEqual(profile.raw, PROFILE_FULL, 'the whole response stays available verbatim');
assert.deepEqual(profile.profile, PROFILE_DOCUMENT, 'stored profile bytes are not reshaped');
assert.deepEqual(
  profile.families,
  [FAMILY_MATCH, FAMILY_SORT],
  'families keep the stored order and every stored field (no client scoring)',
);
assert.deepEqual(profile.favoriteSet, ['match']);
assert.deepEqual(profile.epoch, EPOCH);
assert.deepEqual(profile.configs, PROFILE_FULL.configs);
assert.equal(profile.snapshotAgeSeconds, 3725);
assert.equal(profile.profileSchema, 'feed.family-profile-projection.v1');
assert.equal(profile.profileAsOf, '2026-07-27T07:00:00.000Z');
assert.deepEqual(profile.warnings, []);
assert.deepEqual(profile.sources, [{
  kind: 'episode_materialization',
  id: '3c9f1c7a-2b44-4a51-9f0e-6d2c1b8a7e10',
  digest: 'a'.repeat(64),
  asOf: '2026-07-27T07:00:00.000Z',
}]);
assert.throws(
  () => { profile.raw.profile.families[0].score = '9.999'; },
  TypeError,
  'displayed stored bytes are deep-frozen',
);

const emptyProfile = parseSequencingDebugProfileV1(PROFILE_EMPTY);
assert.equal(emptyProfile.present, false, 'an absent receipt is empty, never an error');
assert.equal(emptyProfile.profile, null);
assert.deepEqual(emptyProfile.families, []);
assert.deepEqual(emptyProfile.epoch, EPOCH, 'epoch is still exact without a receipt');
assert.deepEqual(emptyProfile.warnings, []);

const whyNow = parseSequencingDebugWhyNowV1(WHY_NOW_FULL);
assert.equal(whyNow.present, true);
assert.deepEqual(whyNow.snapshot, PLAN_SNAPSHOT, 'the plan snapshot is echoed verbatim');
assert.deepEqual(whyNow.raw, WHY_NOW_FULL);
assert.equal(whyNow.snapshotDigest, '4'.repeat(64));
assert.equal(whyNow.chosenSlotType, 'favorite_anchor');
assert.equal(whyNow.chosenFamilyId, 'match');
assert.equal(whyNow.constraintConflict, true);
assert.equal(whyNow.coldStartPhase, false);
assert.deepEqual(whyNow.warnings, []);
assert.deepEqual(
  whyNow.sections.find((section) => section.key === 'rejected').value,
  PLAN_SNAPSHOT.rejected,
  'rejected candidates are shown exactly as stored',
);
assert.deepEqual(
  whyNow.sections.find((section) => section.key === 'runway').value,
  PLAN_SNAPSHOT.runway,
);
assert.deepEqual(
  whyNow.sections.map((section) => section.key).slice(0, 5),
  ['schema', 'implementationVersion', 'planId', 'userId', 'opportunity'],
);
assert.deepEqual(
  [...whyNow.sections.map((section) => section.key)].sort(),
  Object.keys(PLAN_SNAPSHOT).sort(),
  'section ordering never drops a stored key',
);

const whyNowEmpty = parseSequencingDebugWhyNowV1(WHY_NOW_EMPTY);
assert.equal(whyNowEmpty.present, false);
assert.deepEqual(whyNowEmpty.sections, []);
assert.equal(whyNowEmpty.planId, null);

// An unknown snapshot section is appended, not hidden.
const driftedSections = sequencingSnapshotSections({
  ...PLAN_SNAPSHOT,
  futureSection: { value: 1 },
});
assert.equal(driftedSections[driftedSections.length - 1].key, 'futureSection');
assert.equal(driftedSections.length, Object.keys(PLAN_SNAPSHOT).length + 1);
assert.deepEqual(sequencingSnapshotSections(null), []);

const history = parseSequencingDebugHistoryV1(HISTORY_FULL);
assert.equal(history.present, true);
assert.equal(history.limit, 20);
assert.equal(history.units.length, 2);
assert.equal(history.units[0].seen, true);
assert.equal(history.units[0].impressionId, 'ff0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
assert.equal(history.units[1].seen, false, 'issued-without-seen stays visible as an open chain');
assert.equal(history.units[1].revealedAt, null);
assert.deepEqual(history.generatedOfferMisses, HISTORY_FULL.generatedOfferMisses);
assert.deepEqual(history.favoriteDeliveryMisses, HISTORY_FULL.favoriteDeliveryMisses);
assert.deepEqual(history.resets, [{
  resetId: '220d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  scope: 'personalization',
  effectiveAt: '2026-07-20T08:00:00.000Z',
  newEpoch: 2,
  receiptDigest: '9'.repeat(64),
}]);
assert.deepEqual(history.raw, HISTORY_FULL);
assert.deepEqual(history.warnings, []);

const historyEmpty = parseSequencingDebugHistoryV1(HISTORY_EMPTY);
assert.equal(historyEmpty.present, false);
assert.equal(historyEmpty.limit, 50);
assert.deepEqual(historyEmpty.units, []);
assert.deepEqual(historyEmpty.resets, []);

// A history that only carries reset receipts is still data (the reset tab).
const historyResetsOnly = parseSequencingDebugHistoryV1({
  ...HISTORY_EMPTY,
  resets: HISTORY_FULL.resets,
});
assert.equal(historyResetsOnly.present, true);

// ── envelope is the promise, and it fails closed ────────────────────────────
for (const [label, mutation, code] of [
  ['wrong schema', { schema: 'feed.debug-profile.v2' }, 'unsupported_schema'],
  ['readOnly false', { readOnly: false }, 'not_read_only'],
  ['readOnly absent', { readOnly: undefined }, 'not_read_only'],
  ['recomputed true', { recomputed: true }, 'recomputed_projection'],
  ['recomputed absent', { recomputed: undefined }, 'recomputed_projection'],
  ['subject missing', { subjectUserId: undefined }, 'invalid_subject'],
  ['subject numeric', { subjectUserId: 42692410 }, 'invalid_subject'],
  ['subject non-numeric text', { subjectUserId: 'me' }, 'invalid_subject'],
  // `sources` names the stored bytes a projection came from: a response that
  // cannot name them is not an auditable read-only projection.
  ['sources object', { sources: {} }, 'invalid_sources'],
  ['sources string', { sources: 'episode_materialization' }, 'invalid_sources'],
  ['sources null', { sources: null }, 'invalid_sources'],
  ['sources absent', { sources: undefined }, 'invalid_sources'],
  ['sources number', { sources: 7 }, 'invalid_sources'],
]) {
  assert.throws(
    () => parseSequencingDebugProfileV1({ ...PROFILE_FULL, ...mutation }),
    (error) => error instanceof FeedSequencingDebugContractError && error.code === code,
    `${label} must be rejected as ${code}`,
  );
}
assert.equal(
  parseSequencingDebugProfileV1({ ...PROFILE_FULL, sources: [] }).present,
  true,
  'an empty sources array stays the legitimate "nothing stored yet" statement',
);
const badSourceEntry = parseSequencingDebugProfileV1({ ...PROFILE_FULL, sources: ['nope'] });
assert.equal(
  badSourceEntry.present,
  true,
  'one malformed entry inside a well-formed sources array stays a warning',
);
assert.ok(badSourceEntry.warnings.some((text) => text.includes('sources[0] is not an object')));
assert.throws(
  () => parseSequencingDebugProfileV1(null),
  (error) => error.code === 'invalid_response',
);
assert.throws(
  () => parseSequencingDebugProfileV1([PROFILE_FULL]),
  (error) => error.code === 'invalid_response',
);
assert.throws(
  () => parseSequencingDebugWhyNowV1(PROFILE_FULL),
  (error) => error.code === 'unsupported_schema',
  'a projection is never displayed under another projection tab',
);

// ── drift is surfaced, never a blackout ─────────────────────────────────────
const drifted = parseSequencingDebugHistoryV1({
  ...HISTORY_FULL,
  futureField: 1,
  units: [{ ...HISTORY_FULL.units[0], futureUnitField: true }, 'not-an-object'],
});
assert.equal(drifted.present, true, 'unknown fields do not blank out the projection');
assert.ok(drifted.warnings.some((text) => text.includes('futureField')));
assert.ok(drifted.warnings.some((text) => text.includes('futureUnitField')));
assert.ok(drifted.warnings.some((text) => text.includes('units[1] is not an object')));
assert.equal(drifted.units.length, 1, 'a malformed unit is skipped in the structured render');
assert.equal(drifted.raw.units.length, 2, 'and still visible in the raw view');

const missingArrays = parseSequencingDebugHistoryV1({
  schema: SEQUENCING_DEBUG_HISTORY_SCHEMA,
  subjectUserId: '42692410',
  readOnly: true,
  recomputed: false,
  sources: [],
  limit: 20,
});
assert.equal(missingArrays.present, false);
assert.equal(missingArrays.warnings.length, 4, 'each absent collection is reported once');

// ── transport states ────────────────────────────────────────────────────────
const unavailable = buildSequencingDebugView('profile', { status: 'unavailable' });
assert.equal(unavailable.state, 'unavailable');
assert.equal(unavailable.retryable, false, 'the single non-leaking 404 is never retried');
assert.equal(unavailable.view, null);
assert.equal(
  buildSequencingDebugView('history', { status: 'unavailable' }).message,
  unavailable.message,
  'the reason behind the 404 is not guessed per projection',
);

const networkError = buildSequencingDebugView('why-now', {
  status: 'error',
  message: 'Network error: offline',
});
assert.equal(networkError.state, 'error');
assert.equal(networkError.retryable, true);
assert.equal(networkError.message, 'Network error: offline');
assert.equal(
  buildSequencingDebugView('why-now', { status: 'error' }).message,
  'sequencing debug request failed',
);

const okData = buildSequencingDebugView('history', { status: 'ok', body: HISTORY_FULL });
assert.equal(okData.state, 'data');
assert.equal(okData.message, null);
assert.equal(okData.view.units.length, 2);

const okEmpty = buildSequencingDebugView('profile', { status: 'ok', body: PROFILE_EMPTY });
assert.equal(okEmpty.state, 'empty');
assert.equal(okEmpty.message, 'no committed receipt for this subject yet');
assert.equal(okEmpty.view.present, false);
assert.equal(
  buildSequencingDebugView('why-now', { status: 'ok', body: WHY_NOW_EMPTY }).message,
  'no stored plan snapshot for this subject yet',
);
assert.equal(
  buildSequencingDebugView('history', { status: 'ok', body: HISTORY_EMPTY }).message,
  'no decisions, misses or reset receipts for this subject yet',
);

const violated = buildSequencingDebugView('profile', {
  status: 'ok',
  body: { ...PROFILE_FULL, recomputed: true },
});
assert.equal(violated.state, 'error');
assert.equal(violated.retryable, false, 'a contract violation is not a transient failure');
assert.ok(violated.message.includes('recomputed_projection'));
assert.throws(
  () => buildSequencingDebugView('reset', { status: 'unavailable' }),
  (error) => error.code === 'unknown_projection',
  'there is no reset projection: reset receipts arrive inside history',
);
assert.throws(
  () => buildSequencingDebugView('profile', { status: 'weird' }),
  (error) => error.code === 'invalid_result',
);

// ── subject and limit normalization ─────────────────────────────────────────
assert.deepEqual(normalizeSequencingSubject(null), { status: 'own' });
assert.deepEqual(normalizeSequencingSubject(''), { status: 'own' });
assert.deepEqual(normalizeSequencingSubject('   '), { status: 'own' });
assert.deepEqual(normalizeSequencingSubject(' 42692410 '), { status: 'subject', userId: 42692410 });
assert.deepEqual(
  normalizeSequencingSubject('900000000000001'),
  { status: 'subject', userId: 900000000000001 },
  'the reserved bot id range stays addressable',
);
assert.deepEqual(normalizeSequencingSubject('0'), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject('-1'), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject('4e2'), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject('42.5'), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject('abc'), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject(1.5), { status: 'invalid' });
assert.deepEqual(normalizeSequencingSubject({}), { status: 'invalid' });

// A named subject whose echo differs is a warning, never a silent swap.
assert.equal(sequencingSubjectEchoWarning('42692410', '42692410'), null);
assert.equal(
  sequencingSubjectEchoWarning('42692410', '900000000000001'),
  'server echoed subjectUserId 900000000000001 for requested user_id 42692410',
);
assert.equal(
  sequencingSubjectEchoWarning('', '42692410'),
  null,
  'reading yourself has no requested id to compare against',
);
assert.equal(sequencingSubjectEchoWarning(null, '42692410'), null);
assert.equal(sequencingSubjectEchoWarning('nope', '42692410'), null);
assert.equal(sequencingSubjectEchoWarning('42692410', 42692410), null);

assert.equal(normalizeSequencingHistoryLimit(undefined), SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);
assert.equal(normalizeSequencingHistoryLimit(''), SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);
assert.equal(normalizeSequencingHistoryLimit('abc'), SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);
assert.equal(normalizeSequencingHistoryLimit(NaN), SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);
assert.equal(normalizeSequencingHistoryLimit(0), 1);
assert.equal(normalizeSequencingHistoryLimit(-9), 1);
assert.equal(normalizeSequencingHistoryLimit('7'), 7);
assert.equal(normalizeSequencingHistoryLimit(7.9), 7);
assert.equal(normalizeSequencingHistoryLimit(50), SEQUENCING_DEBUG_HISTORY_LIMIT_MAX);
assert.equal(normalizeSequencingHistoryLimit(51), SEQUENCING_DEBUG_HISTORY_LIMIT_MAX);
assert.equal(normalizeSequencingHistoryLimit(Infinity), SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);

// ── request paths ───────────────────────────────────────────────────────────
assert.equal(buildSequencingDebugPath('profile'), '/api/feed/sequencing/debug/profile');
assert.equal(
  buildSequencingDebugPath('why-now', { subject: '42692410' }),
  '/api/feed/sequencing/debug/why-now?user_id=42692410',
);
assert.equal(
  buildSequencingDebugPath('history', { subject: '', limit: 999 }),
  '/api/feed/sequencing/debug/history?limit=50',
);
assert.equal(
  buildSequencingDebugPath('history', { subject: '42692410', limit: '5' }),
  '/api/feed/sequencing/debug/history?user_id=42692410&limit=5',
);
assert.equal(
  buildSequencingDebugPath('history'),
  '/api/feed/sequencing/debug/history?limit=20',
  'the panel always states the limit it is displaying',
);
assert.throws(
  () => buildSequencingDebugPath('history', { subject: 'me' }),
  (error) => error.code === 'invalid_subject_input',
  'a typo in the subject field never silently reads the caller instead',
);
assert.throws(
  () => buildSequencingDebugPath('reset'),
  (error) => error.code === 'unknown_projection',
);
assert.deepEqual(Object.keys(SEQUENCING_DEBUG_PATHS), ['profile', 'why-now', 'history']);

// ── formatting only ─────────────────────────────────────────────────────────
assert.equal(formatSequencingSnapshotAge(0), '0s');
assert.equal(formatSequencingSnapshotAge(59), '59s');
assert.equal(formatSequencingSnapshotAge(95), '1m 35s');
assert.equal(formatSequencingSnapshotAge(3725), '1h 2m 5s');
assert.equal(formatSequencingSnapshotAge(90061), '1d 1h 1m');
assert.equal(formatSequencingSnapshotAge(null), '—');
assert.equal(formatSequencingSnapshotAge('3725'), '—');
assert.equal(formatSequencingSnapshotAge(-5), '-5s (clock skew)');
assert.equal(formatSequencingTimestamp('2026-07-27T07:00:00.000Z'), '2026-07-27T07:00:00.000Z');
assert.equal(formatSequencingTimestamp(null), '—');
assert.equal(formatSequencingTimestamp(17), '—');
assert.equal(
  formatSequencingJson({ b: 1, a: 2 }),
  '{\n  "b": 1,\n  "a": 2\n}',
  'raw JSON keeps the server key order — it is evidence, not a report',
);
assert.equal(formatSequencingJson(undefined), '(absent)');
assert.equal(formatSequencingJson(null), 'null');

// ── no mutation surface ─────────────────────────────────────────────────────
const apiSource = readFileSync(path.resolve(root, 'src/api.ts'), 'utf8');
const marker = '// ── feed sequencing debug (§12): read-only, GET only ──';
assert.ok(apiSource.includes(marker), 'the sequencing debug client section must stay marked');
const sequencingSection = apiSource.slice(apiSource.indexOf(marker));
assert.ok(
  !/\b(?:post|put|patch|del(?:ete)?)\w*\s*[<(]/i.test(sequencingSection),
  'the sequencing debug client must not reach any mutating helper',
);
assert.ok(
  !/method\s*:\s*['"`]\s*(?:POST|PUT|PATCH|DELETE)/i.test(sequencingSection),
  'the sequencing debug client must issue GET requests only',
);
// Structural, not lexical: one transport call, and it never names a method, so
// there is no place a verb could be introduced without this check noticing.
assert.equal(
  (sequencingSection.match(/\bfetch\s*\(/g) ?? []).length,
  1,
  'the sequencing debug client must own exactly one transport call',
);
assert.ok(
  !/\bmethod\s*:/.test(sequencingSection),
  'the single sequencing debug fetch must not name a method at all (GET by default)',
);
const debugSource = readFileSync(path.resolve(root, 'src/debug.ts'), 'utf8');
assert.ok(
  !/apiSequencingDebug\w*\s*\([^)]*\)\s*\.\s*then\s*\(\s*\(\)\s*=>\s*location/.test(debugSource),
  'the sequencing panel never reloads the app off a debug read',
);
for (const forbidden of ['sequencing/debug/reset', 'apiSequencingDebugReset']) {
  assert.ok(
    !apiSource.includes(forbidden) && !debugSource.includes(forbidden),
    `the client must not grow a reset surface (${forbidden})`,
  );
}
// Regional, not file-wide: the QA panel above legitimately owns reset/seed/flush
// controls, and the sequencing sub-screen must not reach any of them — a reset
// button wired to an already-imported helper is exactly the shape to catch.
const regionStart = '// ── BEGIN feed sequencing debug sub-screen (§12) ───────────────────────────';
const regionEnd = '// ── END feed sequencing debug sub-screen (§12) ─────────────────────────────';
assert.ok(debugSource.includes(regionStart), 'the sequencing sub-screen region must stay marked');
assert.ok(debugSource.includes(regionEnd), 'the sequencing sub-screen region must stay closed');
const sequencingRegion = debugSource.slice(
  debugSource.indexOf(regionStart) + regionStart.length,
  debugSource.indexOf(regionEnd),
);
assert.ok(sequencingRegion.includes('renderSequencingResets'), 'the region must cover the reset tab');
assert.ok(
  sequencingRegion.includes('mountSequencingDebugPanel'),
  'the region must cover the whole sub-screen',
);
for (const mutator of [
  'apiReset',
  'apiResetDaily',
  'apiSeedChallenge',
  'flushResults',
  'clearOutbox',
  'setIslandSocialMode',
]) {
  assert.ok(
    !sequencingRegion.includes(mutator),
    `the sequencing sub-screen must not reach the state-changing helper ${mutator}`,
  );
}
assert.ok(
  !/\bapi[A-Z]\w*/.test(sequencingRegion.replace(/apiSequencingDebug(?:Profile|WhyNow|History)/g, '')),
  'the sequencing sub-screen may only call the three read-only projections',
);

// ── backend drift guard (skipped when the private repo is not a sibling) ────
// The skip is announced on stdout and the two assertion counts are reported
// separately, so a CI log can never imply the backend contract was verified
// when only the local core ran.
const coreAssertions = assertions;
const backendSource = path.resolve(root, '../swipe-backend-feed-sequencing/app/api_feed_sequencing_debug.py');
if (!existsSync(backendSource)) {
  console.log(`backend drift guard: SKIPPED (backend worktree not found at ${backendSource})`);
}
if (existsSync(backendSource)) {
  const backend = readFileSync(backendSource, 'utf8');
  assert.ok(!backend.includes('@router.post'), 'the debug router must stay read-only');
  for (const literal of [
    `"${SEQUENCING_DEBUG_PROFILE_SCHEMA}"`,
    `"${SEQUENCING_DEBUG_WHY_NOW_SCHEMA}"`,
    `"${SEQUENCING_DEBUG_HISTORY_SCHEMA}"`,
    '@router.get("/profile")',
    '@router.get("/why-now")',
    '@router.get("/history")',
    'prefix="/feed/sequencing/debug"',
    'status_code=404',
  ]) {
    assert.ok(backend.includes(literal), `backend contract drifted: ${literal} is gone`);
  }
  for (const field of [
    'schema', 'subjectUserId', 'readOnly', 'recomputed', 'sources',
    'snapshotAsOf', 'snapshotAgeSeconds', 'epoch', 'configs', 'profile',
    'planId', 'chosenSlotType', 'chosenFamilyId', 'constraintConflict',
    'coldStartPhase', 'snapshot', 'snapshotDigest',
    'limit', 'units', 'generatedOfferMisses', 'favoriteDeliveryMisses', 'resets',
    'decisionId', 'issuedAt', 'slotType', 'policyVersion', 'arm', 'mechanicId',
    'builtinMappingId', 'rosterActivationId', 'seen', 'impressionId', 'revealedAt',
    'resetId', 'scope', 'effectiveAt', 'newEpoch', 'receiptDigest',
    'kind', 'id', 'digest', 'asOf',
  ]) {
    assert.ok(
      backend.includes(`"${field}"`),
      `backend response field ${field} is gone — the client view model must be revisited`,
    );
  }
}

const driftAssertions = assertions - coreAssertions;
if (driftAssertions > 0) console.log(`backend drift guard: ${backendSource}`);
console.log(
  `feed sequencing debug contract: ${coreAssertions} core`
  + ` + ${driftAssertions} backend-drift assertions`,
);
