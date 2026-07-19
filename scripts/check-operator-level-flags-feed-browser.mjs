import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright';

const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CATALOG_DOGFOOD_LEVEL_COUNT: '3',
    CATALOG_DOGFOOD_TIMEOUT_MS: '30000',
    CATALOG_OPERATOR_LEVEL_FLAGS_HARNESS: 'true',
    VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS: '5000',
  },
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(
    () => reject(new Error(`operator flag feed harness startup timed out\n${stderr}`)),
    120_000,
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl && parsed.replayedCanaryUrl) {
          clearTimeout(timeout);
          resolve(parsed);
          return;
        }
      } catch { /* build output is not endpoint JSON */ }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    reject(new Error(
      `operator flag feed harness exited before startup (${String(code)})\n${stderr}\n${stdout}`,
    ));
  });
});

const stateOf = (page) => page.evaluate(() => window.__catalogFeedDogfoodHarness);
const waitForState = (page, predicateSource, arg = null, timeout = 20_000) => page.waitForFunction(
  ({ source, value }) => {
    const state = window.__catalogFeedDogfoodHarness;
    return state ? Function('state', 'value', `return (${source})(state, value)`)(state, value) : false;
  },
  { source: predicateSource, value: arg },
  { timeout },
);

const browser = await chromium.launch();
try {
  const draftPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await draftPage.goto(endpoints.successUrl, { waitUntil: 'domcontentloaded' });
  await draftPage.locator('.panel').evaluate((element) => { element.style.pointerEvents = 'none'; });
  const draftFeed = draftPage.frameLocator('iframe[data-testid="feed"]');
  const draftPreview = draftFeed.locator(
    '.page--in-viewport .game__operator-flag[data-flag-surface="preview"]',
  );
  try {
    await draftPreview.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    assert.fail(JSON.stringify({
      message: error.message,
      state: await stateOf(draftPage),
    }, null, 2));
  }
  await draftPage.evaluate(async () => {
    const response = await fetch('/__harness/operator-cp-release?kind=attempt', { method: 'POST' });
    if (!response.ok) throw new Error('failed to release operator attempt CP fixture');
  });
  await draftPreview.locator('.game__operator-flag-open').click();
  await draftPreview.locator('select[name="intent"]').selectOption('delete_candidate');
  await draftPreview.locator('textarea[name="comment"]')
    .fill('Черновик должен пережить подтверждение ручной попытки');

  await draftFeed.locator('[data-bar-tab="collections"]').click();
  await draftFeed.locator('.collections-view').waitFor({ state: 'visible' });
  assert.equal(await draftFeed.locator('.game__operator-flag').count(), 0,
    'a temporary null occurrence must remove the operator DOM surface');
  await draftFeed.locator('[data-bar-tab="feed"]').click();
  await draftPreview.waitFor({ state: 'visible' });
  assert.equal(await draftPreview.locator('.game__operator-flag-form').getAttribute('hidden'), null,
    'same subject after a null occurrence closed the open draft form');
  assert.equal(await draftPreview.locator('select[name="intent"]').inputValue(), 'delete_candidate');
  assert.equal(
    await draftPreview.locator('textarea[name="comment"]').inputValue(),
    'Черновик должен пережить подтверждение ручной попытки',
    'same subject after a null occurrence discarded typed text',
  );

  const remountedActive = draftFeed.locator(
    '.page--in-viewport .game__operator-flag[data-flag-surface="active_level"]',
  );
  await remountedActive.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await remountedActive.locator('.game__operator-flag-form').getAttribute('hidden'), null,
    'same-subject preview→active remount closed the open draft form');
  assert.equal(await remountedActive.locator('select[name="intent"]').inputValue(), 'delete_candidate');
  assert.equal(
    await remountedActive.locator('textarea[name="comment"]').inputValue(),
    'Черновик должен пережить подтверждение ручной попытки',
    'same-subject preview→active remount discarded typed text',
  );
  await waitForState(draftPage, `(state) => state.operatorAttemptCpTransportAttempts >= 1`);
  await waitForState(draftPage, `(state) => state.operatorAttemptCpAckPending === false
    && state.cpEvents.some((event) => event.event_name === 'attempt_start')`);
  assert.equal(
    await remountedActive.locator('textarea[name="comment"]').inputValue(),
    'Черновик должен пережить подтверждение ручной попытки',
    'delayed attempt receipt discarded the same-subject draft',
  );

  const catalogRuntime = draftPage.frames().find(
    (frame) => frame.parentFrame()?.parentFrame() === draftPage.mainFrame()
      && frame.url().includes('/runtime-releases/'),
  );
  assert.ok(catalogRuntime, 'configured catalog runtime frame was not found');
  await catalogRuntime.evaluate(() => {
    parent.postMessage({ source: 'playable', type: 'completed', success: true, outcome: 'won' }, location.origin);
  });
  await waitForState(
    draftPage,
    `(state) => state.checkpoints.configuredImpressions.length >= 2`,
    null,
    15_000,
  );
  const nextSubject = draftFeed.locator('.page--in-viewport .game__operator-flag');
  await nextSubject.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await nextSubject.locator('select[name="intent"]').inputValue(), 'edit_candidate',
    'a different generated subject inherited the previous intent');
  assert.equal(await nextSubject.locator('textarea[name="comment"]').inputValue(), '',
    'a different generated subject inherited the previous comment');
  assert.notEqual(await nextSubject.locator('.game__operator-flag-form').getAttribute('hidden'), null,
    'a different generated subject inherited the open form state');
  assert.equal((await stateOf(draftPage)).operatorFlagRequests.length, 0,
    'draft preservation created a request without explicit submit');
  await draftPage.close();

  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.goto(endpoints.successUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.panel').evaluate((element) => { element.style.pointerEvents = 'none'; });
  const feed = page.frameLocator('iframe[data-testid="feed"]');

  await waitForState(page, `(state) => state.trace.some((item) => item.type === 'session')
    && state.client.currentFrame === 'builtin'`);
  assert.equal(
    await feed.locator('.game__operator-flag').count(),
    0,
    'capability=true must not render a control on the current built-in or prepared off-screen catalog slot',
  );

  const preview = feed.locator('.page--in-viewport .game__operator-flag[data-flag-surface="preview"]');
  await preview.waitFor({ state: 'visible', timeout: 20_000 });
  await waitForState(page, `(state) => state.client.currentFrame === 'catalog'`);
  assert.equal(await feed.locator('.game__operator-flag').count(), 1,
    'only the active generated occurrence may own a control');
  await preview.locator('.game__operator-flag-open').click();
  await preview.locator('textarea[name="comment"]').fill('На превью мир выглядит слишком знакомым');
  await preview.locator('button[type="submit"]').click();
  try {
    await waitForState(page, `(state) => state.operatorFlagRequests.length === 1`, null, 5000);
  } catch (error) {
    assert.fail(JSON.stringify({
      message: error.message,
      status: await feed.locator('.game__operator-flag-status').allTextContents(),
      surfaces: await feed.locator('.game__operator-flag').evaluateAll(
        (items) => items.map((item) => item.dataset.flagSurface),
      ),
      state: await stateOf(page),
    }, null, 2));
  }
  await preview.locator('.game__operator-flag-status').filter({ hasText: 'Пометка сохранена' }).waitFor();

  const active = feed.locator('.page--in-viewport .game__operator-flag[data-flag-surface="active_level"]');
  await active.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForState(page, `(state) => state.operatorAttemptCpTransportAttempts >= 1`);
  await active.locator('.game__operator-flag-open').click();
  await active.locator('select[name="intent"]').selectOption('delete_candidate');
  await active.locator('textarea[name="comment"]').fill('В активной игре payoff слишком слабый');
  await active.locator('button[type="submit"]').click();
  await active.locator('.game__operator-flag-status')
    .filter({ hasText: 'ещё синхронизируются' }).waitFor({ timeout: 5000 });
  assert.equal((await stateOf(page)).operatorFlagRequests.length, 1,
    'transient CP failure must send zero active operator POSTs');
  await page.evaluate(async () => {
    const response = await fetch('/__harness/operator-cp-release?kind=attempt', { method: 'POST' });
    if (!response.ok) throw new Error('failed to release operator CP fixture');
  });
  await active.locator('button[type="submit"]').click();
  await waitForState(page, `(state) => state.operatorAttemptCpAckPending === true`);
  assert.equal((await stateOf(page)).operatorFlagRequests.length, 1,
    'operator POST must wait for the exact delayed attempt_start receipt');
  await waitForState(page, `(state) => state.operatorFlagRequests.length === 2`);
  let state = await stateOf(page);
  assert.equal(state.operatorFlagResponses, 1, 'active flag response must still be deliberately pending');
  assert.equal(state.operatorFlagRequests[1].responseSentAtMs, null);

  // The advisory POST is intentionally held by the harness. Real feed
  // navigation must still settle on the next unit before that response exists.
  await feed.locator('.page--in-viewport .game__close').evaluate((button) => button.click());
  await waitForState(page, `(state) => state.client.currentFrame === 'builtin'`, null, 1500);
  assert.equal(await feed.locator('.game__operator-flag').count(), 0,
    'leaving the generated occurrence must synchronously remove its control');
  state = await stateOf(page);
  assert.equal(state.operatorFlagRequests[1].responseSentAtMs, null,
    'navigation waited for the advisory flag POST');
  await waitForState(page, `(state) => state.operatorFlagResponses === 2`, null, 5000);

  state = await stateOf(page);
  const [previewEvidence, activeEvidence] = state.operatorFlagRequests;
  const previewRequest = previewEvidence.body;
  const activeRequest = activeEvidence.body;
  assert.equal(previewRequest.flagSurface, 'preview');
  assert.equal(previewRequest.causal.levelImpressionId, null);
  assert.equal(previewRequest.causal.runId, null);
  assert.equal(activeRequest.flagSurface, 'active_level');

  for (const evidence of [previewEvidence, activeEvidence]) {
    const catalogImpression = evidence.cpEventsAtPost.find(
      (event) => event.event_name === 'catalog_level_impression_v2'
        && event.payload.ordinal === evidence.body.subject.ordinal,
    );
    assert.ok(catalogImpression, 'flag POST arrived before its catalog content impression was projected');
    assert.equal(evidence.body.causal.decisionId, catalogImpression.payload.decision_id);
    assert.equal(evidence.body.causal.contentImpressionId, catalogImpression.payload.impression_id);
    assert.equal(evidence.body.subject.catalogEntryId, catalogImpression.payload.catalog_entry_id);
    assert.equal(evidence.body.subject.seriesId, catalogImpression.payload.series_id);
    assert.equal(evidence.body.subject.levelSpecHash, catalogImpression.payload.level_spec_hash);
    assert.equal(evidence.body.subject.skinHash, catalogImpression.payload.skin_hash);
  }
  const activeCatalogImpression = activeEvidence.cpEventsAtPost.find(
    (event) => event.event_name === 'catalog_level_impression_v2'
      && event.payload.ordinal === activeRequest.subject.ordinal,
  );
  const attemptStart = activeEvidence.cpEventsAtPost.find(
    (event) => event.event_name === 'attempt_start'
      && event.payload.level_impression_id === activeRequest.causal.levelImpressionId,
  );
  assert.ok(attemptStart, 'active flag POST arrived before its attempt_start was projected');
  assert.ok(activeEvidence.cpEventsAtPost.some(
    (event) => event.event_id === attemptStart.event_id && event.event_name === 'attempt_start',
  ));
  assert.equal(activeRequest.causal.levelImpressionId, activeCatalogImpression.payload.level_impression_id);
  assert.equal(activeRequest.causal.runId, attemptStart.payload.run_id,
    'active occurrence must add runId once the exact attempt exists');
  await page.close();

  const levelGatePage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await levelGatePage.goto(endpoints.disabledUrl, { waitUntil: 'domcontentloaded' });
  await levelGatePage.locator('.panel').evaluate((element) => { element.style.pointerEvents = 'none'; });
  const levelGateFeed = levelGatePage.frameLocator('iframe[data-testid="feed"]');
  const levelGatePreview = levelGateFeed.locator(
    '.page--in-viewport .game__operator-flag[data-flag-surface="preview"]',
  );
  try {
    await levelGatePreview.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    assert.fail(JSON.stringify({
      message: error.message,
      state: await stateOf(levelGatePage),
    }, null, 2));
  }
  await waitForState(
    levelGatePage,
    `(state) => state.operatorCatalogCpTransportAttempts >= 1
      && !state.cpEvents.some((event) => event.event_name === 'catalog_level_impression_v2')`,
  );
  await levelGatePreview.locator('.game__operator-flag-open').click();
  await levelGatePreview.locator('textarea[name="comment"]').fill('Preview receipt ещё не подтверждён');
  await levelGatePreview.locator('button[type="submit"]').click();
  await levelGatePreview.locator('.game__operator-flag-status')
    .filter({ hasText: 'ещё синхронизируются' }).waitFor({ timeout: 5000 });
  assert.equal((await stateOf(levelGatePage)).operatorFlagRequests.length, 0,
    'unprojected catalog impression must send zero preview operator POSTs');
  await levelGatePage.evaluate(async () => {
    const response = await fetch('/__harness/operator-cp-release?kind=level', { method: 'POST' });
    if (!response.ok) throw new Error('failed to release operator catalog CP fixture');
  });
  await levelGatePreview.locator('button[type="submit"]').click();
  await waitForState(levelGatePage, `(state) => state.operatorCatalogCpAckPending === true`);
  assert.equal((await stateOf(levelGatePage)).operatorFlagRequests.length, 0,
    'preview operator POST must wait for the exact delayed catalog impression receipt');
  await waitForState(levelGatePage, `(state) => state.operatorFlagRequests.length === 1`);
  const levelGateEvidence = (await stateOf(levelGatePage)).operatorFlagRequests[0];
  assert.equal(levelGateEvidence.body.flagSurface, 'preview');
  assert.ok(levelGateEvidence.cpEventsAtPost.some(
    (event) => event.event_name === 'catalog_level_impression_v2'
      && event.payload.impression_id === levelGateEvidence.body.causal.contentImpressionId,
  ), 'preview POST arrived before the exact catalog impression receipt');
  await levelGatePage.close();

  const disabledPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await disabledPage.goto(endpoints.replayedCanaryUrl, { waitUntil: 'domcontentloaded' });
  await disabledPage.locator('.panel').evaluate((element) => { element.style.pointerEvents = 'none'; });
  const disabledFeed = disabledPage.frameLocator('iframe[data-testid="feed"]');
  try {
    await waitForState(disabledPage, `(state) => state.client.currentFrame === 'catalog'`, null, 20_000);
  } catch (error) {
    assert.fail(JSON.stringify({
      message: error.message,
      state: await stateOf(disabledPage),
    }, null, 2));
  }
  assert.equal(await disabledFeed.locator('.game__operator-flag').count(), 0,
    'a configured generated catalog occurrence must expose no DOM when capability=false');
  await disabledPage.close();
} finally {
  await browser.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
}

console.log('operator level flags feed browser: preview/active closure, capability and nonblocking navigation verified');
