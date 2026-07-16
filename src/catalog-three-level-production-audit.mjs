import { createHash } from 'node:crypto';

import {
  EXACT_THREE_LEVEL_CONTENT_HASH,
  EXACT_THREE_LEVEL_PRODUCTION_FIXTURE,
  EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
  EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_HASH,
  EXACT_THREE_LEVEL_SPEC_HASHES,
  sha256Jcs,
} from './catalog-three-level-production-fixture.mjs';

export { EXACT_THREE_LEVEL_CONTENT_HASH };

const LEVEL_COUNT = 3;

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const percentile95 = (values) => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
};

const orderedLevels = (levels, hashKey) => Array.isArray(levels)
  && levels.length === LEVEL_COUNT
  && levels.every((level, index) => level?.ordinal === index + 1
    && level?.[hashKey] === EXACT_THREE_LEVEL_SPEC_HASHES[index]);

const uniqueEvents = (state, name) => {
  const events = new Map();
  for (const event of state?.cpEvents ?? []) {
    if (event?.event_name === name) events.set(event.event_id, event);
  }
  return [...events.values()];
};

const exactConfiguredSkinClosure = (state) => {
  const impressions = uniqueEvents(state, 'catalog_level_impression_v2');
  return uniqueEvents(state, 'catalog_level_impression').length === 0
    && impressions.length === LEVEL_COUNT
    && impressions.every((event, index) => event?.payload?.ordinal === index + 1
      && event.payload.level_spec_hash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && event.payload.applied_spec_hash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && event.payload.skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && event.payload.applied_skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && event.payload.skin_contract_digest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST);
};

const exactIdentityChain = (state) => {
  const allocation = state?.allocationResponses?.[0];
  const ticket = state?.ticketResponses?.find((candidate) => candidate?.schema === 'run.ticket.v3');
  const bundle = state?.specResponses?.find(
    (candidate) => candidate?.schema === 'catalog.ticket-level-spec-bundle.v2',
  );
  const manifest = allocation?.manifest;
  const levelsMatch = orderedLevels(manifest?.levels, 'specHash')
    && orderedLevels(ticket?.levels, 'spec_hash')
    && orderedLevels(bundle?.levels, 'specHash')
    && bundle.levels.every((level, index) => sha256Jcs(level.spec)
      === sha256Jcs(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.specs[index]));
  const skinMatch = manifest?.schema === 'series.manifest.v2'
    && manifest.skinHash === EXACT_THREE_LEVEL_SKIN_HASH
    && manifest.skinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
    && manifest.gameplayFingerprint
      === EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.manifest.gameplayFingerprint
    && manifest.presentationFingerprint
      === EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.manifest.presentationFingerprint
    && manifest.seriesFingerprint === EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.seriesFingerprint
    && manifest.fingerprintVersion === EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.fingerprintVersion
    && ticket?.skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
    && ticket?.skin_contract_digest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
    && bundle?.skinHash === EXACT_THREE_LEVEL_SKIN_HASH
    && bundle?.skinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
    && sha256Jcs(bundle?.skin) === sha256Jcs(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.skin);
  return Boolean(allocation?.schema === 'catalog.allocate-decision-result.v2'
    && manifest?.contentHash === EXACT_THREE_LEVEL_CONTENT_HASH
    && ticket?.manifest_content_hash === EXACT_THREE_LEVEL_CONTENT_HASH
    && bundle?.manifestContentHash === EXACT_THREE_LEVEL_CONTENT_HASH
    && allocation?.catalog?.entryId === ticket?.catalog_entry_id
    && allocation?.catalog?.entryId === bundle?.catalogEntryId
    && allocation?.catalog?.seriesId === ticket?.series_id
    && allocation?.catalog?.seriesId === bundle?.seriesId
    && allocation?.decisionId === ticket?.decision_id
    && allocation?.decisionId === bundle?.decisionId
    && ticket?.ticket_id === bundle?.ticketId
    && ticket?.runtime_contract_digest === EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST
    && ticket?.runtime_artifact_digest === EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST
    && bundle?.runtime?.runtimeContractDigest === EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST
    && bundle?.runtime?.runtimeArtifactDigest === EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST
    && ticket?.expected_levels === LEVEL_COUNT
    && levelsMatch && skinMatch && exactConfiguredSkinClosure(state));
};

