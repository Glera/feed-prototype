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
const SCREENSHOT_INSTRUCTION = 'Приложить обычный скриншот с телефона без правок.';
const DETACHED_INSTRUCTION = 'Отправить задачу без скриншота, снимок убрали до отправки.';
const UNDECODABLE_INSTRUCTION = 'Отдать задачу, даже если снимок не удалось открыть.';
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
  assert.equal(
    await operator.locator(`${formSelector} [data-action="remove-screenshot"]`).isDisabled(), true,
    'a restored pending request left «Удалить» able to detach its frozen screenshot identity',
  );

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
  assert.equal(await operator.locator(openSelector).getAttribute('aria-label'),
    '▶ Можно проверить',
    'terminal-ready must read in the current operator status vocabulary');
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

  // 10. An unedited full-resolution phone screenshot is prepared on device: the
  // form shows one removable preview, «Удалить» detaches it before submit, and
  // the re-attached file is downscaled and re-encoded into the bounded inline
  // wire value. There is no upload endpoint — the data URL is the whole
  // transport, so it must land inside the exact request budget.
  projectionItems = [];
  const capture = await newPage();
  const captureSession = awaitSession(capture);
  const captureProjection = capture.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await capture.goto(`${origin}/?browserCase=screenshot-capture`, { waitUntil: 'domcontentloaded' });
  await captureSession;
  await captureProjection;
  await capture.locator(openSelector).waitFor({ state: 'visible' });
  await capture.locator(openSelector).click();
  await capture.locator(`${formSelector} textarea[name="instruction"]`).fill(SCREENSHOT_INSTRUCTION);

  const phonePngDataUrl = await capture.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1_280;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[index] = seed & 255;
      pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  });
  const phonePng = Buffer.from(phonePngDataUrl.split(',')[1], 'base64');
  assert.ok(phonePng.length > 380_000,
    'the fixture must exceed the former hard-reject screenshot limit');

  const captureInput = capture.locator(`${formSelector} input[name="screenshot"]`);
  const captureSelection = capture.locator(`${formSelector} [data-intake-screenshot]`);
  const attachPhoneScreenshot = () => captureInput.setInputFiles({
    name: 'phone-screenshot.png', mimeType: 'image/png', buffer: phonePng,
  });
  await attachPhoneScreenshot();
  await captureSelection.waitFor({ state: 'visible' });
  assert.match(await captureSelection.innerText(), /phone-screenshot\.png/);
  assert.match(await captureSelection.innerText(), /подготовим автоматически/);

  await captureSelection.locator('[data-action="remove-screenshot"]').click();
  await captureSelection.waitFor({ state: 'hidden' });
  assert.equal(await captureInput.inputValue(), '',
    'removing the preview left the detached screenshot on the form');

  // «Удалить» before submit is an honest detach, not a hidden attachment: the
  // durable request carries the exact «unavailable» value.
  await capture.locator(`${formSelector} textarea[name="instruction"]`).fill(DETACHED_INSTRUCTION);
  const postsBeforeDetached = postedRequests.length;
  const detachedPost = capture.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  await capture.locator(`${formSelector} button[type="submit"]`).click();
  await detachedPost;
  assert.equal(postedRequests.length, postsBeforeDetached + 1,
    'the detached capture did not issue exactly one mutation');
  assert.equal(postedRequests[postsBeforeDetached].instruction, DETACHED_INSTRUCTION);
  assert.deepEqual(postedRequests[postsBeforeDetached].screenshot, {
    kind: 'unavailable',
    reason: 'not_attached',
    mimeType: null,
    dataUrl: null,
  }, 'a screenshot removed before submit still reached the durable request');
  await capture.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  await capture.locator(openSelector).click();
  await capture.locator(`${detailsSelector} [data-action="new"]`).click();
  await capture.locator(`${formSelector} textarea[name="instruction"]`).fill(SCREENSHOT_INSTRUCTION);

  await attachPhoneScreenshot();
  await captureSelection.waitFor({ state: 'visible' });
  const postsBeforeCapture = postedRequests.length;
  const capturePost = capture.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  // Preparation is awaited for seconds. The form is latched synchronously, in
  // the same turn as the submit, so nothing can detach or replace the exact
  // attachment that is already being inlined into the immutable request.
  const latched = await capture.evaluate((selector) => {
    const form = document.querySelector(`${selector} form`);
    form.requestSubmit(form.querySelector('button[type="submit"]'));
    const disabled = (target) => form.querySelector(target).disabled;
    return {
      status: document.querySelector(`${selector} output`).textContent,
      file: disabled('input[name="screenshot"]'),
      remove: disabled('[data-action="remove-screenshot"]'),
      instruction: disabled('textarea[name="instruction"]'),
      dictate: disabled('[data-action="dictate"]'),
      submit: disabled('button[type="submit"]'),
    };
  }, intakeSelector);
  await capturePost;
  const { status: latchedStatus, ...latchedControls } = latched;
  assert.equal(latchedStatus, 'Подготавливаю скриншот…',
    'the latch was not observed while the attached screenshot was being prepared');
  assert.deepEqual(latchedControls, {
    file: true,
    remove: true,
    instruction: true,
    dictate: true,
    submit: true,
  }, 'the intake form stayed editable while its attached screenshot was being prepared');
  assert.equal(postedRequests.length, postsBeforeCapture + 1,
    'the prepared capture did not issue exactly one mutation');
  const captured = postedRequests[postsBeforeCapture];
  assert.equal(captured.instruction, SCREENSHOT_INSTRUCTION);
  assert.equal(captured.screenshot.kind, 'data_url');
  assert.equal(captured.screenshot.reason, null);
  assert.equal(captured.screenshot.mimeType, 'image/jpeg',
    'an oversized phone screenshot must be prepared, not rejected');
  assert.match(captured.screenshot.dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(captured.screenshot.dataUrl.length <= 524_288,
    'the prepared screenshot exceeded the request wire budget');
  assert.ok(captured.screenshot.dataUrl.length < phonePngDataUrl.length,
    'the prepared screenshot was not downscaled below its source');
  await capture.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  const capturePending = await capture.evaluate(() => {
    const key = Object.keys(localStorage).find((item) =>
      item.startsWith('platform-development-intake-pending:v1:'));
    return key ? localStorage.getItem(key) : null;
  });
  assert.equal(capturePending, null,
    'an accepted receipt must release the immutable pending screenshot record');
  await capture.close();

  // 11. An attachment the device cannot decode fails in the intake's own typed
  // vocabulary — only a `development_intake_screenshot_invalid` failure renders
  // this exact text, every other failure renders «Не удалось сохранить задачу.».
  // Nothing reaches the durable API and the latched form is handed back intact.
  projectionItems = [];
  const undecodablePng = Buffer.concat([
    // The real header of the phone screenshot above (720×1280 parses), followed
    // by bytes that are not image data at all. It stays over the passthrough
    // budget so preparation actually has to decode it.
    phonePng.subarray(0, 33),
    Buffer.alloc(400_000, 0x5a),
  ]);
  assert.ok(undecodablePng.length > 370_000,
    'the undecodable fixture must exceed the screenshot passthrough budget');
  const undecodable = await newPage();
  const undecodableSession = awaitSession(undecodable);
  const undecodableProjection = undecodable.waitForResponse((response) =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/development-intake');
  await undecodable.goto(`${origin}/?browserCase=undecodable-screenshot`, { waitUntil: 'domcontentloaded' });
  await undecodableSession;
  await undecodableProjection;
  await undecodable.locator(openSelector).waitFor({ state: 'visible' });
  await undecodable.locator(openSelector).click();
  await undecodable.locator(`${formSelector} textarea[name="instruction"]`).fill(UNDECODABLE_INSTRUCTION);
  const undecodableInput = undecodable.locator(`${formSelector} input[name="screenshot"]`);
  const undecodableSelection = undecodable.locator(`${formSelector} [data-intake-screenshot]`);
  const undecodableRemove = undecodableSelection.locator('[data-action="remove-screenshot"]');
  await undecodableInput.setInputFiles({
    name: 'phone-screenshot.png', mimeType: 'image/png', buffer: undecodablePng,
  });
  await undecodableSelection.waitFor({ state: 'visible' });
  const postsBeforeUndecodable = postedRequests.length;
  await undecodable.locator(`${formSelector} button[type="submit"]`).click();
  await undecodable.waitForFunction(() => {
    const text = document.querySelector('.platform-development-intake output')?.textContent ?? '';
    return text !== '' && text !== 'Подготавливаю скриншот…';
  });
  assert.equal(await undecodable.locator(`${intakeSelector} output`).textContent(),
    'Не удалось обработать скриншот. Выберите другое изображение.',
    'an undecodable attachment did not surface the typed screenshot failure vocabulary');
  assert.equal(postedRequests.length, postsBeforeUndecodable,
    'an undecodable attachment reached the durable API');
  assert.equal(await undecodable.evaluate(() => Object.keys(localStorage).some((key) =>
    key.startsWith('platform-development-intake-pending:v1:'))), false,
  'a failed preparation left an immutable pending record behind');
  assert.equal(await undecodableInput.isDisabled(), false,
    'a failed preparation kept the file input latched');
  assert.equal(await undecodableRemove.isDisabled(), false,
    'a failed preparation kept «Удалить» latched');
  assert.equal(await undecodable.locator(`${formSelector} [data-action="dictate"]`).isDisabled(), false,
    'a failed preparation kept dictation latched');
  assert.equal(await undecodable.locator(`${formSelector} textarea[name="instruction"]`).isEditable(), true,
    'a failed preparation kept the instruction latched');
  assert.equal(await undecodable.locator(`${formSelector} button[type="submit"]`).isDisabled(), false,
    'a failed preparation kept submit latched');

  // The re-enabled form is usable in place: detaching the undecodable file and
  // submitting the same instruction needs no reload of the Mini App.
  await undecodableRemove.click();
  await undecodableSelection.waitFor({ state: 'hidden' });
  const recoveredPost = undecodable.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/development-intake'
      && response.ok());
  await undecodable.locator(`${formSelector} button[type="submit"]`).click();
  await recoveredPost;
  assert.equal(postedRequests.length, postsBeforeUndecodable + 1,
    'the recovered submit did not issue exactly one mutation');
  assert.equal(postedRequests[postsBeforeUndecodable].instruction, UNDECODABLE_INSTRUCTION);
  assert.deepEqual(postedRequests[postsBeforeUndecodable].screenshot, {
    kind: 'unavailable',
    reason: 'not_attached',
    mimeType: null,
    dataUrl: null,
  }, 'the recovered submit carried the undecodable attachment anyway');
  await undecodable.locator(`${openSelector}[data-intake-state="pending"]`).waitFor({ state: 'visible' });
  await undecodable.close();

  console.log('operator development intake browser: visible request/mutation/hash/replay/delivery receipt, result link, exact retry, prepared screenshot capture, submit latch, typed screenshot failure, and capability fences verified');
} finally {
  if (heldProjection) releaseHeldProjection();
  if (heldPost) releaseHeldPost();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
