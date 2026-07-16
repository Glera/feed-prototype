import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

import {
  buildThreeLevelFixtureAudit,
  buildThreeLevelLiveOperatorObservation,
  EXACT_THREE_LEVEL_CONTENT_HASH,
} from '../src/catalog-three-level-production-audit.mjs';
import {
  EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
  EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_HASH,
  EXACT_THREE_LEVEL_SPEC_HASHES,
} from '../src/catalog-three-level-production-fixture.mjs';

const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CATALOG_DOGFOOD_LEVEL_COUNT: '3',
    CATALOG_DOGFOOD_TIMEOUT_MS: '15000',
    VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS: '500',
  },
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(
    () => reject(new Error(`catalog dogfood browser harness startup timed out\n${stderr}`)),
    120_000,
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl && parsed.reloadUrl && parsed.eventOrderUrl && parsed.crossOriginUrl
          && parsed.retryUrl && parsed.transientResultUrl && parsed.replayedCanaryUrl
          && parsed.timeoutResultUrl && parsed.disabledUrl && parsed.stateUrl) {
          clearTimeout(timeout);
          resolve(parsed);
          return;
        }
      } catch { /* npm/build output is not the endpoint JSON */ }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    reject(new Error(
      `catalog dogfood browser harness exited before startup (${String(code)})\n${stderr}\n${stdout}`,
    ));
  });
});

const exactSpecHashes = EXACT_THREE_LEVEL_SPEC_HASHES;
const browser = await chromium.launch();

const runScenario = async (url, { firstFailure, expectLevelRetry = false }) => {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const state = window.__catalogFeedDogfoodHarness;
      return state?.status === 'pass' || state?.status === 'fail';
    }, null, { timeout: 30_000 });
    const state = await page.evaluate(() => window.__catalogFeedDogfoodHarness);
    const diagnostic = JSON.stringify({
      status: state?.status,
      message: state?.message,
      results: state?.results,
      resultAttempts: state?.resultAttempts,
      checkpoints: state?.checkpoints,
      client: state?.client,
      runtimeEvents: state?.runtimeEvents,
      canaryRequests: state?.canaryRequests,
      allocationRequests: state?.allocationRequests,
      allocationResponses: state?.allocationResponses,
      ticketRequests: state?.ticketRequests,
      ticketResponses: state?.ticketResponses,
      specResponses: state?.specResponses,
      eventOrderAckPending: state?.eventOrderAckPending,
      eventOrderResultBeforeAck: state?.eventOrderResultBeforeAck,
      diagnostics: state?.diagnostics,
      browserErrors,
    }, null, 2);

    assert.equal(state.status, 'pass', diagnostic);
    assert.equal(state.client.catalogSeen, true, diagnostic);
    assert.equal(state.client.builtinSeen, true, diagnostic);
    assert.equal(state.client.generatedBadgeVisible, true, diagnostic);
    assert.equal(state.client.chestSeen, true, diagnostic);
    assert.equal(state.client.rewardSeen, true, diagnostic);
    assert.equal(state.diagnostics.length, 0, diagnostic);
    assert.deepEqual(browserErrors, [], diagnostic);
    const completions = state.runtimeEvents.filter((item) => item.stage === 'completed_sent');
    assert.equal(completions.length, exactSpecHashes.length + (expectLevelRetry ? 1 : 0), diagnostic);
    assert.deepEqual(completions.map((item) => item.detail.outcome), expectLevelRetry
      ? ['won', 'lost', 'won', 'won'] : exactSpecHashes.map(() => 'won'), diagnostic);

    const levelResults = state.results.filter((item) => item.kind === 'level');
    const chestResults = state.results.filter((item) => item.kind === 'chest');
    assert.equal(levelResults.length, exactSpecHashes.length, diagnostic);
    assert.deepEqual(levelResults.map((item) => item.outcome), exactSpecHashes.map(() => 'confirmed'), diagnostic);
    assert.deepEqual(levelResults.map((item) => item.body.ordinal), [1, 2, 3], diagnostic);
    assert.deepEqual(levelResults.map((item) => item.body.series_level), [1, 2, 3], diagnostic);
    assert.deepEqual(levelResults.map((item) => item.body.applied_spec_hash), exactSpecHashes, diagnostic);
    assert.deepEqual(levelResults.map((item) => item.body.schema), exactSpecHashes.map(() => 'catalog.result.v2'), diagnostic);
    assert.deepEqual(levelResults.map((item) => item.body.applied_skin_hash), exactSpecHashes.map(() => EXACT_THREE_LEVEL_SKIN_HASH), diagnostic);
    assert.equal(new Set(levelResults.map((item) => item.body.run_id)).size, exactSpecHashes.length, diagnostic);
    assert.equal(chestResults.length, 1, diagnostic);
    assert.equal(chestResults[0].outcome, 'confirmed', diagnostic);
    assert.equal(chestResults[0].body.schema, 'catalog.result.v2', diagnostic);
    assert.equal(chestResults[0].body.metric_key, 'series', diagnostic);
    assert.equal(chestResults[0].body.metric_value, exactSpecHashes.length, diagnostic);
    assert.equal(state.checkpoints.chestAfterExactReceipts?.pass, true, diagnostic);
    assert.equal(state.checkpoints.rewardAfterChestReceipt?.pass, true, diagnostic);
    assert.equal(state.allocationResponses[0]?.manifest?.contentHash, EXACT_THREE_LEVEL_CONTENT_HASH, diagnostic);
    assert.equal(state.allocationResponses[0]?.manifest?.schema, 'series.manifest.v2', diagnostic);
    assert.equal(state.allocationResponses[0]?.manifest?.skinHash, EXACT_THREE_LEVEL_SKIN_HASH, diagnostic);
    assert.equal(state.allocationResponses[0]?.manifest?.skinContractDigest, EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST, diagnostic);
    assert.equal(state.ticketResponses.every((ticket) => ticket.schema === 'run.ticket.v3'), true, diagnostic);
    assert.equal(state.specResponses.every((bundle) => bundle.schema === 'catalog.ticket-level-spec-bundle.v2'), true, diagnostic);
    const skinImpressions = state.cpEvents.filter((event) => event.event_name === 'catalog_level_impression_v2');
    assert.equal(skinImpressions.length, exactSpecHashes.length, diagnostic);
    assert.equal(skinImpressions.every((event) => event.payload.skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && event.payload.applied_skin_hash === EXACT_THREE_LEVEL_SKIN_HASH
      && event.payload.skin_contract_digest === EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST), true, diagnostic);

    const levelAttempts = state.resultAttempts.filter((item) => item.kind === 'level');
    const chestAttempts = state.resultAttempts.filter((item) => item.kind === 'chest');
    const confirmedAttempts = exactSpecHashes.map(() => ['confirmed', 200]);
    const expectedAttempts = firstFailure === 'transient'
      ? [['transient', 503], ...confirmedAttempts]
      : firstFailure === 'timeout'
        ? [['hung', 0], ...confirmedAttempts]
        : confirmedAttempts;
    assert.deepEqual(levelAttempts.map((item) => [item.outcome, item.status]), expectedAttempts, diagnostic);
    if (firstFailure) {
      assert.deepEqual(levelAttempts[0].body, levelAttempts[1].body, diagnostic);
    }
    assert.deepEqual(
      chestAttempts.map((item) => [item.outcome, item.status]),
      [['confirmed', 200]],
      diagnostic,
    );
    return state;
  } finally {
    await page.close();
  }
};