const exactReceipts = (state) => {
  const ticket = state?.ticketResponses?.find((candidate) => candidate?.schema === 'run.ticket.v3');
  const levelResults = state?.results?.filter(
    (item) => item.kind === 'level' && item.outcome === 'confirmed',
  ) ?? [];
  const chests = state?.results?.filter(
    (item) => item.kind === 'chest' && item.outcome === 'confirmed',
  ) ?? [];
  const levelRunIds = levelResults.map((item) => item.body?.run_id);
  return Boolean(ticket && levelResults.length === LEVEL_COUNT
    && new Set(levelRunIds).size === LEVEL_COUNT
    && !levelRunIds.includes(ticket.run_id)
    && levelResults.every((item, index) => item.body?.schema === 'catalog.result.v2'
      && item.body?.ordinal === index + 1
      && item.body?.series_level === index + 1
      && item.body?.applied_spec_hash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && item.body?.applied_skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && item.body?.ticket_id === ticket.ticket_id
      && typeof item.body?.run_id === 'string' && item.body.run_id.length > 0
      && item.body?.series_id === ticket.series_id)
    && chests.length === 1
    && chests[0].body?.schema === 'catalog.result.v2'
    && chests[0].body?.metric_key === 'series'
    && chests[0].body?.metric_value === LEVEL_COUNT
    && chests[0].body?.ticket_id === ticket.ticket_id
    && chests[0].body?.run_id === ticket.run_id
    && chests[0].body?.series_id === ticket.series_id
    && state?.checkpoints?.chestAfterExactReceipts?.pass === true
    && state?.checkpoints?.rewardAfterChestReceipt?.pass === true);
};

const ordinalLatencies = (state) => {
  const trace = Array.isArray(state?.trace) ? state.trace : [];
  const result = [];
  for (let ordinal = 1; ordinal <= LEVEL_COUNT; ordinal += 1) {
    const configured = trace.find(
      (item) => item.type === 'checkpoint_configured_specialized_impression_once'
        && item.ordinal === ordinal,
    );
    const receipt = trace.find(
      (item) => item.type === 'checkpoint_exact_level_result_confirmed'
        && item.ordinal === ordinal,
    );
    if (Number.isFinite(configured?.atMs) && Number.isFinite(receipt?.atMs)
      && receipt.atMs >= configured.atMs) result.push(receipt.atMs - configured.atMs);
  }
  return result;
};

const check = (name, pass, detail) => ({ name, pass: pass === true, detail });

