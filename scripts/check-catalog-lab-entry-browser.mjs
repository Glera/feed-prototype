import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'catalog-lab-browser-'));
const labSelector = '.feed-bar__lab[aria-label="Catalog Lab access"]';
const authSelector = '.lab-auth[aria-label="Catalog Lab authorization"]';
const requestLog = [];
let origin = '';
let catalogLabAvailable = false;
let sessionRequests = 0;
let lookupRequests = 0;
let releaseDecision = null;
const decisionRequests = [];
const deviceDecisionRequests = [];
let omitMachineBinding = false;
const releaseId = '8b447be0-f961-482e-aa03-b419d5f1492d';
const playableId = 'solitaire-v1-swipe';
const candidatePath = `/playable-previews/${releaseId}/${playableId}.html`;
const candidateArtifactDigest = '9'.repeat(64);
const reviewBinding = {
  schema: 'feed.playable-release-review-binding.v1',
  releaseId,
  playableId,
  candidatePath,
  candidateArtifactDigest,
  review: {
    kind: 'rework',
    reworkRequestId: '9b447be0-f961-482e-aa03-b419d5f1492d',
    sourceId: null,
    sourceCommit: null,
  },
};
const reviewBindingBytes = Buffer.from(JSON.stringify(reviewBinding));
const reviewBindingDigest = createHash('sha256').update(reviewBindingBytes).digest('hex');

const artifactAuthorization = {
  authorizationId: '6b447be0-f961-482e-aa03-b419d5f1492d',
  clientName: 'Mechanic Lab raster-art publisher',
  clientInstanceId: '2435ba2d-34cb-4590-841d-7edbb52ba598',
  scopes: ['catalog:publish'],
  state: 'pending',
  expiresAt: '2026-07-21T19:30:00.000Z',
  decisionVersion: 0,
  promotionSummary: {
    schema: 'catalog.artifact-promotion-summary.v1',
    publishId: 'be126800-f72e-5479-8e07-55ec8118493b',
    requestHash: '8'.repeat(64),
    contentHash: '3'.repeat(64),
    reviewTargetId: 'merge-art-magical-bakery-feae1e153540-5f3c1f61ead8',
    title: 'Magical Bakery',
    description: 'A warm enchanted patisserie.',
    artPackHash: 'f'.repeat(64),
    runtimeArtifactDigest: `sha256:${'4'.repeat(64)}`,
    gameplayFingerprint: 'a'.repeat(64),
    presentationFingerprint: 'b'.repeat(64),
    reason: 'Human-good raster-art vertical.',
  },
};

const playableReleaseAuthorization = () => ({
  authorizationId: '7b447be0-f961-482e-aa03-b419d5f1492d',
  clientName: 'Mechanic Lab playable release',
  clientInstanceId: '3435ba2d-34cb-4590-841d-7edbb52ba598',
  scopes: ['feed.playable-release:write'],
  state: 'pending',
  expiresAt: '2026-08-06T19:30:00.000Z',
  decisionVersion: 0,
  promotionSummary: {
    schema: 'feed.playable-release-summary.v1',
    publishId: releaseId,
    requestHash: '1'.repeat(64),
    contentHash: '2'.repeat(64),
    mode: 'add',
    playableId,
    sourceCommit: '3'.repeat(40),
    previousRuntimeArtifactDigest: `sha256:${'4'.repeat(64)}`,
    runtimeArtifactDigest: `sha256:${'5'.repeat(64)}`,
    productionManifestDigest: '6'.repeat(64),
    coverDigests: { tall: '7'.repeat(64), compact: '8'.repeat(64) },
    candidateUrl: 'https://technical-proof.invalid/not-used-by-review.html',
    seriesLength: 1,
    catalogMechanic: 'solitaire/klondike',
    mechanicFamily: 'solitaire',
    rosterDiff: {
      addedPlayableId: playableId,
      afterPlayableId: 'minesweeper-v1-swipe',
      removedPlayableIds: [],
      reorderedExisting: false,
    },
    review: {
      kind: 'rework',
      reworkRequestId: reviewBinding.review.reworkRequestId,
      sourceId: null,
      sourceCommit: null,
      originalRequest: 'Показывать tutor hand до первого ручного хода и сохранить полную рамку.',
      submittedAt: '2026-08-10T12:30:00.000Z',
      actorUserId: 42,
      unavailable: false,
      candidatePath,
      candidateArtifactDigest,
      reviewBindingDigest,
      checklist: [
        'Проверить tutor hand в autoplay и его исчезновение после takeover.',
        'Проверить полную рамку относительно exact game slot.',
        'Проверить restart и terminal state.',
      ],
    },
    decision: releaseDecision,
  },
});

