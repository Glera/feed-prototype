import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Localized copy of the backend-owned golden so this check is self-contained in CI;
// drift vs the sibling backend is guarded below.
const canonicalFixturePath = path.resolve(root, 'test-fixtures/feed-roster-session-v1.golden.json');
const backendFixturePath = path.resolve(
  root,
  '../swipe-backend/docs/specs/fixtures/feed-roster-session-v1.golden.json',
);
const fixtureBytes = readFileSync(canonicalFixturePath);
if (existsSync(backendFixturePath)) {
  assert.ok(
    readFileSync(backendFixturePath).equals(fixtureBytes),
    'local test-fixtures/feed-roster-session-v1.golden.json drifted from ../swipe-backend'
      + ` — refresh it: cp "${backendFixturePath}" "${canonicalFixturePath}"`,
  );
}
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const initialRoster = fixture.sessionProjection;
const reversedEntries = [...initialRoster.entries].reverse();
const reversedIdentityJcs = JSON.stringify({
  entries: reversedEntries.map((entry) => ({ builtinMappingId: entry.builtinMappingId })),
  schema: initialRoster.schema,
});
const nextRoster = {
  ...initialRoster,
  activationId: '77777777-7777-4777-8777-777777777777',
  rosterHash: createHash('sha256').update(reversedIdentityJcs).digest('hex'),
  entries: reversedEntries,
};
const challengeId = '88888888-8888-4888-8888-888888888888';
const challengePlayableId = 'merge-timepress-v1-swipe';
const challengeVariantId = '99999999-9999-4999-8999-999999999999';
const challenge = {
  id: challengeId,
  mechanic_id: challengePlayableId,
  variant_id: challengeVariantId,
  metric_key: 'time_ms',
  challenger_value: 1500,
  status: 'open',
  challenger: { id: 99, first_name: 'Roster fixture', username: null },
};
const cpEvents = [];
const ticketRequests = [];
const playableReworkRequests = [];
let playableReworkProjectionState = 'open';
let playableReworkExecution = { state: 'accepted', code: null, summary: null, updatedAt: null };
let playableReworkReleaseExecution = null;
let playableReworkListRequests = 0;
let operatorCapability = true;
let origin = '';

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
};

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const fakePlayable = (playableId) => `<!doctype html><html><body><canvas></canvas><script>
const id=${JSON.stringify(playableId)};
const send=(type,extra={})=>parent.postMessage({source:'playable',id,type,...extra},'*');
addEventListener('message',(event)=>{
  const data=event.data||{};
  if(data.target==='playable-swipe'&&data.type==='prepareInteractive')send('interactive_ready');
});
addEventListener('load',()=>send('static_ready'));
window.triggerAcceptedAction=()=>send('manual_action',{actionType:'fixture.accepted',actionSeq:1,accepted:true,changedState:true});
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/api/session') {
    return json(response, {
      user: { id: 42, ref_code: 'roster-browser' },
      ref_code: 'roster-browser',
      balance: 0,
      puzzles: 0,
      is_new: false,
      backend_version: 'roster-browser',
      operator_level_flagging_available: operatorCapability,
      feedRoster: nextRoster,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') {
    const body = await bodyOf(request);
    cpEvents.push(...body.events);
    return json(response, {
      events: body.events.map((event, item_index) => ({
        event_id: event.event_id,
        item_index,
        status: 'projected',
        reject_reason: null,
      })),
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/operator-playable-reworks') {
    const body = await bodyOf(request);
    playableReworkRequests.push(structuredClone(body));
    if (playableReworkRequests.length === 1) await new Promise((resolve) => setTimeout(resolve, 350));
    return json(response, {
      schema: 'feed.playable-rework.v1',
      requestId: body.mutationId,
      actorUserId: 42,
      requestHash: 'e'.repeat(64),
      request: body,
      state: 'open',
      releaseId: null,
      claimedAt: null,
      closedAt: null,
      closeReceiptDigest: null,
      execution: structuredClone(playableReworkExecution),
      ...(playableReworkReleaseExecution
        ? { releaseExecution: structuredClone(playableReworkReleaseExecution) } : {}),
      createdAt: body.context.capturedAt,
      replayed: playableReworkRequests.length > 1,
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/operator-playable-reworks') {
    playableReworkListRequests += 1;
    const body = playableReworkRequests.at(-1) || null;
    return json(response, {
      schema: 'feed.playable-rework-list.v1',
      items: body ? [{
        schema: 'feed.playable-rework.v1', requestId: body.mutationId,
        actorUserId: 42, requestHash: 'e'.repeat(64), request: body,
        state: playableReworkProjectionState, releaseId: null,
        claimedAt: playableReworkProjectionState === 'claimed' ? new Date().toISOString() : null,
        closedAt: null,
        closeReceiptDigest: null, createdAt: body.context.capturedAt,
        sourceAdapter: 'telegram', queueDisposition: 'active_batch',
        batchPresent: true, queueCounts: { active: 1, queued: 0 },
        execution: structuredClone(playableReworkExecution),
        ...(playableReworkReleaseExecution
          ? { releaseExecution: structuredClone(playableReworkReleaseExecution) } : {}),
      }] : [],
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/events') return json(response, { ok: true });
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    return json(response, { code: 'daily_not_configured' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/start') {
    const ticket = await bodyOf(request);
    ticketRequests.push(ticket);
    const now = Date.now();
    return json(response, {
      ticket_id: ticket.ticket_id,
      run_id: ticket.run_id,
      kind: ticket.kind,
      expected_levels: ticket.kind === 'series' ? 5 : 1,
      completed_levels: 0,
      next_result_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      state: 'active',
    });
  }
  if (request.method === 'GET' && url.pathname === `/api/challenges/${challengeId}`) {
    return json(response, challenge);
  }
  if (request.method === 'POST' && url.pathname === `/api/challenges/${challengeId}/accept`) {
    return json(response, challenge);
  }
  if (url.pathname === '/versions.json') {
    return json(response, Object.fromEntries([...initialRoster.entries.map((entry) => [
      entry.playableId,
      {
        version: 'roster-browser', mountCost: 'light',
        sourceCommit: 'a'.repeat(40), runtimeArtifactDigest: `sha256:${'b'.repeat(64)}`,
      },
    ]), [challengePlayableId, {
      version: 'roster-browser', mountCost: 'light',
      sourceCommit: 'a'.repeat(40), runtimeArtifactDigest: `sha256:${'b'.repeat(64)}`,
    }]]));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname.endsWith('.html')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(fakePlayable(path.basename(url.pathname, '.html')));
  }
  if (url.pathname.startsWith('/api/')) return json(response, { code: 'fixture_not_configured' }, 404);
  response.statusCode = 404;
  response.end('not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
  env: {
    ...process.env,
    VITE_API_BASE: origin,
    VITE_CONTROL_PLANE_ENABLED: 'true',
    VITE_CATALOG_PLAYER_V2_ENABLED: 'false',
    VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'false',
    VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'false',
    VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS: '150',
  },
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  assert.fail(`${build.stdout}\n${build.stderr}`);
}

const initData = new URLSearchParams({
  query_id: 'roster-browser',
  user: JSON.stringify({ id: 42 }),
  hash: 'roster-browser',
}).toString();
// The staged roster is per-user state, so the client namespaces it by the
// authenticated Telegram id (src/user-scope.ts). Seed and read the exact key the
// production build uses.
const ROSTER_SNAPSHOT_KEY = 'swipe_feed_roster_next_session_v1:42';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.addInitScript(({ data, snapshot, rosterKey }) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: null },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
    if (!sessionStorage.getItem('roster_browser_seeded')) {
      localStorage.setItem(rosterKey, JSON.stringify(snapshot));
      sessionStorage.setItem('roster_browser_seeded', '1');
    }
  }, { data: initData, snapshot: initialRoster, rosterKey: ROSTER_SNAPSHOT_KEY });

  await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`iframe[title="${nextRoster.entries[0].playableId}"]`, { timeout: 5000 });
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    nextRoster.entries[0].playableId,
    'a fresh verified /session roster owns the first opened ring',
  );
  await page.waitForFunction(([activationId, rosterKey]) => {
    const raw = localStorage.getItem(rosterKey);
    return raw && JSON.parse(raw).activationId === activationId;
  }, [nextRoster.activationId, ROSTER_SNAPSHOT_KEY], { timeout: 5000 });
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    nextRoster.entries[0].playableId,
    'the chosen first-open ring remains immutable after mount',
  );
  const rework = page.locator('.feed-bar .game__operator-playable-rework');
  await rework.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('.page--in-viewport .game__operator-playable-rework').count(), 0,
    'mechanic rework control must not cover the playable');
  const assertReworkGeometry = async (label) => {
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 760 });
      const reworkBox = await rework.boundingBox();
      const switchBox = await page.locator('.feed-bar__switch').boundingBox();
      assert.ok(reworkBox.x >= switchBox.x + switchBox.width,
        `${label} overlaps the centered product buttons at ${width}px`);
      const badge = rework.locator('[data-rework-count]:not([hidden])');
      if (await badge.count()) {
        const badgeBox = await badge.boundingBox();
        const overflow = await rework.locator('.game__operator-flag-open')
          .evaluate((element) => getComputedStyle(element).overflow);
        assert.equal(overflow, 'visible', `${label} clips the queue count badge at ${width}px`);
        assert.ok(badgeBox && badgeBox.width >= 16 && badgeBox.height >= 16,
          `${label} queue count badge is not readable at ${width}px`);
        assert.ok(badgeBox.x >= 0 && badgeBox.y >= 0 && badgeBox.x + badgeBox.width <= width,
          `${label} queue count badge escapes the viewport at ${width}px`);
      }
    }
    await page.setViewportSize({ width: 390, height: 760 });
  };
  await assertReworkGeometry('mechanic rework control');
  await page.locator('.page--in-viewport iframe').evaluate((frame) => { frame.dataset.runId = 'fresh-run-from-phone'; });
  await rework.locator('.game__operator-flag-open').click();
  const reworkInstruction = rework.locator('textarea[name="instruction"]');
  const dictate = rework.locator('button[data-action="dictate"]');
  await dictate.waitFor({ state: 'visible' });
  const dictationHintId = await reworkInstruction.getAttribute('aria-describedby');
  assert.ok(dictationHintId, 'instruction textarea must expose its dictation hint');
  assert.match(
    await rework.locator(`#${dictationHintId}`).textContent(),
    /нажмите на ней 🎤/,
    'dictation affordance must explain the Telegram keyboard handoff',
  );
  await dictate.click();
  assert.equal(
    await reworkInstruction.evaluate((element) => document.activeElement === element),
    true,
    'dictation tap must focus the instruction textarea so the system keyboard can dictate',
  );
  await reworkInstruction.fill('Увеличить подпись на текущем экране');
  await rework.locator('button[type="submit"]').click();
  await rework.locator('.game__operator-flag-status')
    .filter({ hasText: 'Сервер не ответил вовремя' }).waitFor({ timeout: 3000 });
  const listRequestsBeforeAccepted = playableReworkListRequests;
  await rework.locator('button[type="submit"]').click();
  await rework.locator('.game__operator-flag-status')
    .filter({ hasText: 'Такое замечание уже сохранено' }).waitFor({ timeout: 3000 });
  for (let attempt = 0; attempt < 40 && playableReworkListRequests === listRequestsBeforeAccepted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(playableReworkListRequests > listRequestsBeforeAccepted,
    'confirmed submission did not start a durable queue refresh independently of the control timer');
  await page.waitForTimeout(500);
  assert.match(await rework.locator('.game__operator-flag-status').innerText(), /уже сохранено/,
    'an immediate queue refresh must not remount away the durable submit receipt');
  assert.equal(playableReworkRequests.length, 2);
  assert.deepEqual(playableReworkRequests[1], playableReworkRequests[0],
    'transport retry must replay the exact mutationId, capturedAt and request bytes');
  assert.equal(playableReworkRequests[0].playableId, nextRoster.entries[0].playableId);
  assert.equal(playableReworkRequests[0].mappingId, nextRoster.entries[0].builtinMappingId);
  assert.equal(playableReworkRequests[0].rosterActivationId, nextRoster.activationId);
  assert.equal(playableReworkRequests[0].runtime.artifactDigest, `sha256:${'b'.repeat(64)}`);
  assert.equal(playableReworkRequests[0].context.runId, 'fresh-run-from-phone');
  assert.equal(playableReworkRequests[0].context.screenshot.reason, 'not_attached');
  const acceptedButton = rework.locator('.game__operator-flag-open[aria-label="В работе · добавить замечание"]');
  await acceptedButton.waitFor({ state: 'visible', timeout: 3000 });
  await assertReworkGeometry('accepted mechanic task');
  await acceptedButton.click();
  const immediateDetails = rework.locator('.game__operator-playable-rework-details');
  await immediateDetails.waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(
    await immediateDetails.locator('.game__operator-playable-rework-item p').first().textContent(),
    'Увеличить подпись на текущем экране',
    'the newly accepted task must disclose its exact instruction before restart',
  );
  await acceptedButton.click();
  assert.equal(await immediateDetails.getAttribute('hidden'), '',
    'a second tap must collapse, not remove, the immediate task details');
  assert.equal(await acceptedButton.getAttribute('aria-expanded'), 'false');
  for (let retry = 0; retry < 80
    && !cpEvents.some((event) => event.event_name === 'builtin_feed_decision_v2');
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const initialV2 = cpEvents.find((event) => event.event_name === 'builtin_feed_decision_v2');
  assert.ok(initialV2);
  assert.equal(initialV2.payload.roster_activation_id, nextRoster.activationId);
  assert.equal(initialV2.payload.mapping_id, nextRoster.entries[0].builtinMappingId);

  // A later open remains on the same server-owned activation; no second open
  // is required to make a newly activated mechanic visible.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`iframe[title="${nextRoster.entries[0].playableId}"]`, { timeout: 5000 });
  await page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open[aria-label="В работе · добавить замечание"]')
    .waitFor({ timeout: 5000 });
  assert.equal(
    await page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open').isDisabled(),
    false,
    'durable task label must stay tappable after Mini App reload',
  );
  await page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open').click();
  const taskDetails = page.locator('.feed-bar .game__operator-playable-rework-details');
  await taskDetails.waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(
    await taskDetails.locator('.game__operator-playable-rework-item p').first().textContent(),
    'Увеличить подпись на текущем экране',
    'the accepted label must disclose the exact durable instruction',
  );
  assert.match(
    await taskDetails.locator('.game__operator-playable-rework-item-heading small').textContent(),
    /Telegram · /,
    'the accepted task disclosure must identify when it was submitted',
  );
  await page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open').click();
  assert.equal(await taskDetails.getAttribute('hidden'), '',
    'a second tap must collapse, not remove, the restored task details');
  assert.equal(
    await page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open').getAttribute('aria-expanded'),
    'false',
  );
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    nextRoster.entries[0].playableId,
    'the fresh activation remains stable on later opens',
  );

  // The additive release execution projection owns visible Fast Lane states;
  // neither source claim nor the legacy agent receipt is mistaken for READY.
  playableReworkReleaseExecution = {
    releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'preparing',
    code: null,
    summary: null,
    updatedAt: '2026-08-07T11:59:00.000Z',
  };
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'),
    page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/operator-playable-reworks'),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  const preparingButton = page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open[aria-label="В работе · добавить замечание"]');
  await preparingButton.waitFor({ timeout: 5000 });
  assert.equal(await preparingButton.getAttribute('data-rework-state'), 'active');
  await preparingButton.click();
  assert.match(await page.locator('.game__operator-playable-rework-details').innerText(), /Готовится/);
  await preparingButton.click();

  // A failed release affects only this durable task and discloses its reason.
  await page.waitForTimeout(1_100);
  playableReworkReleaseExecution = {
    releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'needs_help',
    code: 'playable_rework_agent_check_failed',
    summary: 'Проверки механики не прошли; изменения не опубликованы.',
    updatedAt: '2026-08-07T12:00:00.000Z',
  };
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'),
    page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/operator-playable-reworks'),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  const blockedButton = page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open[aria-label="Нужна помощь · добавить замечание"]');
  await blockedButton.waitFor({ timeout: 5000 });
  assert.equal(await blockedButton.getAttribute('data-rework-state'), 'needs_help');
  await blockedButton.click();
  const blockerDetails = page.locator('.feed-bar .game__operator-playable-rework .game__operator-playable-rework-details');
  await blockerDetails.waitFor({ state: 'visible', timeout: 3000 });
  assert.equal(
    await blockerDetails.locator('[data-rework-task-blocker-summary]').textContent(),
    'Проверки механики не прошли; изменения не опубликованы.',
  );
  await blockerDetails.evaluate((node) => { node.dataset.identityProbe = 'preserve-open-details'; });
  await page.waitForTimeout(1_100); // cross the foreground restore-edge dedupe window
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'),
    page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/operator-playable-reworks'),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  assert.equal(await blockerDetails.getAttribute('data-identity-probe'), 'preserve-open-details',
    'unchanged foreground sync must not remount the mechanic task control');
  assert.equal(await blockerDetails.isVisible(), true,
    'unchanged foreground sync must preserve the open blocker disclosure');

  // READY is explicit; a source claim by itself is not review readiness.
  playableReworkExecution = { state: 'accepted', code: null, summary: null, updatedAt: null };
  playableReworkProjectionState = 'claimed';
  playableReworkReleaseExecution = {
    releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'ready_for_approval',
    code: null,
    summary: null,
    updatedAt: '2026-08-07T12:01:00.000Z',
  };
  await page.waitForTimeout(1_100); // request a distinct foreground bootstrap
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'),
    page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/operator-playable-reworks'),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  const readyButton = page.locator('.feed-bar .game__operator-playable-rework .game__operator-flag-open[aria-label="Готово к проверке"]');
  await readyButton.waitFor({ timeout: 5000 });
  assert.equal(await readyButton.getAttribute('data-rework-state'), 'ready_for_approval');
  await readyButton.click();
  assert.match(await page.locator('.game__operator-playable-rework-details').innerText(), /Готово к проверке/);
  await readyButton.click();
  await assertReworkGeometry('READY mechanic task');

  for (let retry = 0; retry < 80
    && !cpEvents.some((event) => event.event_name === 'builtin_feed_decision_v2'
      && event.payload.roster_activation_id === nextRoster.activationId);
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const nextV2 = cpEvents.find((event) => event.event_name === 'builtin_feed_decision_v2'
    && event.payload.roster_activation_id === nextRoster.activationId);
  assert.ok(nextV2, 'next-session roster did not emit its exact versioned decision payload');
  assert.deepEqual(Object.keys(nextV2.payload).sort(), [
    'decision_id', 'feed_position', 'mapping_id', 'roster_activation_id',
  ]);
  assert.equal(nextV2.payload.mapping_id, nextRoster.entries[0].builtinMappingId);
  await page.close();

  // A challenge is a forced social slot, not part of the default roster. A
  // roster which omits its mechanic must not invalidate the issued deep link.
  const challengeContext = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const challengePage = await challengeContext.newPage();
  await challengePage.addInitScript(({ data, snapshot, challengeStart, rosterKey }) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: challengeStart },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
    localStorage.setItem(rosterKey, JSON.stringify(snapshot));
  }, { data: initData, snapshot: initialRoster, challengeStart: challengeId, rosterKey: ROSTER_SNAPSHOT_KEY });
  const challengeEventOffset = cpEvents.length;
  const challengeTicketOffset = ticketRequests.length;
  await challengePage.goto(
    `${origin}/?initData=${encodeURIComponent(initData)}&c=${challengeId}`,
    { waitUntil: 'domcontentloaded' },
  );
  await challengePage.waitForSelector(
    `.page--in-viewport iframe[title="${challengePlayableId}"]`,
    { timeout: 5000 },
  );
  assert.equal(
    await challengePage.locator('.page--in-viewport iframe').getAttribute('title'),
    challengePlayableId,
    'an available challenged mechanic omitted from roster remains the first forced slot',
  );
  await challengePage.locator('.challenge-ov__btn', { hasText: 'Принять' }).click();
  await challengePage.waitForSelector('.challenge-ov', { state: 'detached' });
  await challengePage.waitForTimeout(200);
  assert.equal(
    cpEvents.slice(challengeEventOffset).some((event) =>
      event.event_name === 'builtin_feed_decision'
      || event.event_name === 'builtin_feed_decision_v2'),
    false,
    'forced challenge must remain outside built-in roster attribution',
  );

  const challengeFrame = challengePage.frames()
    .find((candidate) => candidate.url().includes(`${challengePlayableId}.html`));
  assert.ok(challengeFrame, 'forced challenge mechanic mounted');
  await challengePage.evaluate((playableId) => window.__feedHostGesture(playableId), challengePlayableId);
  await challengeFrame.evaluate(() => window.triggerAcceptedAction());
  let challengeTicket = ticketRequests.slice(challengeTicketOffset)
    .find((ticket) => ticket.challenge_id === challengeId);
  for (let retry = 0; retry < 40 && !challengeTicket; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    challengeTicket = ticketRequests.slice(challengeTicketOffset)
      .find((ticket) => ticket.challenge_id === challengeId);
  }
  assert.ok(challengeTicket, 'forced challenge action created its bound ticket');
  assert.equal(challengeTicket.variant_id, challengeVariantId,
    'forced challenge retains its immutable challenge variant');

  await challengePage.locator('.game--show-close .game__close').click();
  await challengePage.waitForFunction((playableId) =>
    document.querySelector('.page--in-viewport iframe')?.getAttribute('title') === playableId,
  nextRoster.entries[0].playableId, { timeout: 5000 });
  let rosterV2 = cpEvents.slice(challengeEventOffset).find((event) =>
    event.event_name === 'builtin_feed_decision_v2');
  for (let retry = 0; retry < 80 && !rosterV2; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    rosterV2 = cpEvents.slice(challengeEventOffset).find((event) =>
      event.event_name === 'builtin_feed_decision_v2');
  }
  assert.ok(rosterV2, 'the first default roster unit after challenge emits CP v2');
  assert.equal(rosterV2.payload.mapping_id, nextRoster.entries[0].builtinMappingId);
  assert.equal(rosterV2.payload.roster_activation_id, nextRoster.activationId);
  await challengeContext.close();

  operatorCapability = false;
  const ordinaryContext = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const ordinaryPage = await ordinaryContext.newPage();
  await ordinaryPage.addInitScript(({ data, snapshot, rosterKey }) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: null },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
    localStorage.setItem(rosterKey, JSON.stringify(snapshot));
  }, { data: initData, snapshot: initialRoster, rosterKey: ROSTER_SNAPSHOT_KEY });
  await ordinaryPage.goto(`${origin}/?initData=${encodeURIComponent(initData)}&ordinary=1`, { waitUntil: 'domcontentloaded' });
  await ordinaryPage.waitForSelector(`iframe[title="${nextRoster.entries[0].playableId}"]`, { timeout: 5000 });
  assert.equal(await ordinaryPage.locator('.game__operator-playable-rework').count(), 0,
    'capability=false exposed the mobile rework control to an ordinary player');
  await ordinaryContext.close();

  console.log('feed roster browser: first-open roster, mobile rework retry/capability, forced challenge isolation and CP v2 verified');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