/** Fixture-only evidence: production bundle and exact content, never a real backend receipt. */
export function buildThreeLevelFixtureAudit({ positive, reload, eventOrder, crossOrigin }) {
  const positiveLatencies = ordinalLatencies(positive);
  const checks = [
    check('exact_manifest_v2_ticket_v3_bundle_v2_skin_chain', exactIdentityChain(positive), EXACT_THREE_LEVEL_CONTENT_HASH),
    check('ordinals_1_through_3_then_one_chest', exactReceipts(positive), 'three distinct skin-bound level receipts; one root-run chest receipt'),
    check('zero_progress_reload_reuses_safe_ticket', Boolean(
      reload?.status === 'pass'
      && reload?.runtimeDocumentRequests >= LEVEL_COUNT + 1
      && reload?.canaryRequests?.length === 2
      && reload?.allocationRequests?.length === 2
      && reload?.ticketResponses?.length >= 2
      && reload.ticketResponses[0]?.completed_levels === 0
      && reload.ticketResponses[1]?.completed_levels === 0
      && exactIdentityChain(reload) && exactReceipts(reload)
    ), 'mount is interrupted before configure; authority resumes only at zero progress'),
    check('result_can_arrive_before_delayed_cp_ack', Boolean(
      eventOrder?.status === 'pass'
      && eventOrder?.eventOrderResultBeforeAck === true
      && eventOrder?.eventOrderAckPending === false
      && exactIdentityChain(eventOrder) && exactReceipts(eventOrder)
    ), 'ordinal 2 result transport wins the delayed impression-ACK response race'),
    check('cross_origin_spoof_is_inert', Boolean(
      crossOrigin?.status === 'pass'
      && crossOrigin?.runtimeEvents?.some((item) => item.stage === 'cross_origin_spoof_sent')
      && crossOrigin?.checkpoints?.configuredImpressions?.length === LEVEL_COUNT
      && exactIdentityChain(crossOrigin) && exactReceipts(crossOrigin)
    ), 'wrong-origin sibling cannot forge either specHash or skinHash closure'),
  ];
  const core = {
    schema: 'catalog.three-level-fixture-audit.v2',
    evidenceScope: 'fixture-production-bundle-exact-content',
    productionBackend: false,
    exactProductionManifestDigest: EXACT_THREE_LEVEL_CONTENT_HASH,
    levelCount: LEVEL_COUNT,
    skinHash: EXACT_THREE_LEVEL_SKIN_HASH,
    skinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
    checks,
    timings: {
      metric: 'configured_impression_to_accepted_level_receipt_ms',
      samples: positiveLatencies,
      p95Ms: percentile95(positiveLatencies),
      sampleCount: positiveLatencies.length,
      status: positiveLatencies.length === LEVEL_COUNT ? 'measured_fixture' : 'inconclusive',
    },
    verdict: checks.every((item) => item.pass) && positiveLatencies.length === LEVEL_COUNT
      ? 'harness_verified_not_production'
      : 'failed',
    eligibleForLevelSeriesRollout: false,
    remainingGate: 'server-authoritative production evidence; local operator observation is not rollout authority',
  };
  return deepFreeze({ ...core, evidenceDigest: sha256Jcs(core) });
}

/**
 * Revalidates the browser observation and emits a bounded, canonically hashed
 * local receipt. The nonce is issued by the local audit server, not production;
 * therefore the result is explicitly non-authoritative for rollout.
 */