const desktopIntakeAuthorization = () => ({
  authorizationId: '4b447be0-f961-482e-aa03-b419d5f1492d',
  clientName: 'Codex desktop intake',
  clientInstanceId: '4435ba2d-34cb-4590-841d-7edbb52ba598',
  scopes: ['operator:flags:write'],
  state: 'pending',
  expiresAt: '2026-08-14T19:30:00.000Z',
  decisionVersion: 0,
});

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const sessionResponse = () => ({
  user: { id: 42, ref_code: 'browser-fixture' },
  ref_code: 'browser-fixture',
  balance: 0,
  puzzles: 0,
  is_new: false,
  backend_version: 'catalog-lab-browser-fixture',
  catalog_lab_authorization_available: catalogLabAvailable,
  builtin_feed_bindings: {
    schema: 'feed.builtin-bindings.v1',
    available: false,
    unavailable_reason: 'browser_fixture',
    by_playable_id: {},
  },
});

const fakePlayable = `<!doctype html><html><head><style>html,body,canvas{width:100%;height:100%;margin:0;background:#17325a}</style></head><body><canvas aria-label="candidate canvas"></canvas><script>
const id = location.pathname.split('/').pop().replace(/\\.html$/, '');
const send = (type, extra = {}) => parent.postMessage({ source: 'playable', id, type, ...extra }, '*');
const record = (type) => {
  const key = '__candidate_review_host_commands';
  const values = JSON.parse(parent.sessionStorage.getItem(key) || '[]');
  values.push(type);
  parent.sessionStorage.setItem(key, JSON.stringify(values));
};
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.target !== 'playable-swipe') return;
  record(event.data.type);
  if (event.data.type === 'prepareInteractive') send('interactive_ready');
});
document.querySelector('canvas').addEventListener('click', () => send('completed', { success: true }));
addEventListener('load', () => send('static_ready'));
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  requestLog.push(`${request.method} ${url.pathname}${url.search}`);

  if (request.method === 'POST' && url.pathname === '/api/session') {
    sessionRequests += 1;
    return json(response, sessionResponse());
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/lab-tokens') {
    return json(response, { tokens: [] });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/device-auth/lookup') {
    request.resume();
    lookupRequests += 1;
    const authorization = playableReleaseAuthorization();
    if (lookupRequests >= 3) authorization.promotionSummary.review.candidatePath = `/playable-previews/unsafe/${playableId}.html`;
    return json(response, lookupRequests === 1
      ? artifactAuthorization
      : lookupRequests >= 4 ? desktopIntakeAuthorization() : authorization);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/device-auth/decision') {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      deviceDecisionRequests.push(body);
      if (body.authorizationId !== desktopIntakeAuthorization().authorizationId
        || body.expectedDecisionVersion !== 0
        || !['56789-ABCDE', '6789A-BCDEF'].includes(body.userCode)) {
        return json(response, { code: 'device_authorization_fixture_mismatch' }, 409);
      }
      const authorization = desktopIntakeAuthorization();
      authorization.state = body.decision === 'approve' ? 'approved' : 'denied';
      authorization.decisionVersion = 1;
      if (body.decision === 'approve' && body.submitterMachine && !omitMachineBinding) {
        authorization.submitterMachine = body.submitterMachine;
      }
      return json(response, authorization);
    });
    return;
  }
  if (request.method === 'GET'
    && url.pathname === `/api/operator/playable-releases/${releaseId}/review`) {
    return json(response, playableReleaseAuthorization().promotionSummary);
  }
  if (request.method === 'POST'
    && url.pathname === `/api/operator/playable-releases/${releaseId}/decision`) {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      decisionRequests.push(body);
      if (releaseDecision && (releaseDecision.decision !== body.decision
        || releaseDecision.instruction !== (body.instruction ?? null))) {
        return json(response, { code: 'playable_rework_conflict' }, 409);
      }
      if (!releaseDecision) {
        releaseDecision = {
          schema: 'feed.playable-release-decision.receipt.v1',
          decisionSchema: 'feed.playable-release-decision.v1',
          decisionId: '1b447be0-f961-482e-aa03-b419d5f1492d',
          mutationId: body.mutationId,
          releaseId,
          actorUserId: 42,
          reviewBindingDigest,
          candidateArtifactDigest,
          decision: body.decision,
          instruction: body.instruction ?? null,
          audience: 'exact-user',
          publicRollout: false,
          authorization: {
            schema: 'feed.playable-release-authorization-disposition.v1',
            state: body.decision === 'accept' ? 'approved' : 'fenced',
            itemCount: 0,
            itemsDigest: '0'.repeat(64),
            items: [],
          },
          successor: body.decision === 'rework' ? {
            requestId: '2b447be0-f961-482e-aa03-b419d5f1492d',
            parentReleaseId: releaseId,
            predecessorRequestId: reviewBinding.review.reworkRequestId,
            cycle: 2,
          } : null,
          decidedAt: '2026-08-10T17:30:00.000Z',
          receiptDigest: 'd'.repeat(64),
          replayed: false,
        };
      }
      return json(response, { ...releaseDecision, replayed: decisionRequests.length > 1 });
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/challenges') {
    return json(response, { box: 'in', items: [] });
  }
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    return json(response, { detail: 'not configured in browser fixture' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/api/events') {
    return json(response, { ok: true }, 202);
  }
  if (url.pathname === '/versions.json') return json(response, {});
  if (url.pathname === `/playable-previews/${releaseId}/review-binding.json`) {
    response.setHeader('content-type', 'application/json');
    response.end(reviewBindingBytes);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
    return;
  }
  if (url.pathname === candidatePath) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fakePlayable);
    return;
  }
  if (url.pathname.endsWith('.payload.js')) {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end('');
    return;
  }
  if (url.pathname.startsWith('/api/')) return json(response, {}, 404);
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

// Use an isolated output directory. Several repository checks build this
// single-file app, and sharing dist/ would let concurrent checks serve a file
// while another Vite process is replacing it.
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
  },
  timeout: 120_000,
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
    close() {
      const key = '__catalog_lab_browser_close_calls';
      sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
    },
  },
};`;