try {
  const positive = await runScenario(endpoints.successUrl, { firstFailure: null });
  const reload = await runScenario(endpoints.reloadUrl, { firstFailure: null });
  const eventOrder = await runScenario(endpoints.eventOrderUrl, { firstFailure: null });
  const crossOrigin = await runScenario(endpoints.crossOriginUrl, { firstFailure: null });
  await runScenario(endpoints.retryUrl, { firstFailure: null, expectLevelRetry: true });
  await runScenario(endpoints.replayedCanaryUrl, { firstFailure: null });
  await runScenario(endpoints.disabledUrl, { firstFailure: null });
  await runScenario(endpoints.transientResultUrl, { firstFailure: 'transient' });
  await runScenario(endpoints.timeoutResultUrl, { firstFailure: 'timeout' });
  const audit = buildThreeLevelFixtureAudit({ positive, reload, eventOrder, crossOrigin });
  assert.equal(audit.verdict, 'harness_verified_not_production', JSON.stringify(audit, null, 2));
  assert.equal(audit.productionBackend, false);
  assert.equal(audit.eligibleForLevelSeriesRollout, false);
  assert.equal(audit.checks.every((item) => item.pass), true, JSON.stringify(audit, null, 2));
  const wrongIdentity = structuredClone(positive);
  wrongIdentity.allocationResponses[0].manifest.contentHash = '0'.repeat(64);
  assert.equal(buildThreeLevelFixtureAudit({
    positive: wrongIdentity, reload, eventOrder, crossOrigin,
  }).verdict, 'failed', 'a different canary content hash must never inherit the exact audit');
  const duplicateChest = structuredClone(positive);
  duplicateChest.results.push(structuredClone(duplicateChest.results.find((item) => item.kind === 'chest')));
  assert.equal(buildThreeLevelFixtureAudit({
    positive: duplicateChest, reload, eventOrder, crossOrigin,
  }).verdict, 'failed', 'two chest receipts must fail the audit');
  const missingSpoof = structuredClone(crossOrigin);
  missingSpoof.runtimeEvents = missingSpoof.runtimeEvents.filter((item) => item.stage !== 'cross_origin_spoof_sent');
  assert.equal(buildThreeLevelFixtureAudit({
    positive, reload, eventOrder, crossOrigin: missingSpoof,
  }).verdict, 'failed', 'the cross-origin negative must be observed, not inferred');
  const allocation = positive.allocationResponses[0];
  const ticket = positive.ticketResponses[0];
  const bundle = positive.specResponses[0];
  const impressions = positive.cpEvents
    .filter((event) => event.event_name === 'catalog_level_impression_v2')
    .map((event) => {
      const checkpoint = positive.trace.find((item) => (
        item.type === 'checkpoint_configured_specialized_impression_once'
        && item.ordinal === event.payload.ordinal
      ));
      return {
        eventId: event.event_id,
        eventName: event.event_name,
        ordinal: event.payload.ordinal,
        specHash: event.payload.level_spec_hash,
        appliedSpecHash: event.payload.applied_spec_hash,
        skinHash: event.payload.skin_hash,
        appliedSkinHash: event.payload.applied_skin_hash,
        skinContractDigest: event.payload.skin_contract_digest,
        runtimeContractDigest: event.payload.runtime_contract_digest,
        runtimeArtifactDigest: event.payload.runtime_artifact_digest,
        ticketId: event.payload.ticket_id,
        decisionId: event.payload.decision_id,
        entryId: event.payload.catalog_entry_id,
        seriesId: event.payload.series_id,
        atMs: checkpoint.atMs,
      };
    });
  const acceptedLevelResults = positive.results
    .filter((item) => item.kind === 'level')
    .map((item) => ({
      body: item.body,
      boundSkinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
      atMs: positive.trace.find((traceItem) => (
        traceItem.type === 'checkpoint_exact_level_result_confirmed'
        && traceItem.ordinal === item.body.ordinal
      )).atMs,
    }));
  const acceptedChestResults = positive.results
    .filter((item) => item.kind === 'chest')
    .map((item) => ({
      body: item.body,
      boundSkinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
      atMs: positive.trace.find(
        (traceItem) => traceItem.type === 'checkpoint_chest_after_exact_receipts',
      ).atMs,
    }));
  const ordinalLatenciesMs = acceptedLevelResults.map(
    (item, index) => item.atMs - impressions[index].atMs,
  );
  const liveSnapshot = {
    status: 'pass',
    expectedContentHash: EXACT_THREE_LEVEL_CONTENT_HASH,
    projectedImpressions: impressions,
    acceptedLevelResults,
    acceptedChestResults,
    ordinalLatenciesMs,
    p95Ms: Math.max(...ordinalLatenciesMs),
    closure: {
      manifestContentHash: allocation.manifest.contentHash,
      skinHash: allocation.manifest.skinHash,
      skinContractDigest: allocation.manifest.skinContractDigest,
      runtimeContractDigest: bundle.runtime.runtimeContractDigest,
      runtimeArtifactDigest: bundle.runtime.runtimeArtifactDigest,
      ticketSchema: ticket.schema,
      bundleSchema: bundle.schema,
      specHashes: allocation.manifest.levels.map((level) => level.specHash),
      entryId: allocation.catalog.entryId,
      seriesId: allocation.catalog.seriesId,
      decisionId: allocation.decisionId,
      ticketId: ticket.ticket_id,
      runId: ticket.run_id,
    },
  };
  assert.equal(liveSnapshot.closure.runtimeContractDigest, EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST);
  assert.equal(liveSnapshot.closure.runtimeArtifactDigest, EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST);
  const operatorObservation = buildThreeLevelLiveOperatorObservation(
    liveSnapshot,
    { auditNonce: 'ab'.repeat(32) },
  );
  assert.equal(operatorObservation.authority, 'non_authoritative_operator_observation');
  assert.equal(operatorObservation.eligibleForLevelSeriesRollout, false);
  assert.equal(operatorObservation.evidence.ordinalLatenciesMs.length, 3);
  const forgedLatency = structuredClone(liveSnapshot);
  forgedLatency.ordinalLatenciesMs[0] += 1;
  assert.throws(
    () => buildThreeLevelLiveOperatorObservation(forgedLatency, { auditNonce: 'ab'.repeat(32) }),
    /exact three-level production closure/,
    'receipt builder must recompute ordinal deltas instead of trusting browser p95',
  );
  console.log(JSON.stringify(audit));
  console.log(
    'catalog feed dogfood browser: exact three-level fixture audit + reload/event-order/cross-origin negatives verified',
  );
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
