/**
 * Browser contract for the operator-only platform development intake. The
 * production build must bind requests to one exact source SHA, keep the
 * capability server-owned, and make a lost-response retry idempotent without
 * ever implying that a submitted request was published.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'operator-development-intakes-browser-'));
const BUILD_SHA = 'b'.repeat(40);
const INSTRUCTION = 'Сделать подпись версии заметнее.';
const RACE_INSTRUCTION = 'Не позволить старой проекции заменить новую задачу.';
const DURING_POST_INSTRUCTION = 'Не позволить GET во время POST заменить receipt.';
const REJECTED_INSTRUCTION = 'Сервер может окончательно отклонить этот запрос.';
const intakeSelector = '.platform-development-intake';
const openSelector = '.platform-development-intake__open';
const formSelector = `${intakeSelector} form`;
const detailsSelector = '.platform-development-intake__details';
let origin = '';
let sessionUserId = 42;
let developmentIntakeAvailable = false;
let developmentIntakeContextBuildSha = BUILD_SHA;
let catalogLabAvailable = false;
let sessionUnauthorized = false;
let loseFirstPostResponse = false;
let rejectNextPostStatus = null;
let holdNextPost = false;
let heldPost = null;
let holdNextProjection = false;
let heldProjection = null;
let projectionItems = [];
const postedRequests = [];

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const sessionResponse = () => ({
  user: { id: sessionUserId, ref_code: 'browser-fixture' },
  ref_code: 'browser-fixture',
  balance: 0,
  puzzles: 0,
  is_new: false,
  backend_version: 'operator-development-intakes-browser-fixture',
  catalog_lab_authorization_available: catalogLabAvailable,
  operator_level_flagging_available: false,
  development_intake_available: developmentIntakeAvailable,
  ...(developmentIntakeAvailable ? {
    development_intake_context: { buildSha: developmentIntakeContextBuildSha },
  } : {}),
  builtin_feed_bindings: {
    schema: 'feed.builtin-bindings.v1',
    available: false,
    unavailable_reason: 'browser_fixture',
    by_playable_id: {},
  },
});

const receiptFor = (
  request,
  { status = 'queued', replayed = false, terminal = null } = {},
) => ({
  schema: 'platform.development-intake.response.v1',
  requestId: '11111111-1111-5111-8111-111111111111',
  mutationId: request.mutationId,
  requestHash: 'c'.repeat(64),
  delivery: {
    deliveryId: '22222222-2222-5222-8222-222222222222',
    status,
    issueUrl: status === 'confirmed'
      ? 'https://github.com/Glera/p4g-workspace-meta/issues/17'
      : null,
    nothingPublished: true,
  },
  terminal,
  request,
  replayed,
  createdAt: new Date(Date.parse(request.capturedAt) + 1_000).toISOString(),
});

const readJsonBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.once('error', reject);
  request.once('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      reject(error);
    }
  });
});

const fakePlayable = `<!doctype html><html><body><canvas></canvas><script>
const id = location.pathname.split('/').pop().replace(/\\.html$/, '');
const send = (type) => parent.postMessage({ source: 'playable', id, type }, '*');
addEventListener('message', (event) => {
  if (event.data?.target === 'playable-swipe' && event.data?.type === 'prepareInteractive') {
    send('interactive_ready');
  }
});
addEventListener('load', () => send('static_ready'));
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/api/session') {
      request.resume();
      if (sessionUnauthorized) {
        return json(response, { detail: { code: 'telegram_session_rejected' } }, 401);
      }
      return json(response, sessionResponse());
    }
    if (request.method === 'GET' && url.pathname === '/api/development-intake') {
      if (url.search !== '?limit=1') {
        return json(response, { detail: 'development intake list must request exact limit=1' }, 400);
      }
      const snapshot = {
        schema: 'platform.development-intake.list.v1',
        items: structuredClone(projectionItems),
      };
      if (holdNextProjection) {
        holdNextProjection = false;
        heldProjection = { response, snapshot };
        return;
      }
      return json(response, snapshot);
    }
    if (request.method === 'POST' && url.pathname === '/api/development-intake') {
      const body = await readJsonBody(request);
      postedRequests.push(body);
      const mutationAttempts = postedRequests.filter((item) => item.mutationId === body.mutationId).length;
      const receipt = receiptFor(body, { replayed: mutationAttempts > 1 });
      if (rejectNextPostStatus !== null) {
        const status = rejectNextPostStatus;
        rejectNextPostStatus = null;
        return json(response, { detail: { code: 'development_intake_rejected' } }, status);
      }
      if (loseFirstPostResponse && mutationAttempts === 1) {
        // The mutation was accepted, but the caller receives only an
        // indeterminate gateway outcome. This is the stable browser-fixture
        // equivalent of a response lost between the durable API and WebView;
        // its read projection is deliberately allowed to lag until retry.
        return json(response, { detail: 'simulated lost response' }, 503);
      }
      if (holdNextPost) {
        holdNextPost = false;
        heldPost = { response, receipt };
        return;
      }
      projectionItems = [receipt];
      return json(response, receipt);
    }
    if (request.method === 'GET' && url.pathname === '/api/challenges') {
      return json(response, { box: 'in', items: [] });
    }
    if (request.method === 'POST' && url.pathname === '/api/events') {
      request.resume();
      return json(response, { ok: true }, 202);
    }
    if (url.pathname === '/versions.json') return json(response, {});
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(readFileSync(path.join(buildRoot, 'index.html')));
      return;
    }
    if (url.pathname.endsWith('.html')) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(fakePlayable);
      return;
    }
    if (url.pathname.endsWith('.payload.js')) {
      response.setHeader('content-type', 'application/javascript; charset=utf-8');
      response.end('');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      request.resume();
      return json(response, {}, 404);
    }
    response.statusCode = 404;
    response.end();
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const build = spawnSync('npx', [
  '--no-install',
  'vite',
  'build',
  '--outDir',
  buildRoot,
  '--emptyOutDir',
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VITE_API_BASE: origin,
    PLATFORM_SOURCE_SHA: BUILD_SHA,
    PLATFORM_VERSION: `browser-contract · ${BUILD_SHA.slice(0, 12)}`,
  },
  timeout: 180_000,
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
}

const telegramSdkFixture = `
window.Telegram = {
  WebApp: {
    initData: 'query_id=fixture&user=%7B%22id%22%3A42%7D&hash=fixture',
    initDataUnsafe: { user: { id: 42 }, start_param: null },
    platform: 'web',
    ready() {},
    expand() {},
    disableVerticalSwipes() {},
    setHeaderColor() {},
    setBackgroundColor() {},
    lockOrientation() {},
    onEvent() {},
    close() {},
  },
};`;

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
const releaseHeldProjection = () => {
  assert.ok(heldProjection, 'no controlled projection response is waiting');
  const current = heldProjection;
  heldProjection = null;
  json(current.response, current.snapshot);
};
const releaseHeldPost = () => {
  assert.ok(heldPost, 'no controlled mutation response is waiting');
  const current = heldPost;
  heldPost = null;
  projectionItems = [current.receipt];
  json(current.response, current.receipt);
};
const waitForFixture = async (predicate, label) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`fixture state timed out: ${label}`);
};

let browser = null;
try {
  browser = await chromium.launch();
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: telegramSdkFixture,
    }));
    return page;
  };
  const awaitSession = (page) => page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/session');

  // 1. The server capability is the only grant. A normal route and the legacy
  // diagnostics route both leave zero intake DOM for an ineligible account.
  developmentIntakeAvailable = false;
  catalogLabAvailable = false;
  projectionItems = [];
  const guest = await newPage();
  const guestSession = awaitSession(guest);
  await guest.goto(`${origin}/?browserCase=capability-false`, { waitUntil: 'domcontentloaded' });
  await guestSession;
  await guest.locator('iframe').first().waitFor({ state: 'attached' });
  await guest.waitForFunction(() => !document.querySelector('.preloader'));
  assert.equal(await guest.locator(intakeSelector).count(), 0,
    'an account without the capability received platform intake DOM');
  await guest.close();

  const diagnostics = await newPage();
  const diagnosticsSession = awaitSession(diagnostics);
  await diagnostics.goto(`${origin}/?diag=1`, { waitUntil: 'domcontentloaded' });
  await diagnosticsSession;
  await diagnostics.locator('[data-panel="swipe-debug"]').waitFor({ state: 'visible' });
  assert.equal(await diagnostics.locator(intakeSelector).count(), 0,
    'the ordinary ?diag route granted the platform intake capability');
  await diagnostics.close();

  developmentIntakeAvailable = true;
  developmentIntakeContextBuildSha = 'a'.repeat(40);
  const mismatchedContext = await newPage();
  const mismatchedContextSession = awaitSession(mismatchedContext);
  await mismatchedContext.goto(`${origin}/?browserCase=context-mismatch`, { waitUntil: 'domcontentloaded' });
  await mismatchedContextSession;
  await mismatchedContext.locator('iframe').first().waitFor({ state: 'attached' });
  assert.equal(await mismatchedContext.locator(intakeSelector).count(), 0,
    'a mismatched server-pinned build context mounted the intake control');
  await mismatchedContext.close();

  developmentIntakeContextBuildSha = BUILD_SHA;
  sessionUserId = null;
  const missingActor = await newPage();
  const missingActorSession = awaitSession(missingActor);
  await missingActor.goto(`${origin}/?browserCase=missing-actor`, { waitUntil: 'domcontentloaded' });
  await missingActorSession;
  await missingActor.locator('iframe').first().waitFor({ state: 'attached' });
  assert.equal(await missingActor.locator(intakeSelector).count(), 0,
    'a session without an exact authenticated actor mounted the intake control');
  await missingActor.close();
  sessionUserId = 42;

  // 2. The exact capability mounts one visible action that remains separate
  // from the centred product switcher at supported narrow phone widths.
  developmentIntakeAvailable = true;
  developmentIntakeContextBuildSha = BUILD_SHA;
  catalogLabAvailable = true;
  loseFirstPostResponse = true;
  projectionItems = [];
  postedRequests.length = 0;
  const operator = await newPage();
  const operatorSession = awaitSession(operator);
  const initialProjection = operator.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  const route = '/?browserCase=capability-true';
  await operator.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
  await operatorSession;
  await initialProjection;
  await operator.locator(openSelector).waitFor({ state: 'visible' });
  assert.equal(await operator.locator(intakeSelector).count(), 1,
    'the capability must mount exactly one platform intake control');
  for (const width of [320, 360, 390]) {
    await operator.setViewportSize({ width, height: 760 });
    const controlBox = await operator.locator(openSelector).boundingBox();
    const debugBox = await operator.locator('.feed-bar__debug').boundingBox();
    const labBox = await operator.locator('.feed-bar__lab').boundingBox();
    const switchBox = await operator.locator('.feed-bar__switch').boundingBox();
    assert.ok(controlBox && debugBox && labBox && switchBox,
      `operator controls were not measurable at ${width}px`);
    assert.equal(overlaps(controlBox, debugBox), false,
      `the platform intake overlaps diagnostics at ${width}px`);
    assert.equal(overlaps(controlBox, labBox), false,
      `the platform intake overlaps LAB at ${width}px`);
    assert.equal(overlaps(controlBox, switchBox), false,
      `the platform intake overlaps the product switcher at ${width}px`);
  }
  await operator.setViewportSize({ width: 375, height: 812 });

  // 3. Dictation is only a keyboard/microphone affordance over an editable
  // textarea. Cancelling and reopening must preserve the exact local draft.
  await operator.locator(openSelector).click();
  const instruction = operator.locator(`${formSelector} textarea[name="instruction"]`);
  await instruction.fill(INSTRUCTION);
  await operator.locator(`${formSelector} [data-action="dictate"]`).click();
  assert.equal(await instruction.evaluate((element) => document.activeElement === element), true,
    'dictation did not focus the instruction textarea');
  assert.equal(await instruction.isEditable(), true,
    'dictation target is not an editable textarea');
  await operator.locator(`${formSelector} [data-action="cancel"]`).click();
  await operator.locator(openSelector).click();
  assert.equal(await instruction.inputValue(), INSTRUCTION,
    'cancel/reopen lost the instruction draft');

  // 4. The first accepted request loses its HTTP response. A manual retry must
  // survive a full WebView reload, reuse the exact immutable request and
  // mutation identity, then render only a queued/nothing-published status from
  // the stable nested delivery object.
  await operator.locator(`${formSelector} button[type="submit"]`).click();
  await operator.waitForFunction(() => document.querySelector('.platform-development-intake output')?.textContent
    === 'Не удалось сохранить задачу.');
  assert.equal(postedRequests.length, 1, 'the lost-response attempt did not reach the server');
  const persistedPending = await operator.evaluate(() => {
    const key = Object.keys(localStorage).find((item) =>
      item.startsWith('platform-development-intake-pending:v1:'));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  assert.equal(persistedPending?.schema, 'platform.development-intake.pending.v1');
  assert.equal(persistedPending?.actorUserId, sessionUserId);
  assert.deepEqual(persistedPending?.request, postedRequests[0],
    'localStorage did not retain the complete immutable request');

  const retrySession = awaitSession(operator);
  const retryProjection = operator.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await operator.reload({ waitUntil: 'domcontentloaded' });
  await retrySession;
  await retryProjection;
  await operator.locator(openSelector).waitFor({ state: 'visible' });
  await operator.locator(openSelector).click();
  const restoredInstruction = operator.locator(`${formSelector} textarea[name="instruction"]`);
  assert.equal(await restoredInstruction.inputValue(), INSTRUCTION,
    'reload did not restore the pending instruction');
  assert.equal(await restoredInstruction.getAttribute('readonly'), '',
    'the restored immutable request remained editable');
  assert.equal(await operator.locator(`${formSelector} input[name="screenshot"]`).isDisabled(), true,
    'reload allowed a pending screenshot identity to be replaced');

  const retryResponse = operator.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  await operator.locator(`${formSelector} button[type="submit"]`).click();
  await retryResponse;
  await operator.locator(openSelector).waitFor({ state: 'visible' });
  assert.equal(postedRequests.length, 2, 'the explicit retry did not issue one second POST');
  assert.deepEqual(postedRequests[1], postedRequests[0],
    'the lost-response retry changed the immutable development intake request');
  assert.deepEqual(Object.keys(postedRequests[0]).sort(), [
    'buildSha', 'capturedAt', 'instruction', 'mutationId', 'route', 'schema', 'screenshot', 'surface',
  ]);
  assert.equal(postedRequests[0].schema, 'platform.development-intake.request.v1');
  assert.match(postedRequests[0].mutationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(postedRequests[0].instruction, INSTRUCTION);
  assert.equal(postedRequests[0].surface, 'feed');
  assert.equal(postedRequests[0].route, route);
  assert.equal(postedRequests[0].buildSha, BUILD_SHA);
  assert.match(postedRequests[0].capturedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(postedRequests[0].screenshot, {
    kind: 'unavailable',
    reason: 'not_attached',
    mimeType: null,
    dataUrl: null,
  });
  assert.equal(await operator.locator(openSelector).getAttribute('data-intake-state'), 'pending');
  await operator.locator(openSelector).click();
  const pendingStatus = operator.locator(`${detailsSelector} [data-intake-status]`);
  await pendingStatus.waitFor({ state: 'visible' });
  assert.equal(await pendingStatus.textContent(),
    'Задача сохранена и ждёт синхронизации; изменения не опубликованы.');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-request-id]`).textContent(),
    '11111111-1111-5111-8111-111111111111');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-mutation-id]`).textContent(),
    postedRequests[0].mutationId);
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-request-hash]`).textContent(),
    'c'.repeat(64));
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-replayed]`).textContent(),
    'true');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-delivery-state]`).textContent(),
    'queued');
  assert.equal(projectionItems[0].delivery.status, 'queued');
  assert.equal(projectionItems[0].delivery.nothingPublished, true);
  loseFirstPostResponse = false;

  // 5. A reload rehydrates the durable confirmed projection through GET. A
  // later foreground /session revocation removes the whole control from DOM.
  projectionItems = [receiptFor(postedRequests[0], { status: 'confirmed', replayed: true })];
  const reloadSession = awaitSession(operator);
  const reloadProjection = operator.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await operator.reload({ waitUntil: 'domcontentloaded' });
  await reloadSession;
  await reloadProjection;
  await operator.locator(`${openSelector}[data-intake-state="confirmed"]`).waitFor({ state: 'visible' });
  assert.equal(await operator.locator(intakeSelector).count(), 1,
    'GET rehydration stacked or lost the confirmed control');
  await operator.locator(openSelector).click();
  const confirmedStatus = operator.locator(`${detailsSelector} [data-intake-status]`);
  await confirmedStatus.waitFor({ state: 'visible' });
  assert.equal(await confirmedStatus.textContent(),
    'Инженерный тикет создан; изменения ещё не опубликованы.');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-delivery-state]`).textContent(),
    'confirmed');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-result]`).getAttribute('href'),
    'https://github.com/Glera/p4g-workspace-meta/issues/17');

  projectionItems = [receiptFor(postedRequests[0], {
    status: 'confirmed',
    replayed: true,
    terminal: {
      status: 'READY_TO_PLAY',
      summary: 'Bounded candidate is ready for operator testing.',
      candidate: {
        repository: 'Glera/feed-prototype',
        commitSha: 'd'.repeat(40),
        artifactDigest: `sha256:${'e'.repeat(64)}`,
        url: 'https://example.test/candidate/17',
      },
      blocker: null,
      review: {
        provider: 'claude',
        verdict: 'APPROVE',
        patchDigest: `sha256:${'f'.repeat(64)}`,
        reviewedAt: '2026-08-09T12:35:00.000Z',
      },
      recordedAt: '2026-08-09T12:35:01.000Z',
      nothingPublished: true,
    },
  })];
  await operator.waitForTimeout(1_050);
  const readySession = awaitSession(operator);
  const readyProjection = operator.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await operator.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await readySession;
  await readyProjection;
  await operator.locator(`${openSelector}[data-intake-state="ready"]`).waitFor({ state: 'visible' });
  await operator.locator(openSelector).click();
  await confirmedStatus.waitFor({ state: 'visible' });
  assert.equal(await confirmedStatus.textContent(),
    'READY_TO_PLAY: Bounded candidate is ready for operator testing.');
  assert.equal(await operator.locator(`${detailsSelector} [data-intake-result]`).getAttribute('href'),
    'https://example.test/candidate/17');

  await operator.locator(`${detailsSelector} [data-action="new"]`).click();
  const preservedDraft = 'Черновик после открытия системного выбора файла.';
  await operator.locator(`${formSelector} textarea[name="instruction"]`).fill(preservedDraft);
  await operator.waitForTimeout(1_050);
  const draftSession = awaitSession(operator);
  const draftProjection = operator.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await operator.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await draftSession;
  await draftProjection;
  assert.equal(await operator.locator(formSelector).isVisible(), true,
    'foreground projection closed an actively composed follow-up');
  assert.equal(
    await operator.locator(`${formSelector} textarea[name="instruction"]`).inputValue(),
    preservedDraft,
    'foreground projection replaced the active follow-up draft',
  );

  developmentIntakeAvailable = false;
  await operator.waitForTimeout(1_050);
  const revokedSession = awaitSession(operator);
  await operator.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await revokedSession;
  await operator.locator(intakeSelector).waitFor({ state: 'detached' });
  assert.equal(await operator.locator(intakeSelector).count(), 0,
    'capability revocation left platform intake DOM behind');
  await operator.close();

  // 6. A session-authentication rejection is stronger than a false feature
  // capability and must synchronously revoke the operator-only intake DOM.
  developmentIntakeAvailable = true;
  catalogLabAvailable = false;
  sessionUnauthorized = false;
  const rejected = await newPage();
  const rejectedInitialSession = awaitSession(rejected);
  await rejected.goto(`${origin}/?browserCase=auth-rejection`, { waitUntil: 'domcontentloaded' });
  await rejectedInitialSession;
  await rejected.locator(openSelector).waitFor({ state: 'visible' });
  await rejected.waitForTimeout(1_050);
  sessionUnauthorized = true;
  const rejectedSession = awaitSession(rejected);
  await rejected.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal((await rejectedSession).status(), 401,
    'the fixture did not exercise authenticated-session invalidation');
  await rejected.locator(intakeSelector).waitFor({ state: 'detached' });
  assert.equal(await rejected.locator(intakeSelector).count(), 0,
    'a 401 session invalidation left platform intake DOM behind');
  await rejected.close();

  // 7. A GET begun before submission is held until after the POST receipt. Its
  // older snapshot must be fenced by the mutation epoch and cannot replace the
  // newly accepted request when it finally arrives.
  sessionUnauthorized = false;
  developmentIntakeAvailable = true;
  catalogLabAvailable = false;
  projectionItems = [receiptFor(postedRequests[0], { status: 'confirmed', replayed: true })];
  holdNextProjection = true;
  const race = await newPage();
  const raceSession = awaitSession(race);
  const staleProjectionRequest = race.waitForRequest((request) =>
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/development-intake');
  await race.goto(`${origin}/?browserCase=projection-race`, { waitUntil: 'domcontentloaded' });
  await raceSession;
  await staleProjectionRequest;
  await race.locator(openSelector).waitFor({ state: 'visible' });
  await race.locator(openSelector).click();
  await race.locator(`${formSelector} textarea[name="instruction"]`).fill(RACE_INSTRUCTION);
  const racePost = race.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  await race.locator(`${formSelector} button[type="submit"]`).click();
  await racePost;
  await race.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  await race.locator(openSelector).click();
  assert.equal(await race.locator(`${detailsSelector} [data-intake-instruction]`).textContent(),
    RACE_INSTRUCTION);

  const staleProjectionResponse = race.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  releaseHeldProjection();
  await staleProjectionResponse;
  await race.waitForTimeout(100);
  assert.equal(await race.locator(`${detailsSelector} [data-intake-instruction]`).textContent(),
    RACE_INSTRUCTION,
    'a stale pre-submit GET overwrote the newly accepted receipt');
  assert.equal(await race.locator(openSelector).getAttribute('data-intake-state'), 'pending');
  await race.close();

  // 8. A second controlled race starts its stale GET while the mutation POST is
  // itself awaiting a response. The completion generation must fence that read.
  projectionItems = [];
  const duringPost = await newPage();
  const duringInitialSession = awaitSession(duringPost);
  const duringInitialProjection = duringPost.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await duringPost.goto(`${origin}/?browserCase=during-post-race`, { waitUntil: 'domcontentloaded' });
  await duringInitialSession;
  await duringInitialProjection;
  await duringPost.locator(openSelector).waitFor({ state: 'visible' });
  await duringPost.locator(openSelector).click();
  await duringPost.locator(`${formSelector} textarea[name="instruction"]`).fill(DURING_POST_INSTRUCTION);
  holdNextPost = true;
  const heldPostRequest = duringPost.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/development-intake');
  await duringPost.locator(`${formSelector} button[type="submit"]`).click();
  await heldPostRequest;
  await waitForFixture(() => heldPost !== null, 'held mutation response');

  await duringPost.waitForTimeout(1_050);
  projectionItems = [receiptFor(postedRequests[0], { status: 'confirmed', replayed: true })];
  holdNextProjection = true;
  const duringForegroundSession = awaitSession(duringPost);
  const duringProjectionRequest = duringPost.waitForRequest((request) =>
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/development-intake');
  await duringPost.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await duringForegroundSession;
  await duringProjectionRequest;
  await waitForFixture(() => heldProjection !== null, 'projection begun during mutation');

  const heldPostResponse = duringPost.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake');
  releaseHeldPost();
  await heldPostResponse;
  await duringPost.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  await duringPost.locator(openSelector).click();
  assert.equal(await duringPost.locator(`${detailsSelector} [data-intake-instruction]`).textContent(),
    DURING_POST_INSTRUCTION);

  const duringProjectionResponse = duringPost.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  releaseHeldProjection();
  await duringProjectionResponse;
  await duringPost.waitForTimeout(100);
  assert.equal(await duringPost.locator(`${detailsSelector} [data-intake-instruction]`).textContent(),
    DURING_POST_INSTRUCTION,
    'a GET begun during POST overwrote the terminal mutation receipt');
  await duringPost.close();

  // 9. A definitive 422 is not an ambiguous delivery. It clears immutable
  // pending state, preserves an editable instruction, and the next submit owns
  // a fresh mutation identity. The earlier 503 scenario proved the inverse.
  projectionItems = [];
  const definitive = await newPage();
  const definitiveSession = awaitSession(definitive);
  const definitiveProjection = definitive.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  const definitiveRoute = '/?browserCase=definitive-rejection';
  await definitive.goto(`${origin}${definitiveRoute}`, { waitUntil: 'domcontentloaded' });
  await definitiveSession;
  await definitiveProjection;
  await definitive.locator(openSelector).click();
  const definitiveInstruction = definitive.locator(`${formSelector} textarea[name="instruction"]`);
  await definitiveInstruction.fill(REJECTED_INSTRUCTION);
  const postsBeforeRejection = postedRequests.length;
  rejectNextPostStatus = 422;
  const definitiveResponse = definitive.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake');
  await definitive.locator(`${formSelector} button[type="submit"]`).click();
  assert.equal((await definitiveResponse).status(), 422);
  await definitive.waitForFunction(() => document.querySelector('.platform-development-intake output')?.textContent
    === 'Запрос отклонён сервером. Исправьте описание и отправьте снова.');
  assert.equal(await definitiveInstruction.isEditable(), true,
    'a definitive rejection left the original instruction locked');
  assert.equal(await definitiveInstruction.inputValue(), REJECTED_INSTRUCTION);
  assert.equal(await definitive.evaluate((route) => Object.keys(localStorage).some((key) =>
    key.startsWith('platform-development-intake-pending:v1:') && key.endsWith(route)), definitiveRoute), false,
  'a definitive rejection retained immutable pending storage');

  const acceptedAfterRejection = definitive.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  await definitive.locator(`${formSelector} button[type="submit"]`).click();
  await acceptedAfterRejection;
  assert.equal(postedRequests.length, postsBeforeRejection + 2);
  assert.notEqual(
    postedRequests[postsBeforeRejection].mutationId,
    postedRequests[postsBeforeRejection + 1].mutationId,
    'a definitive rejection did not release a fresh mutation identity',
  );
  await definitive.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  await definitive.close();

  console.log('operator development intake browser: visible request/mutation/hash/replay/delivery receipt, result link, exact retry, and capability fences verified');
} finally {
  if (heldProjection) releaseHeldProjection();
  if (heldPost) releaseHeldPost();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
