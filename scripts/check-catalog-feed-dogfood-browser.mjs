import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

import {
  buildThreeLevelFixtureAudit,
  buildThreeLevelLiveOperatorObservation,
  bindThreeLevelServerEvidenceToObservation,
  EXACT_THREE_LEVEL_CONTENT_HASH,
  validateThreeLevelServerEvidenceReceipt,
} from '../src/catalog-three-level-production-audit.mjs';
import {
  EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
  EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_HASH,
  EXACT_THREE_LEVEL_SPEC_HASHES,
  sha256Jcs,
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
          && parsed.timeoutResultUrl && parsed.disabledUrl && parsed.supersessionUrl
          && parsed.stateUrl) {
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

const runSupersessionTwoTabScenario = async () => {
  const context = await browser.newContext();
  const stalePage = await context.newPage();
  const replacementPage = await context.newPage();
  const browserErrors = [];
  stalePage.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  replacementPage.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  try {
    await stalePage.goto(endpoints.supersessionUrl, { waitUntil: 'domcontentloaded' });
    await stalePage.waitForFunction(() => {
      const snapshot = window.__catalogFeedDogfoodHarness;
      return snapshot?.canaryRequests?.length === 1
        && snapshot?.allocationRequests?.length === 1
        && snapshot?.ticketRequests?.length === 1
        && snapshot?.cpEvents?.some((event) => event.event_name === 'catalog_level_impression_v2');
    }, null, { timeout: 30_000 });
    const beforeReplacement = await stalePage.evaluate(() => window.__catalogFeedDogfoodHarness);
    const origin = new URL(endpoints.supersessionUrl).origin;
    await replacementPage.goto(
      `${origin}/feed?scenario=supersession&harness_instance=${encodeURIComponent(beforeReplacement.instanceToken)}&harness_tab=replacement`,
      { waitUntil: 'domcontentloaded' },
    );
    await stalePage.waitForFunction(() => {
      const snapshot = window.__catalogFeedDogfoodHarness;
      return snapshot?.canaryRequests?.length >= 2
        && snapshot?.allocationRequests?.some(
          (request) => request.authorizationId === '10000000-0000-4000-8000-000000000010',
        )
        && snapshot?.ticketRequests?.some(
          (request) => request.ticket_id === '10000000-0000-4000-8000-000000000010',
        )
        && snapshot?.allocationResponses?.some(
          (item) => item.allocationId === '10000000-0000-4000-8000-000000000010'
            && item.decisionId === '10000000-0000-4000-8000-000000000011',
        )
        && snapshot?.ticketResponses?.some(
          (item) => item.ticket_id === '10000000-0000-4000-8000-000000000010'
            && item.decision_id === '10000000-0000-4000-8000-000000000011',
        )
        && snapshot?.specResponses?.some(
          (item) => item.ticketId === '10000000-0000-4000-8000-000000000010'
            && item.decisionId === '10000000-0000-4000-8000-000000000011',
        );
    }, null, { timeout: 30_000 });
    await replacementPage.close();
    try {
      await stalePage.waitForFunction(() => {
        const snapshot = window.__catalogFeedDogfoodHarness;
        const terminalSupersession = snapshot?.supersessionResult?.code === 'catalog_ticket_superseded'
          || snapshot?.ticketConflicts?.some(
            (item) => item.code === 'catalog_ticket_superseded',
          ) || snapshot?.trace?.some(
            (item) => item.type === 'checkpoint_stale_tab_cp_superseded',
          );
        return snapshot?.status === 'pass' && terminalSupersession
          && snapshot?.client?.recoverySeen === true
          && snapshot?.client?.currentFrame === 'builtin';
      }, null, { timeout: 30_000 });
    } catch (error) {
      const snapshot = await stalePage.evaluate(() => window.__catalogFeedDogfoodHarness);
      throw new Error(`supersession did not settle\n${JSON.stringify(snapshot, null, 2)}`, { cause: error });
    }
    const finalState = await stalePage.evaluate(() => window.__catalogFeedDogfoodHarness);
    const diagnostic = JSON.stringify({
      supersessionResult: finalState.supersessionResult,
      canaryRequests: finalState.canaryRequests,
      allocationRequests: finalState.allocationRequests,
      allocationResponses: finalState.allocationResponses,
      ticketRequests: finalState.ticketRequests,
      ticketResponses: finalState.ticketResponses,
      ticketConflicts: finalState.ticketConflicts,
      specResponses: finalState.specResponses,
      catalogBindingConflicts: finalState.catalogBindingConflicts,
      results: finalState.results,
      client: finalState.client,
      trace: finalState.trace,
      browserErrors,
    }, null, 2);
    assert.equal(finalState.status, 'pass', diagnostic);
    assert.equal(finalState.supersessionActive, true, diagnostic);
    assert.equal(finalState.canaryRequests.length, 2, diagnostic);
    assert.deepEqual(
      finalState.allocationRequests.map((item) => item.authorizationId),
      [
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000010',
      ],
      diagnostic,
    );
    const replacementAllocation = finalState.allocationResponses.find(
      (item) => item.allocationId === '10000000-0000-4000-8000-000000000010',
    );
    assert.equal(replacementAllocation?.decisionId, '10000000-0000-4000-8000-000000000011', diagnostic);
    const replacementTicketRequest = finalState.ticketRequests.find(
      (item) => item.ticket_id === '10000000-0000-4000-8000-000000000010',
    );
    assert.equal(replacementTicketRequest?.decision_id, '10000000-0000-4000-8000-000000000011', diagnostic);
    const replacementTicket = finalState.ticketResponses.find(
      (item) => item.ticket_id === '10000000-0000-4000-8000-000000000010',
    );
    assert.equal(replacementTicket?.decision_id, '10000000-0000-4000-8000-000000000011', diagnostic);
    const replacementBundle = finalState.specResponses.find(
      (item) => item.ticketId === '10000000-0000-4000-8000-000000000010',
    );
    assert.equal(replacementBundle?.decisionId, '10000000-0000-4000-8000-000000000011', diagnostic);
    assert.deepEqual(finalState.catalogBindingConflicts, [], diagnostic);
    assert.deepEqual(
      finalState.ticketRequests
        .filter((item) => item.schema === 'run.start.v2')
        .slice(0, 2)
        .map((item) => item.ticket_id),
      [
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000010',
      ],
      diagnostic,
    );
    assert.equal(
      finalState.ticketConflicts.some((item) => (
        item.ticketId === '10000000-0000-4000-8000-000000000004'
        && item.code === 'catalog_ticket_superseded'
      )),
      true,
      diagnostic,
    );
    const terminalSurfaceCount = finalState.results.filter(
      (item) => item.outcome === 'superseded',
    ).length + finalState.ticketConflicts.filter(
      (item) => item.code === 'catalog_ticket_superseded',
    ).length + finalState.trace.filter(
      (item) => item.type === 'checkpoint_stale_tab_cp_superseded',
    ).length;
    assert.ok(terminalSurfaceCount >= 1, diagnostic);
    if (finalState.supersessionResult) {
      assert.equal(finalState.supersessionResult.ticketId, '10000000-0000-4000-8000-000000000004', diagnostic);
    }
    assert.equal(finalState.results.filter((item) => item.kind === 'chest').length, 0, diagnostic);
    assert.equal(finalState.client.chestSeen, false, diagnostic);
    assert.equal(finalState.client.rewardSeen, false, diagnostic);
    assert.equal(finalState.client.currentFrame, 'builtin', diagnostic);
    assert.equal(finalState.client.recoverySeen, true, diagnostic);
    const replacementTraceIndex = finalState.trace.findIndex(
      (item) => item.type === 'replacement_invitation_committed',
    );
    const firstStaleServerSurface = finalState.trace
      .slice(replacementTraceIndex + 1)
      .find((item) => item.type === 'stale_tab_server_surface'
        && item.ticketId === '10000000-0000-4000-8000-000000000004');
    assert.ok(replacementTraceIndex >= 0, diagnostic);
    assert.equal(firstStaleServerSurface?.terminal, true, diagnostic);
    assert.equal(firstStaleServerSurface?.code, 'ticket_superseded', diagnostic);
    const tma = new URLSearchParams({
      query_id: 'dogfood',
      harness_instance: finalState.instanceToken,
      harness_scenario: 'supersession',
      user: JSON.stringify({ id: 424242 }),
      hash: 'dogfood',
    }).toString();
    const authenticatedJson = (path, body) => fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { authorization: `tma ${tma}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const staleAllocation = await authenticatedJson('/api/catalog/allocate-authorized', {
      schema: 'catalog.allocate-authorized.v2',
      authorizationId: '10000000-0000-4000-8000-000000000004',
    });
    assert.equal(staleAllocation.status, 409, 'old authorization must be terminal after replacement');
    assert.equal((await staleAllocation.json()).code, 'catalog_ticket_superseded');
    const staleSpecs = await fetch(
      `${origin}/api/catalog/tickets/10000000-0000-4000-8000-000000000004/specs`,
      { headers: { authorization: `tma ${tma}` } },
    );
    assert.equal(staleSpecs.status, 410, 'old spec bundle must be terminal after replacement');
    assert.equal((await staleSpecs.json()).code, 'catalog_ticket_superseded');
    const staleImpression = structuredClone(finalState.cpEvents.find(
      (event) => event.event_name === 'catalog_level_impression_v2'
        && event.payload.ticket_id === '10000000-0000-4000-8000-000000000004',
    ));
    staleImpression.event_id = '30000000-0000-4000-8000-000000000001';
    const staleCp = await authenticatedJson('/api/cp/events', { events: [staleImpression] });
    assert.equal(staleCp.status, 200);
    assert.deepEqual(
      (await staleCp.json()).events.map((item) => [item.status, item.reject_reason]),
      [['rejected', 'ticket_superseded']],
      'old configured-impression must be terminal after replacement',
    );
    const staleStart = await authenticatedJson('/api/runs/start', {
      schema: 'run.start.v2',
      ticket_id: '10000000-0000-4000-8000-000000000004',
      run_id: 'catalog-canary:10000000-0000-4000-8000-000000000004',
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      kind: 'series',
      decision_id: '10000000-0000-4000-8000-000000000005',
    });
    assert.equal(staleStart.status, 409, 'old run start must be terminal after replacement');
    assert.equal((await staleStart.json()).detail.code, 'catalog_ticket_superseded');
    const staleResult = await authenticatedJson('/api/results', {
      schema: 'catalog.result.v2',
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      run_id: '30000000-0000-4000-8000-000000000002',
      metric_key: 'time_ms',
      metric_value: 1000,
      stars: 0,
      series_level: 1,
      series_id: '10000000-0000-4000-8000-000000000007',
      ordinal: 1,
      applied_spec_hash: exactSpecHashes[0],
      applied_skin_hash: EXACT_THREE_LEVEL_SKIN_HASH,
      tz_offset_minutes: 180,
      ticket_id: '10000000-0000-4000-8000-000000000004',
    });
    assert.equal(staleResult.status, 409, 'old result must be terminal after replacement');
    assert.equal((await staleResult.json()).code, 'catalog_ticket_superseded');
    const forgedAllocation = await authenticatedJson('/api/catalog/allocate-authorized', {
      schema: 'catalog.allocate-authorized.v2',
      authorizationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    assert.equal(forgedAllocation.status, 409, 'unknown authorization must not be reflected');
    assert.equal((await forgedAllocation.json()).code, 'catalog_authorization_binding_mismatch');
    const mismatchedReplacementStart = await authenticatedJson('/api/runs/start', {
      schema: 'run.start.v2',
      ticket_id: '10000000-0000-4000-8000-000000000010',
      run_id: 'catalog-canary:10000000-0000-4000-8000-000000000010',
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      kind: 'series',
      decision_id: '10000000-0000-4000-8000-000000000005',
    });
    assert.equal(mismatchedReplacementStart.status, 409, 'replacement ticket must require its server-owned decision');
    assert.equal((await mismatchedReplacementStart.json()).detail.code, 'catalog_ticket_binding_mismatch');
    assert.deepEqual(browserErrors, [], diagnostic);
    return finalState;
  } finally {
    await context.close();
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
        levelImpressionId: event.payload.level_impression_id,
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
      allocationId: allocation.allocationId,
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
      runtimeReleaseId: ticket.runtime_release_id,
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
  const baseTime = Date.parse('2026-07-16T10:00:00.000Z');
  const serverReceipt = {
    schema: 'catalog.three-level-production-evidence.v1',
    receiptId: '10000000-0000-4000-8000-000000000001',
    authority: 'server_authoritative',
    evidenceScope: 'production-control-plane',
    contentHash: EXACT_THREE_LEVEL_CONTENT_HASH,
    allocationId: allocation.allocationId,
    decisionId: allocation.decisionId,
    decisionRequestHash: 'a'.repeat(64),
    ticketId: ticket.ticket_id,
    catalogEntryId: allocation.catalog.entryId,
    seriesId: allocation.catalog.seriesId,
    runtimeReleaseId: ticket.runtime_release_id,
    runtimeContractDigest: EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
    runtimeArtifactDigest: EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
    skinHash: EXACT_THREE_LEVEL_SKIN_HASH,
    skinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
    rootRunId: ticket.run_id,
    levels: impressions.map((item, index) => {
      const configuredAt = new Date(baseTime + index * 10_000);
      const acceptedAt = new Date(configuredAt.getTime() + ordinalLatenciesMs[index]);
      const sourceEvent = positive.cpEvents.find((event) => event.event_id === item.eventId);
      return {
        ordinal: index + 1,
        specHash: EXACT_THREE_LEVEL_SPEC_HASHES[index],
        skinHash: EXACT_THREE_LEVEL_SKIN_HASH,
        skinContractDigest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
        levelImpressionId: sourceEvent.payload.level_impression_id,
        configurationEventId: item.eventId,
        runtimeConfiguredAt: configuredAt.toISOString(),
        configurationReceivedAt: configuredAt.toISOString(),
        configuredAt: configuredAt.toISOString(),
        acceptedRunId: acceptedLevelResults[index].body.run_id,
        acceptedAt: acceptedAt.toISOString(),
        configuredToAcceptedMs: ordinalLatenciesMs[index],
      };
    }),
    acceptedChest: {
      runId: ticket.run_id,
      acceptedAt: new Date(baseTime + 60_000).toISOString(),
      metricValue: 3,
    },
    timings: {
      metric: 'configured_to_accepted_ms',
      samples: ordinalLatenciesMs,
      sampleCount: 3,
      p95Ms: Math.max(...ordinalLatenciesMs),
      derivedBy: 'server_from_durable_timestamps',
    },
    materializedAt: new Date(baseTime + 61_000).toISOString(),
    eligibleForLevelSeriesRollout: false,
  };
  const serverEnvelope = {
    schema: 'catalog.three-level-production-evidence-receipt.v1',
    receiptDigest: sha256Jcs(serverReceipt),
    receipt: serverReceipt,
  };
  assert.equal(
    validateThreeLevelServerEvidenceReceipt(serverEnvelope).receipt.authority,
    'server_authoritative',
  );
  assert.equal(
    bindThreeLevelServerEvidenceToObservation(
      serverEnvelope,
      { ...liveSnapshot, status: 'running' },
      { auditNonce: 'ab'.repeat(32) },
    ).receipt.ticketId,
    ticket.ticket_id,
  );
  const newerTicketEvidence = structuredClone(serverEnvelope);
  newerTicketEvidence.receipt.ticketId = '20000000-0000-4000-8000-000000000001';
  newerTicketEvidence.receiptDigest = sha256Jcs(newerTicketEvidence.receipt);
  assert.throws(
    () => bindThreeLevelServerEvidenceToObservation(
      newerTicketEvidence,
      { ...liveSnapshot, status: 'running' },
      { auditNonce: 'ab'.repeat(32) },
    ),
    /different browser-observed production play/,
    'a newer exact-content ticket must not replace the browser-observed play',
  );
  const duplicateConfigurationEvidence = structuredClone(serverEnvelope);
  duplicateConfigurationEvidence.receipt.levels[1].configurationEventId = (
    duplicateConfigurationEvidence.receipt.levels[0].configurationEventId
  );
  duplicateConfigurationEvidence.receipt.levels[1].levelImpressionId = (
    duplicateConfigurationEvidence.receipt.levels[0].levelImpressionId
  );
  duplicateConfigurationEvidence.receiptDigest = sha256Jcs(
    duplicateConfigurationEvidence.receipt,
  );
  assert.throws(
    () => validateThreeLevelServerEvidenceReceipt(duplicateConfigurationEvidence),
    /content-addressed three-level production closure/,
    'three ordinals must have three distinct configured impressions and events',
  );
  const forgedServerEvidence = structuredClone(serverEnvelope);
  forgedServerEvidence.receipt.levels[0].acceptedRunId = ticket.run_id;
  forgedServerEvidence.receiptDigest = sha256Jcs(forgedServerEvidence.receipt);
  assert.throws(
    () => validateThreeLevelServerEvidenceReceipt(forgedServerEvidence),
    /exact content-addressed three-level production closure/,
    'content-addressing cannot make a root-run substitution authoritative',
  );
  await runSupersessionTwoTabScenario();
  console.log(JSON.stringify(audit));
  console.log(
    'catalog feed dogfood browser: exact three-level fixture audit + two-tab supersession/reload/event-order/cross-origin negatives verified',
  );
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