export function buildThreeLevelLiveOperatorObservation(snapshot, { auditNonce }) {
  if (!/^[0-9a-f]{64}$/.test(auditNonce ?? '')) {
    throw new TypeError('auditNonce must be a server-issued 32-byte hex nonce');
  }
  const closure = snapshot?.closure;
  const impressions = Array.isArray(snapshot?.projectedImpressions)
    ? [...snapshot.projectedImpressions].sort((a, b) => a?.ordinal - b?.ordinal) : [];
  const results = Array.isArray(snapshot?.acceptedLevelResults)
    ? [...snapshot.acceptedLevelResults].sort((a, b) => a?.body?.ordinal - b?.body?.ordinal) : [];
  const chests = Array.isArray(snapshot?.acceptedChestResults)
    ? snapshot.acceptedChestResults : [];
  const deltas = Array.isArray(snapshot?.ordinalLatenciesMs)
    ? snapshot.ordinalLatenciesMs : [];
  const measuredDeltas = results.length === LEVEL_COUNT && impressions.length === LEVEL_COUNT
    ? results.map((item, index) => item?.atMs - impressions[index]?.atMs)
    : [];
  const levelRunIds = results.map((item) => item?.body?.run_id);
  const exact = snapshot?.status === 'pass'
    && snapshot?.expectedContentHash === EXACT_THREE_LEVEL_CONTENT_HASH
    && closure?.manifestContentHash === EXACT_THREE_LEVEL_CONTENT_HASH
    && closure?.skinHash === EXACT_THREE_LEVEL_SKIN_HASH
    && closure?.skinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
    && closure?.runtimeContractDigest === EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST
    && closure?.runtimeArtifactDigest === EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST
    && closure?.ticketSchema === 'run.ticket.v3'
    && closure?.bundleSchema === 'catalog.ticket-level-spec-bundle.v2'
    && Array.isArray(closure?.specHashes)
    && closure.specHashes.length === LEVEL_COUNT
    && closure.specHashes.every((hash, index) => hash === EXACT_THREE_LEVEL_SPEC_HASHES[index])
    && impressions.length === LEVEL_COUNT
    && impressions.every((item, index) => item?.eventName === 'catalog_level_impression_v2'
      && item.ordinal === index + 1
      && item.specHash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && item.appliedSpecHash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && item.skinHash === EXACT_THREE_LEVEL_SKIN_HASH
      && item.appliedSkinHash === EXACT_THREE_LEVEL_SKIN_HASH
      && item.skinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
      && item.runtimeContractDigest === EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST
      && item.runtimeArtifactDigest === EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST
      && item.ticketId === closure.ticketId && item.decisionId === closure.decisionId
      && item.entryId === closure.entryId && item.seriesId === closure.seriesId)
    && results.length === LEVEL_COUNT
    && new Set(levelRunIds).size === LEVEL_COUNT
    && !levelRunIds.includes(closure?.runId)
    && results.every((item, index) => item?.body?.schema === 'catalog.result.v2'
      && item.body.ordinal === index + 1
      && item.body.series_level === index + 1
      && item.body.applied_spec_hash === EXACT_THREE_LEVEL_SPEC_HASHES[index]
      && item.body.applied_skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && item.boundSkinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
      && item.body.ticket_id === closure.ticketId
      && item.body.series_id === closure.seriesId)
    && chests.length === 1
    && chests[0]?.body?.schema === 'catalog.result.v2'
    && chests[0]?.body?.run_id === closure?.runId
    && chests[0]?.body?.ticket_id === closure?.ticketId
    && chests[0]?.body?.series_id === closure?.seriesId
    && chests[0]?.boundSkinContractDigest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST
    && chests[0]?.body?.metric_value === LEVEL_COUNT
    && deltas.length === LEVEL_COUNT
    && deltas.every((value) => Number.isInteger(value) && value >= 0)
    && measuredDeltas.length === LEVEL_COUNT
    && measuredDeltas.every((value, index) => Number.isInteger(value)
      && value >= 0 && value === deltas[index])
    && snapshot?.p95Ms === percentile95(measuredDeltas);
  if (!exact) throw new TypeError('live observation lacks the exact three-level production closure');

  const evidence = {
    contentHash: EXACT_THREE_LEVEL_CONTENT_HASH,
    entryId: closure.entryId,
    seriesId: closure.seriesId,
    decisionId: closure.decisionId,
    ticketId: closure.ticketId,
    rootRunId: closure.runId,
    skinHash: EXACT_THREE_LEVEL_SKIN_HASH,
    skinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
    runtimeContractDigest: EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
    runtimeArtifactDigest: EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
    specHashes: [...EXACT_THREE_LEVEL_SPEC_HASHES],
    impressions: impressions.map((item) => ({
      eventId: item.eventId,
      ordinal: item.ordinal,
      specHash: item.specHash,
      skinHash: item.skinHash,
      skinContractDigest: item.skinContractDigest,
      projectedAtMs: item.atMs,
    })),
    acceptedLevelResults: results.map((item) => ({
      ordinal: item.body.ordinal,
      runId: item.body.run_id,
      appliedSpecHash: item.body.applied_spec_hash,
      appliedSkinHash: item.body.applied_skin_hash,
      boundSkinContractDigest: item.boundSkinContractDigest,
      acceptedAtMs: item.atMs,
    })),
    acceptedChest: {
      runId: chests[0].body.run_id,
      metricValue: chests[0].body.metric_value,
      boundSkinContractDigest: chests[0].boundSkinContractDigest,
      acceptedAtMs: chests[0].atMs,
    },
    ordinalLatenciesMs: [...measuredDeltas],
    p95Ms: percentile95(measuredDeltas),
  };
  const core = {
    schema: 'catalog.three-level-production-operator-observation.v1',
    evidenceScope: 'real-backend-runtime-browser-observation',
    productionBackendObserved: true,
    receiptIssuer: 'local-audit-observer',
    authority: 'non_authoritative_operator_observation',
    serverIssuedOneShotNonceDigest: createHash('sha256').update(auditNonce).digest('hex'),
    exactProductionManifestDigest: EXACT_THREE_LEVEL_CONTENT_HASH,
    evidence,
    eligibleForLevelSeriesRollout: false,
    remainingGate: 'a server-authoritative evidence receipt bound to this production content identity',
  };
  return deepFreeze({ ...core, evidenceDigest: sha256Jcs(core) });
}