let browser = null;
try {
  browser = await chromium.launch();
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: telegramSdkFixture,
    }));
    return page;
  };

  // A server capability is necessary: an authenticated but ineligible account
  // must not receive a usable Catalog Lab entry point.
  catalogLabAvailable = false;
  const disabledPage = await newPage();
  const disabledSession = disabledPage.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/session');
  await disabledPage.goto(`${origin}/?browserCase=capability-false`, { waitUntil: 'domcontentloaded' });
  await disabledSession;
  await disabledPage.locator(labSelector).waitFor({ state: 'attached' });
  assert.equal(await disabledPage.locator(labSelector).count(), 1, 'the stable Lab slot is missing');
  assert.equal(await disabledPage.locator(labSelector).isHidden(), true,
    'capability=false exposed the Catalog Lab entry');
  assert.equal(await disabledPage.locator(authSelector).count(), 0,
    'capability=false mounted the focused authorization surface');
  await disabledPage.locator('iframe').first().waitFor({ state: 'attached' });
  await disabledPage.close();

  // The exact allowlisted capability reveals the entry. It starts hidden, so
  // this also proves that the asynchronous /session response owns the reveal.
  catalogLabAvailable = true;
  const enabledPage = await newPage();
  const firstEnabledSession = enabledPage.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/session');
  await enabledPage.goto(`${origin}/?browserCase=capability-true&keep=1`, { waitUntil: 'domcontentloaded' });
  await firstEnabledSession;
  await enabledPage.locator(labSelector).waitFor({ state: 'visible' });
  assert.equal(await enabledPage.locator(labSelector).getAttribute('aria-label'), 'Catalog Lab access');
  assert.match((await enabledPage.locator(labSelector).textContent()) || '', /LAB/);
  await enabledPage.locator('iframe').first().waitFor({ state: 'attached' });
  await enabledPage.waitForFunction(() => !document.querySelector('.preloader'));

  const sessionsBeforeLab = sessionRequests;
  const requestsBeforeLab = requestLog.length;
  await Promise.all([
    enabledPage.waitForURL((url) => url.searchParams.get('labAuth') === '1'),
    enabledPage.locator(labSelector).click(),
  ]);
  await enabledPage.locator(authSelector).waitFor({ state: 'visible' });

  const labUrl = new URL(enabledPage.url());
  assert.equal(labUrl.searchParams.get('browserCase'), 'capability-true',
    'Catalog Lab navigation discarded an existing query parameter');
  assert.equal(labUrl.searchParams.get('keep'), '1',
    'Catalog Lab navigation discarded an unrelated query parameter');
  assert.equal(labUrl.searchParams.get('labAuth'), '1');
  assert.equal(await enabledPage.locator('iframe').count(), 0,
    'focused Catalog Lab launch mounted a playable iframe');
  assert.equal(await enabledPage.locator('#viewport').isHidden(), true,
    'focused Catalog Lab launch left the game viewport visible');
  assert.equal(await enabledPage.locator('.feed-bar').count(), 0,
    'focused Catalog Lab launch booted the normal feed underneath');
  await enabledPage.waitForTimeout(150);
  assert.equal(sessionRequests, sessionsBeforeLab,
    'focused Catalog Lab launch called /api/session and booted the feed');
  const labNavigationRequests = requestLog.slice(requestsBeforeLab);
  assert.equal(labNavigationRequests.some((entry) => entry.includes('/versions.json')), false,
    `focused Catalog Lab launch fetched feed versions: ${labNavigationRequests.join(', ')}`);
  assert.equal(labNavigationRequests.some((entry) => /\/(?:[^/?]+)\.html(?:\?|$)/.test(entry)), false,
    `focused Catalog Lab launch fetched a playable: ${labNavigationRequests.join(', ')}`);

  // A generic raster-art promotion has its own exact summary shape. The TMA
  // must render it rather than treating it as a legacy ordered level series.
  await enabledPage.getByLabel('One-time code').fill('23456-789AB');
  await enabledPage.getByRole('button', { name: 'Review request' }).click();
  await enabledPage.locator('[data-testid="catalog-promotion-summary"]').waitFor({ state: 'visible' });
  const artifactSummary = enabledPage.locator('[data-testid="catalog-promotion-summary"]');
  assert.match((await artifactSummary.textContent()) || '', /Exact raster-art world/);
  assert.match((await artifactSummary.textContent()) || '', /Magical Bakery/);
  assert.match((await artifactSummary.textContent()) || '', new RegExp(`sha256:${'4'.repeat(64)}`));
  assert.match((await artifactSummary.textContent()) || '', new RegExp('f'.repeat(64)));
  assert.equal(await enabledPage.getByRole('button', { name: 'Approve exact raster world' }).count(), 1);
  assert.equal(await enabledPage.getByTestId('catalog-lab-submitter-machine').isHidden(), true,
    'ordinary publication approval exposed a desktop machine binding');
  await enabledPage.getByRole('button', { name: 'Use another code' }).click();

  await enabledPage.getByLabel('One-time code').fill('34567-89ABC');
  const requestsBeforeCandidate = requestLog.length;
  await enabledPage.getByRole('button', { name: 'Review request' }).click();
  const releaseSummary = enabledPage.locator('[data-testid="catalog-promotion-summary"]');
  await releaseSummary.waitFor({ state: 'visible' });
  assert.match((await releaseSummary.textContent()) || '', /Exact playable release/);
  assert.match((await releaseSummary.textContent()) || '', /solitaire-v1-swipe/);
  assert.match((await releaseSummary.textContent()) || '', /Добавить solitaire-v1-swipe после minesweeper-v1-swipe/);
  assert.match((await releaseSummary.textContent()) || '', /Без удалений и перестановок/);
  assert.match((await releaseSummary.textContent()) || '', new RegExp(`sha256:${'5'.repeat(64)}`));
  assert.match((await releaseSummary.textContent()) || '', /Показывать tutor hand до первого ручного хода и сохранить полную рамку\./);
  assert.match((await releaseSummary.textContent()) || '', /Что проверить/);
  assert.match((await releaseSummary.textContent()) || '', /Проверить tutor hand в autoplay/);
  const approval = enabledPage.getByRole('button', { name: 'Принять и опубликовать' });
  assert.equal(await approval.count(), 1);
  const review = enabledPage.locator('[data-testid="playable-candidate-review"]');
  await review.waitFor({ state: 'visible' });
  const candidateFrame = review.locator('iframe');
  await candidateFrame.waitFor({ state: 'attached' });
  await enabledPage.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="playable-candidate-review"] iframe');
    return frame?.getAttribute('src')?.includes('auto=1');
  });
  const candidateFrameUrl = new URL((await candidateFrame.getAttribute('src')) || '');
  assert.equal(candidateFrameUrl.origin, origin);
  assert.equal(candidateFrameUrl.pathname, candidatePath);
  assert.equal(candidateFrameUrl.searchParams.get('auto'), '1');
  assert.equal(candidateFrameUrl.searchParams.get('reviewBinding'), reviewBindingDigest);
  const feedPreview = review.getByRole('button', { name: 'Проверить в реальной ленте' });
  assert.equal(await feedPreview.count(), 1);
  assert.equal(await feedPreview.isDisabled(), false,
    'real-feed candidate proof remained unavailable after exact binding verification');
  await enabledPage.waitForFunction(() => {
    const commands = JSON.parse(sessionStorage.getItem('__candidate_review_host_commands') || '[]');
    return ['setHostPaused', 'prepareInteractive', 'startAutoPlay'].every((type) => commands.includes(type));
  });
  assert.equal(await approval.isDisabled(), true,
    'approval became available before a real manual takeover');
  await enabledPage.evaluate(() => window.postMessage({
    source: 'playable', type: 'completed', success: true,
  }, '*'));
  assert.equal(await review.getAttribute('data-state'), 'autoplay',
    'top-window spoof was accepted as a candidate host message');

  const mobileSlot = await review.locator('[data-testid="candidate-game-slot"]').boundingBox();
  assert.ok(mobileSlot && Math.abs((mobileSlot.width / mobileSlot.height) - (9 / 16)) < 0.02,
    `mobile candidate slot is not 9:16: ${JSON.stringify(mobileSlot)}`);
  await enabledPage.setViewportSize({ width: 1024, height: 900 });
  const desktopSlot = await review.locator('[data-testid="candidate-game-slot"]').boundingBox();
  assert.ok(desktopSlot && Math.abs((desktopSlot.width / desktopSlot.height) - (9 / 16)) < 0.02,
    `desktop candidate slot is not 9:16: ${JSON.stringify(desktopSlot)}`);
  assert.ok(desktopSlot && desktopSlot.height <= 0.69 * 900,
    'desktop candidate escaped the responsive platform slot height');
  await enabledPage.setViewportSize({ width: 390, height: 760 });

  await review.getByRole('button', { name: 'Коснитесь, чтобы играть вручную' }).click();
  await enabledPage.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="playable-candidate-review"] iframe');
    return frame?.getAttribute('src')?.includes('auto=0');
  });
  await enabledPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent === 'Принять и опубликовать');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  assert.equal(await review.getAttribute('data-state'), 'manual');
  await candidateFrame.contentFrame().getByLabel('candidate canvas').click({ position: { x: 20, y: 20 } });
  await enabledPage.getByText('Candidate завершён: победа. Можно перезапустить.').waitFor({ state: 'visible' });
  assert.equal(await review.getAttribute('data-state'), 'terminal');
  const manualLoadsBeforeRestart = requestLog.filter((entry) =>
    entry.startsWith(`GET ${candidatePath}?`) && entry.includes('auto=0')).length;
  await review.getByRole('button', { name: 'Перезапустить candidate' }).click();
  await enabledPage.waitForFunction((expected) => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/playable-previews/') && entry.name.includes('auto=0')).length >= expected,
  manualLoadsBeforeRestart + 1);
  const candidateRequests = requestLog.slice(requestsBeforeCandidate);
  assert.equal(candidateRequests.some((entry) => entry.includes('/versions.json')), false,
    `candidate review fetched live versions: ${candidateRequests.join(', ')}`);
  assert.equal(candidateRequests.some((entry) => entry.includes('/api/session')), false,
    `candidate review booted the feed session: ${candidateRequests.join(', ')}`);
  await enabledPage.getByRole('button', { name: 'Use another code' }).click();

  await enabledPage.getByLabel('One-time code').fill('45678-9ABCD');
  await enabledPage.getByRole('button', { name: 'Review request' }).click();
  await enabledPage.locator('[data-testid="catalog-promotion-summary"]').waitFor({ state: 'visible' });
  assert.equal(await enabledPage.locator('[data-testid="playable-candidate-review"] iframe').getAttribute('src'), null);
  assert.equal(await enabledPage.getByText('Исходная задача недоступна. Candidate review и публикация заблокированы.').count(), 1);
  assert.equal(await enabledPage.getByRole('button', { name: 'Принять и опубликовать' }).isDisabled(), true);
  await enabledPage.getByRole('button', { name: 'Use another code' }).click();

  // Desktop intake is the one scope which requires an operator-selected,
  // server-owned machine binding. Client names and one-time codes never infer it.
  await enabledPage.getByLabel('One-time code').fill('56789-ABCDE');
  await enabledPage.getByRole('button', { name: 'Review request' }).click();
  const machineSelector = enabledPage.getByTestId('catalog-lab-submitter-machine');
  await machineSelector.waitFor({ state: 'visible' });
  assert.match((await machineSelector.textContent()) || '', /computer name and one-time code never decide/i);
  const machineApprove = enabledPage.getByRole('button', { name: 'Approve', exact: true });
  assert.equal(await machineApprove.isDisabled(), true,
    'desktop intake approval was enabled before explicit machine selection');
  await machineApprove.evaluate((entry) => { entry.disabled = false; entry.click(); });
  assert.equal(deviceDecisionRequests.length, 0,
    'network-level guard allowed desktop approval without a selected machine');
  assert.match((await enabledPage.locator('.lab-auth__status').filter({ hasText: /Choose Mac A/ }).textContent()) || '', /Choose Mac A/);
  await enabledPage.getByLabel('Mac A — Platform').check();
  assert.equal(await machineApprove.isDisabled(), false);
  omitMachineBinding = true;
  enabledPage.once('dialog', (dialog) => dialog.accept());
  await machineApprove.click();
  await enabledPage.getByText(/server did not confirm this Mac binding/).waitFor({ state: 'visible' });
  assert.equal(deviceDecisionRequests.length, 1,
    'unconfirmed binding did not make exactly one fail-closed request');
  assert.equal(await machineApprove.isDisabled(), false,
    'operator could not retry after an unconfirmed server binding');
  omitMachineBinding = false;
  enabledPage.once('dialog', (dialog) => dialog.accept());
  await machineApprove.click();
  await enabledPage.getByText(/is bound to Mac A — Platform/).waitFor({ state: 'visible' });
  assert.equal(deviceDecisionRequests.length, 2);
  assert.deepEqual(deviceDecisionRequests[1], {
    authorizationId: desktopIntakeAuthorization().authorizationId,
    userCode: '56789-ABCDE',
    expectedDecisionVersion: 0,
    decision: 'approve',
    submitterMachine: 'mac-a',
  });

  // Denial remains identity-neutral and cannot bind either machine.
  await enabledPage.getByRole('button', { name: 'Check another code' }).click();
  await enabledPage.getByLabel('One-time code').fill('6789A-BCDEF');
  await enabledPage.getByRole('button', { name: 'Review request' }).click();
  await enabledPage.getByTestId('catalog-lab-submitter-machine').waitFor({ state: 'visible' });
  await enabledPage.getByLabel('Mac B — Content / Labs').check();
  enabledPage.once('dialog', (dialog) => dialog.accept());
  await enabledPage.getByRole('button', { name: 'Deny', exact: true }).click();
  await enabledPage.getByText('Request denied').waitFor({ state: 'visible' });
  assert.equal(deviceDecisionRequests.length, 3);
  assert.deepEqual(deviceDecisionRequests[2], {
    authorizationId: desktopIntakeAuthorization().authorizationId,
    userCode: '6789A-BCDEF',
    expectedDecisionVersion: 0,
    decision: 'deny',
  });

  // READY Telegram deep-link resolves only the requested server-owned release.
  // It owns the two safe product outcomes and never boots the normal feed.
  const directPage = await newPage();
  await directPage.setViewportSize({ width: 390, height: 844 });
  const directRequestsStart = requestLog.length;
  await directPage.goto(`${origin}/?tgWebAppStartParam=pr_${releaseId}`, { waitUntil: 'domcontentloaded' });
  const directSurface = directPage.locator('[aria-label="Playable candidate review"]');
  await directSurface.waitFor({ state: 'visible' });
  await directSurface.locator('[data-testid="playable-candidate-review"] iframe').waitFor({ state: 'attached' });
  await directPage.waitForFunction(() => document.querySelector(
    '[data-testid="playable-candidate-review"] iframe',
  )?.getAttribute('src')?.includes('auto=1'));
  assert.match((await directSurface.textContent()) || '', /Показывать tutor hand до первого ручного хода/);
  const directAccept = directSurface.getByRole('button', { name: 'Принять в тестовую ленту' });
  const directRework = directSurface.getByRole('button', { name: 'Отправить на доработку' });
  assert.equal(await directAccept.count(), 1);
  assert.equal(await directRework.count(), 1);
  assert.equal(await directSurface.getByRole('button', { name: 'Принять и опубликовать' }).count(), 0);
  const directSlot = await directSurface.locator('[data-testid="candidate-game-slot"]').boundingBox();
  assert.ok(directSlot && Math.abs((directSlot.width / directSlot.height) - (9 / 16)) < 0.02,
    `390x844 READY candidate slot is not platform 9:16: ${JSON.stringify(directSlot)}`);
  await directSurface.getByRole('button', { name: 'Коснитесь, чтобы играть вручную' }).click();
  await directPage.waitForFunction(() => document.querySelector(
    '[data-testid="playable-candidate-review"] iframe',
  )?.getAttribute('src')?.includes('auto=0'));
  await directRework.click();
  const reworkInput = directSurface.getByLabel('Что именно доработать');
  await reworkInput.waitFor({ state: 'visible' });
  const dictation = directSurface.getByRole('button', { name: 'Диктовать системной клавиатурой' });
  await dictation.click();
  assert.equal(await reworkInput.evaluate((entry) => entry === document.activeElement), true,
    'system dictation action did not focus the text input');
  await directSurface.getByRole('button', { name: 'Отменить ввод' }).click();
  assert.equal(await reworkInput.isHidden(), true,
    'closing an uncommitted rework form must restore the mutually exclusive accept outcome');
  assert.equal(await directAccept.isDisabled(), false);
  await directRework.click();
  await reworkInput.waitFor({ state: 'visible' });
  const instruction = 'Оставить только текущий уровень 5 в runtime; сохранить factory-ready шаблон.';
  await reworkInput.fill(instruction);
  await directRework.click();
  await directSurface.getByText('Отправлено на доработку. Successor cycle 2 создан; production не изменён.')
    .waitFor({ state: 'visible' });
  assert.equal(decisionRequests.length, 1, 'one rework tap created more than one decision request');
  assert.deepEqual(Object.keys(decisionRequests[0]).sort(),
    ['decision', 'instruction', 'mutationId', 'schema']);
  assert.equal(decisionRequests[0].decision, 'rework');
  assert.equal(decisionRequests[0].instruction, instruction);
  assert.equal(await directAccept.isDisabled(), true);
  assert.equal(await directRework.isDisabled(), true);
  await directRework.evaluate((button) => button.click());
  assert.equal(decisionRequests.length, 1, 'disabled terminal rework replayed in the browser');
  assert.equal(await directPage.locator('.feed-bar').count(), 0);
  assert.equal(await directPage.locator('#viewport').isHidden(), true);
  const directRequests = requestLog.slice(directRequestsStart);
  assert.equal(directRequests.some((entry) => entry.includes('/versions.json')), false,
    `READY review deep-link fetched versions: ${directRequests.join(', ')}`);
  assert.equal(directRequests.some((entry) => entry.includes('/api/session')), false,
    `READY review deep-link booted session: ${directRequests.join(', ')}`);
  assert.equal(directRequests.some((entry) => entry.includes(`/api/operator/playable-releases/${releaseId}/review`)), true);
  await directPage.close();

  // The mutually exclusive accept outcome uses the same release-only contract
  // and remains exact-user/dogfood rather than a public publication action.
  releaseDecision = null;
  decisionRequests.length = 0;
  const acceptPage = await newPage();
  await acceptPage.setViewportSize({ width: 390, height: 844 });
  await acceptPage.goto(`${origin}/?tgWebAppStartParam=pr_${releaseId}`, { waitUntil: 'domcontentloaded' });
  const acceptSurface = acceptPage.locator('[aria-label="Playable candidate review"]');
  await acceptPage.waitForFunction(() => document.querySelector(
    '[data-testid="playable-candidate-review"] iframe',
  )?.getAttribute('src')?.includes('auto=1'));
  await acceptSurface.getByRole('button', { name: 'Коснитесь, чтобы играть вручную' }).click();
  await acceptPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent === 'Принять в тестовую ленту');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await acceptSurface.getByRole('button', { name: 'Принять в тестовую ленту' }).click();
  await acceptSurface.getByText(/Кандидат принят в dev-ленту\. Дополнительный код не требуется/)
    .waitFor({ state: 'visible' });
  assert.equal(decisionRequests.length, 1, 'accept created more than one decision request');
  assert.deepEqual(Object.keys(decisionRequests[0]).sort(), ['decision', 'mutationId', 'schema']);
  assert.equal(decisionRequests[0].decision, 'accept');
  assert.match((await acceptSurface.textContent()) || '', /public rollout не выполнялся/);
  assert.equal(await acceptSurface.getByRole('button', { name: 'Принять в тестовую ленту' }).isDisabled(), true);
  assert.equal(await acceptSurface.getByRole('button', { name: 'Отправить на доработку' }).isDisabled(), true);
  await acceptPage.close();
  releaseDecision = null;
  decisionRequests.length = 0;

  // The desktop Lab uses the same narrow release-id-only route. It must not
  // accept a caller-authored candidate URL or fall through to normal feed boot.
  const labLinkPage = await newPage();
  const labLinkRequestsStart = requestLog.length;
  await labLinkPage.goto(`${origin}/?candidateReview=${releaseId}`, { waitUntil: 'domcontentloaded' });
  await labLinkPage.locator('[aria-label="Playable candidate review"]').waitFor({ state: 'visible' });
  await labLinkPage.locator('[data-testid="playable-candidate-review"] iframe').waitFor({ state: 'attached' });
  const labLinkRequests = requestLog.slice(labLinkRequestsStart);
  assert.equal(labLinkRequests.some((entry) => entry.includes('/versions.json')), false,
    `Lab review link fetched versions: ${labLinkRequests.join(', ')}`);
  assert.equal(labLinkRequests.some((entry) => entry.includes('/api/session')), false,
    `Lab review link booted session: ${labLinkRequests.join(', ')}`);
  await labLinkPage.close();

  const feedLinkPage = await newPage();
  await feedLinkPage.goto(`${origin}/?candidateReview=${releaseId}&keep=1`, { waitUntil: 'domcontentloaded' });
  const feedLink = feedLinkPage.getByRole('button', { name: 'Проверить в реальной ленте' });
  await feedLink.waitFor({ state: 'visible' });
  await feedLinkPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent === 'Проверить в реальной ленте');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await feedLink.click();
  await feedLinkPage.waitForURL((url) => url.searchParams.has('candidateFeedRelease'));
  const feedLinkUrl = new URL(feedLinkPage.url());
  assert.equal(feedLinkUrl.origin, origin);
  assert.equal(feedLinkUrl.searchParams.get('candidateFeedRelease'), releaseId);
  assert.equal(feedLinkUrl.searchParams.get('candidateFeedPlayable'), playableId);
  assert.equal(feedLinkUrl.searchParams.get('candidateFeedArtifact'), candidateArtifactDigest);
  assert.equal(feedLinkUrl.searchParams.get('candidateFeedBinding'), reviewBindingDigest);
  assert.equal(feedLinkUrl.searchParams.get('keep'), '1');
  assert.equal(feedLinkUrl.searchParams.has('candidateReview'), false);
  assert.equal(feedLinkUrl.searchParams.has('base'), false);
  await feedLinkPage.close();

  const returnSession = enabledPage.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/session');
  await Promise.all([
    enabledPage.waitForURL((url) => !url.searchParams.has('labAuth')),
    enabledPage.locator(`${authSelector} .lab-auth__close`).click(),
  ]);
  await returnSession;
  await enabledPage.locator('iframe').first().waitFor({ state: 'attached' });
  await enabledPage.locator(labSelector).waitFor({ state: 'visible' });

  const returnedUrl = new URL(enabledPage.url());
  assert.equal(returnedUrl.searchParams.has('labAuth'), false);
  assert.equal(returnedUrl.searchParams.get('browserCase'), 'capability-true');
  assert.equal(returnedUrl.searchParams.get('keep'), '1');
  assert.equal(await enabledPage.locator(authSelector).count(), 0,
    'Close left the Catalog Lab surface mounted');
  assert.equal(await enabledPage.locator('#viewport').isVisible(), true,
    'Close did not restore the normal game viewport');
  assert.equal(await enabledPage.evaluate(() =>
    Number(sessionStorage.getItem('__catalog_lab_browser_close_calls') || 0)), 0,
  'query-entry Close called Telegram.close instead of returning to the game');

  console.log('catalog lab entry browser: capability gate, isolated launch, and Close return verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
