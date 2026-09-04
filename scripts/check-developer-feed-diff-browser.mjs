/**
 * Browser contract for «Изменения dev-ленты» and its exact direct-public
 * confirmation (selective promotion v1).
 *
 * Two passes:
 *  A. The real production build against a fake backend — the badge exists only
 *     for an operator-capable session, tapping it opens the sheet, and every
 *     row is a server-owned projection.  Ineligible rows have no mutation;
 *     one exact prepared candidate exposes the content-bound publication flow.
 *  B. The module served as its own ES graph — destroy() must drop every
 *     listener it added, including the document-level Escape handler.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'developer-feed-diff-browser-'));
const BUILD_SHA = 'b7c1d4e9a2f60358b1cc4d7e0a91f2635d8e4b07';
const PLATFORM_VERSION = `2026-08-18 13:59 · ${BUILD_SHA.slice(0, 7)}`;
const MODULE_PATH = /^\/[a-z0-9-]+\.mjs$/;
// Screenshots are opt-in so CI stays byte-clean; the operator proof run points
// this at a scratch directory.
const screenshotDir = process.env.DEV_DIFF_SCREENSHOT_DIR || '';
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

const badgeSelector = '[data-testid="developer-feed-badge"]';
const sheetSelector = '[data-testid="dev-diff-sheet"]';
const rowSelector = '[data-testid="dev-diff-row"]';

let origin = '';
let operatorLevelFlaggingAvailable = false;
let developmentIntakeAvailable = false;
let developerFeedCatalog = null;
let reworkItems = [];
let intakeItems = [];
const reworkListRequests = [];
const promotionPrepareRequests = [];
const promotionApplyRequests = [];
let failNextPostPromotionSession = false;

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const readJson = async (request) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw);
};

const sessionResponse = () => ({
  user: { id: 42, ref_code: 'dev-diff-fixture' },
  ref_code: 'dev-diff-fixture',
  balance: 0,
  puzzles: 0,
  is_new: false,
  backend_version: 'dev-diff-fixture',
  catalog_lab_authorization_available: false,
  operator_level_flagging_available: operatorLevelFlaggingAvailable,
  development_intake_available: developmentIntakeAvailable,
  ...(developmentIntakeAvailable
    ? { development_intake_context: { contract: 'platform.development-intake.request.v1' } }
    : {}),
  builtin_feed_bindings: {
    schema: 'feed.builtin-bindings.v1',
    available: false,
    unavailable_reason: 'browser_fixture',
    by_playable_id: {},
  },
  ...(developerFeedCatalog ? { developerFeedCatalog: structuredClone(developerFeedCatalog) } : {}),
});

const catalogEntry = ({ entryId, state, stateVersion, seriesId, runtime = undefined }) => ({
  entryId,
  kind: 'series',
  state,
  stateVersion,
  seriesId,
  levelSpecHash: null,
  runtime: runtime === undefined ? {
    releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    playableId: 'marble-sort-swipe',
    runtimeArtifactDigest: `sha256:${'a'.repeat(64)}`,
    sourceCommit: 'b'.repeat(40),
  } : runtime,
  stateChangedAt: '2026-08-27T12:00:00Z',
});

const catalogDiff = ({ dev = null, publicEntry = null } = {}) => ({
  schema: 'feed.developer-catalog-diff.v1',
  mechanic: 'sort',
  variant: 'base',
  available: dev !== null || publicEntry !== null,
  unavailableReason: dev !== null || publicEntry !== null ? null : 'catalog_entry_unavailable',
  dev,
  public: publicEntry,
});

const reworkItem = ({
  requestId,
  playableId,
  instruction,
  releaseExecution = undefined,
  execution = undefined,
  operatorPresentation = undefined,
  queueDisposition = 'active_batch',
  queueCounts = { active: 1, queued: 0 },
  createdAt = '2026-08-18T09:00:00.000Z',
}) => ({
  schema: 'feed.playable-rework.v1',
  requestId,
  actorUserId: 42,
  requestHash: 'c'.repeat(64),
  state: 'claimed',
  sourceAdapter: 'telegram',
  queueDisposition,
  batchPresent: true,
  queueCounts,
  releaseId: null,
  claimedAt: createdAt,
  closedAt: null,
  closeReceiptDigest: null,
  ...(execution ? { execution } : {}),
  ...(operatorPresentation ? { operatorPresentation } : {}),
  ...(releaseExecution ? { releaseExecution } : {}),
  createdAt,
  request: {
    schema: 'feed.playable-rework.request.v1',
    mutationId: requestId,
    playableId,
    mappingId: '11111111-1111-5111-8111-111111111111',
    rosterActivationId: '22222222-2222-5222-8222-222222222222',
    runtime: {
      version: 'fixture-v1',
      artifactDigest: `sha256:${'3'.repeat(64)}`,
      sourceCommit: '4'.repeat(40),
    },
    context: {
      feedPosition: 6,
      level: null,
      runId: null,
      capturedAt: createdAt,
      screenshot: { kind: 'unavailable', reason: null, mimeType: null, dataUrl: null },
    },
    instruction,
  },
});

const intakeReceipt = () => ({
  schema: 'platform.development-intake.response.v1',
  requestId: '33333333-3333-5333-8333-333333333333',
  mutationId: '44444444-4444-5444-8444-444444444444',
  requestHash: 'e'.repeat(64),
  delivery: {
    deliveryId: '55555555-5555-5555-8555-555555555555',
    status: 'confirmed',
    issueUrl: 'https://github.com/Glera/p4g-workspace-meta/issues/118',
    nothingPublished: true,
  },
  terminal: null,
  request: {
    schema: 'platform.development-intake.request.v1',
    mutationId: '44444444-4444-5444-8444-444444444444',
    instruction: 'Сделать подпись версии заметнее.',
    surface: 'feed',
    route: '/',
    buildSha: BUILD_SHA,
    capturedAt: '2026-08-18T09:05:00.000Z',
    screenshot: { kind: 'unavailable', reason: 'not_captured', mimeType: null, dataUrl: null },
  },
  replayed: false,
  createdAt: '2026-08-18T09:05:01.000Z',
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

// Part B fixture: the module's own ES graph, plus a listener ledger installed
// BEFORE the mount so a leaked document handler is provable, not assumed.
const moduleFixture = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head>
<body><script type="module">
window.documentListeners = new Map();
const add = document.addEventListener.bind(document);
const remove = document.removeEventListener.bind(document);
document.addEventListener = (type, handler, options) => {
  window.documentListeners.set(type, (window.documentListeners.get(type) || 0) + 1);
  return add(type, handler, options);
};
document.removeEventListener = (type, handler, options) => {
  window.documentListeners.set(type, (window.documentListeners.get(type) || 0) - 1);
  return remove(type, handler, options);
};
const { mountDeveloperFeedDiffSurface, developerFeedDiffModel,
  validateDeveloperFeedCatalogDiff, validateCatalogDirectPromotionPrepared,
  validateCatalogDirectPromotionResult, validatePlayablePublicationPrepared,
  validatePlayablePublicationRequested } =
  await import('/developer-feed-diff.mjs');
window.developerFeedDiffModel = developerFeedDiffModel;
window.mountDeveloperFeedDiffSurface = mountDeveloperFeedDiffSurface;
window.validateDeveloperFeedCatalogDiff = validateDeveloperFeedCatalogDiff;
window.validateCatalogDirectPromotionPrepared = validateCatalogDirectPromotionPrepared;
window.validateCatalogDirectPromotionResult = validateCatalogDirectPromotionResult;
window.validatePlayablePublicationPrepared = validatePlayablePublicationPrepared;
window.validatePlayablePublicationRequested = validatePlayablePublicationRequested;
window.shown = [];
window.surface = mountDeveloperFeedDiffSurface(document.body, {
  input: {
    operatorSurfacesActive: true,
    platform: { sourceSha: '${BUILD_SHA}', stamp: '${PLATFORM_VERSION}' },
    reworks: [],
    platformIntake: null,
    adoption: null,
    catalog: null,
  },
  onShowMechanic: (playableId) => window.shown.push(playableId),
});
window.ready = true;
</script></body></html>`;

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/api/session') {
      request.resume();
      if (failNextPostPromotionSession) {
        failNextPostPromotionSession = false;
        return json(response, { code: 'fixture_session_refresh_failed' }, 503);
      }
      return json(response, sessionResponse());
    }
    if (request.method === 'POST'
      && url.pathname === '/api/catalog/operator-promotion/prepare') {
      void readJson(request).then((body) => {
        promotionPrepareRequests.push(body);
        const candidate = developerFeedCatalog?.dev;
        if (!candidate || body.entryId !== candidate.entryId
          || body.expectedStateVersion !== candidate.stateVersion) {
          return json(response, { code: 'catalog_state_conflict' }, 409);
        }
        return json(response, {
          schema: 'catalog.direct-promotion.prepared.v1',
          operationId: body.operationId,
          action: 'publish',
          entryId: candidate.entryId,
          expectedStateVersion: candidate.stateVersion,
          fromState: 'candidate',
          toState: 'published',
          fromAudience: 'exactUser',
          toAudience: 'public',
          runtimeArtifactDigest: candidate.runtime.runtimeArtifactDigest,
          confirmationCode: 'ABC123',
        });
      }).catch((error) => json(response, { detail: String(error) }, 500));
      return;
    }
    if (request.method === 'POST'
      && url.pathname === '/api/catalog/operator-promotion/apply') {
      void readJson(request).then((body) => {
        promotionApplyRequests.push(body);
        const candidate = developerFeedCatalog?.dev;
        if (!candidate || body.confirmationCode !== 'ABC123') {
          return json(response, { code: 'promotion_confirmation_code_mismatch' }, 409);
        }
        developerFeedCatalog = catalogDiff({
          publicEntry: {
            ...candidate,
            state: 'published',
            stateVersion: candidate.stateVersion + 1,
            stateChangedAt: '2026-08-30T12:01:00Z',
          },
        });
        failNextPostPromotionSession = true;
        return json(response, {
          schema: 'catalog.direct-promotion.result.v1',
          operationId: body.operationId,
          entryId: candidate.entryId,
          fromState: 'candidate',
          toState: 'published',
          stateVersion: candidate.stateVersion + 1,
          replayed: false,
        });
      }).catch((error) => json(response, { detail: String(error) }, 500));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/operator-playable-reworks') {
      reworkListRequests.push(Date.now());
      return json(response, {
        schema: 'feed.playable-rework-list.v1',
        items: structuredClone(reworkItems),
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/development-intake') {
      if (url.search !== '?limit=20') {
        return json(response, { detail: 'exact limit=20 required' }, 400);
      }
      return json(response, {
        schema: 'platform.development-intake.list.v1',
        items: structuredClone(intakeItems),
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/challenges') {
      return json(response, { box: 'in', items: [] });
    }
    if (request.method === 'POST' && url.pathname === '/api/events') {
      request.resume();
      return json(response, { ok: true }, 202);
    }
    if (url.pathname === '/module.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(moduleFixture);
      return;
    }
    if (url.pathname === '/styles.css') {
      response.setHeader('content-type', 'text/css; charset=utf-8');
      response.end(readFileSync(path.join(root, 'src', 'styles.css')));
      return;
    }
    if (MODULE_PATH.test(url.pathname)) {
      try {
        const source = readFileSync(path.join(root, 'src', url.pathname.slice(1)));
        response.setHeader('content-type', 'application/javascript; charset=utf-8');
        response.end(source);
      } catch {
        response.statusCode = 404;
        response.end();
      }
      return;
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
  '--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir',
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VITE_API_BASE: origin,
    PLATFORM_SOURCE_SHA: BUILD_SHA,
    PLATFORM_VERSION,
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
    ready() {}, expand() {}, disableVerticalSwipes() {}, setHeaderColor() {},
    setBackgroundColor() {}, lockOrientation() {}, onEvent() {}, close() {},
  },
};`;

let browser = null;
try {
  browser = await chromium.launch();
  const newPage = async (viewport) => {
    const page = await browser.newPage({ viewport });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: telegramSdkFixture,
    }));
    return page;
  };
  const bootFeed = async (page, label, extraQuery = '') => {
    const session = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session');
    await page.goto(`${origin}/?browserCase=${label}${extraQuery}`, { waitUntil: 'domcontentloaded' });
    await session;
    await page.locator('iframe').first().waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('.preloader'));
  };

  // ── A1. No operator capability → the surface does not exist at all. ──────
  operatorLevelFlaggingAvailable = false;
  developmentIntakeAvailable = false;
  developerFeedCatalog = null;
  reworkItems = [];
  intakeItems = [];
  const guest = await newPage({ width: 375, height: 812 });
  await bootFeed(guest, 'no-capability');
  assert.equal(await guest.locator(badgeSelector).count(), 0,
    'an account without the operator capability received the dev-feed badge');
  assert.equal(await guest.locator(sheetSelector).count(), 0,
    'an account without the operator capability received the dev-diff sheet');
  await guest.close();

  // ── A2. Operator capability + in-flight work → badge, sheet, rows. ───────
  operatorLevelFlaggingAvailable = true;
  developmentIntakeAvailable = true;
  developerFeedCatalog = catalogDiff({
    dev: catalogEntry({
      entryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      state: 'canary',
      stateVersion: 2,
      seriesId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runtime: null,
    }),
    publicEntry: catalogEntry({
      entryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      state: 'published',
      stateVersion: 4,
      seriesId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }),
  });
  reworkItems = [
    reworkItem({
      requestId: '66666666-6666-5666-8666-666666666666',
      playableId: 'solitaire-v1-swipe',
      instruction: 'Исправить центрирование.',
      operatorPresentation: { kind: 'current', effectDelivered: true },
    }),
    reworkItem({
      requestId: '77777777-7777-5777-8777-777777777777',
      playableId: 'minesweeper-v1-swipe',
      instruction: 'Перезапечь обложку.',
      createdAt: '2026-08-18T08:30:00.000Z',
      queueCounts: { active: 1, queued: 2 },
      releaseExecution: {
        releaseId: 'pr_119',
        state: 'needs_help',
        bindingDigest: 'f'.repeat(64),
        code: 'build_failed',
        summary: 'Сборка кандидата не проходит.',
        updatedAt: '2026-08-18T08:40:00.000Z',
        notificationStatus: null,
      },
    }),
    reworkItem({
      requestId: '88888888-8888-5888-8888-888888888888',
      playableId: 'merge-locked-swipe',
      instruction: 'Сделать legacy source исполняемым.',
      operatorPresentation: {
        kind: 'capability_gap_root_covered', effectDelivered: false,
      },
      createdAt: '2026-08-18T08:10:00.000Z',
    }),
    reworkItem({
      requestId: '99999999-9999-5999-8999-999999999999',
      playableId: 'arrows-v1-swipe',
      instruction: 'Исправить старую геометрию.',
      operatorPresentation: { kind: 'superseded', effectDelivered: false },
      createdAt: '2026-08-18T08:00:00.000Z',
    }),
  ];
  intakeItems = [intakeReceipt()];

  const page = await newPage({ width: 375, height: 812 });
  await bootFeed(page, 'operator');
  const badge = page.locator(badgeSelector);
  await badge.waitFor({ state: 'visible' });
  const badgeLabelLines = badge.locator('.dev-diff__badge-label-line');
  await badgeLabelLines.nth(0).waitFor({ state: 'visible' });
  await badgeLabelLines.nth(1).waitFor({ state: 'visible' });
  assert.deepEqual(await badgeLabelLines.allTextContents(), ['Dev-лента', '● Только мне'],
    'the dev-feed badge lost its exact two-line label');
  const badgeBorderColor = await badge.evaluate((node) => {
    const serialized = getComputedStyle(node).borderTopColor;
    const channels = serialized.match(/[\d.]+/g)?.map(Number) ?? [];
    return {
      serialized,
      red: channels[0],
      green: channels[1],
      blue: channels[2],
      alpha: channels[3] ?? 1,
    };
  });
  assert.deepEqual(
    [badgeBorderColor.red, badgeBorderColor.green, badgeBorderColor.blue],
    [255, 216, 90],
    `the dev-feed badge border is not yellow: ${badgeBorderColor.serialized}`,
  );
  assert.ok(
    Math.abs(badgeBorderColor.alpha - 0.58) < 0.01,
    `the dev-feed badge border alpha drifted: ${badgeBorderColor.serialized}`,
  );
  const { labelBoxes, lineHeight, fontSize } = await badge.evaluate((node) => ({
    labelBoxes: [...node.querySelectorAll('.dev-diff__badge-label-line')].map((line) => {
      const box = line.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
    lineHeight: Number.parseFloat(getComputedStyle(
      node.querySelector('.dev-diff__badge-label'),
    ).lineHeight),
    fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
  }));
  assert.ok(labelBoxes[0].bottom <= labelBoxes[1].top,
    'the two dev-feed label lines overlap');
  assert.ok(lineHeight >= fontSize * 1.15,
    'the two-line dev-feed label lacks safe glyph leading');
  assert.equal(await badge.evaluate((node) => node.tagName), 'BUTTON',
    'the dev-feed badge must be a real control, not a decorative label');
  // Active/NEEDS_HELP work stays visible with a human reason, alongside the
  // private catalog difference, but is never selectable for publication.
  const operatorBadgeCount = page.locator('[data-testid="dev-diff-badge-count"]');
  await operatorBadgeCount.waitFor({ state: 'visible' });
  await page.waitForFunction(() => Number(
    document.querySelector('[data-testid="dev-diff-badge-count"]')?.textContent,
  ) >= 3);
  assert.equal(await operatorBadgeCount.textContent(), '3',
    'the badge omitted visible active/NEEDS_HELP work');
  assert.equal(await page.locator(sheetSelector).isVisible(), false,
    'the inventory sheet was open before the operator asked for it');

  const requestsBeforeOpen = reworkListRequests.length;
  await badge.click();
  const sheet = page.locator(sheetSelector);
  await sheet.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  assert.equal(reworkListRequests.length, requestsBeforeOpen,
    'opening the read-only inventory issued its own projection request');

  assert.equal(await sheet.locator('[data-row="platform"]').count(), 0,
    'platform work history leaked into the release diff');
  assert.equal(await sheet.locator('[data-row="mechanic"]').count(), 2,
    'active and NEEDS_HELP mechanic work was hidden from the operator');
  assert.equal(await sheet.locator(rowSelector).count(), 3,
    'the sheet omitted active work or the literal catalog difference');
  const mechanicQueueText = await sheet.locator('[data-row="mechanic"]').allInnerTexts();
  assert.match(mechanicQueueText.join('\n'), /Исправить центрирование\./);
  assert.match(mechanicQueueText.join('\n'), /Перезапечь обложку\./);
  assert.match(mechanicQueueText.join('\n'), /Нужна помощь/);
  assert.doesNotMatch(mechanicQueueText.join('\n'), /66666666|77777777|sha256|requestId/,
    'technical queue identity leaked into the founder-facing reason');

  // The server-owned catalog difference is descriptive, without diagnostics.
  const catalogRow = sheet.locator('[data-row="catalog"]');
  const catalogText = await catalogRow.innerText();
  assert.match(catalogText, /Marble Sort/);
  assert.match(catalogText, /Новая версия уровней доступна только в вашей dev-ленте\./);
  assert.doesNotMatch(catalogText, /bbbbbbbb|dddddddd|runtime|entry|state|source|sha256/,
    'technical catalog identity leaked into the founder-facing diff');

  // This canary has no compatible runtime and therefore no direct-public control.
  assert.equal(await sheet.locator('text=Сделать доступным всем').count(), 0,
    'an ineligible canary received a direct-public control');
  assert.equal(await sheet.locator('input[type="checkbox"]').count(), 3,
    'visible ineligible work did not retain a disabled selection affordance');
  for (const checkbox of await sheet.locator('input[type="checkbox"]').all()) {
    assert.equal(await checkbox.isDisabled(), true,
      'an ineligible row pretended it could be published');
    assert.equal(await checkbox.isChecked(), false,
      'an ineligible row looked selected for publication');
  }

  // The card fades in over 0.2s; a proof screenshot must show the settled sheet.
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() =>
    document.querySelector('.dev-diff__card').scrollTop), 0,
  'the inventory opened already scrolled past the platform row');
  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, 'dev-diff-mobile-375x812.png') });
  }

  // Escape closes; the badge regains focus (the operator never loses their place).
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await badge.evaluate((node) => document.activeElement === node), true,
    'closing the inventory did not restore focus to its own control');

  await page.close();

  // Release mode is the ordinary public projection with clean product chrome.
  // The founder keeps only the compact view switch; all dev controls and
  // diagnostics are absent rather than cosmetically disabled.
  const releaseView = await newPage({ width: 375, height: 812 });
  await bootFeed(releaseView, 'operator-release-view', '&feedView=release&diag=1');
  await releaseView.locator('[data-testid="operator-feed-view-toggle"]')
    .waitFor({ state: 'visible' });
  assert.equal(await releaseView.locator('[data-feed-view="release"]')
    .getAttribute('aria-pressed'), 'true');
  assert.equal(await releaseView.locator(badgeSelector).count(), 0,
    'the dev-feed badge leaked into the release projection');
  assert.equal(await releaseView.locator('.platform-development-intake').count(), 0,
    'the platform edit control leaked into the release projection');
  assert.equal(await releaseView.locator('.game__operator-playable-rework').count(), 0,
    'the mechanic edit control leaked into the release projection');
  assert.equal(await releaseView.locator('.feed-bar__lab:not([hidden])').count(), 0,
    'the Labs entry leaked into the release projection');
  assert.equal(await releaseView.locator('.feed-bar__debug').count(), 0,
    'the debug entry leaked into the release projection');
  assert.equal(await releaseView.locator('[data-panel="swipe-debug"]').count(), 0,
    'the diagnostic panel leaked into the release projection');
  assert.equal(await releaseView.locator('.feed-bar__version:visible').count(), 0,
    'the technical build stamp leaked into the release projection');
  if (screenshotDir) {
    await releaseView.screenshot({ path: path.join(screenshotDir, 'release-feed-mobile-375x812.png') });
  }
  await releaseView.close();

  // ── A3. Desktop proof of the same open sheet. ───────────────────────────
  const desktop = await newPage({ width: 1280, height: 800 });
  await bootFeed(desktop, 'operator-desktop');
  await desktop.locator(badgeSelector).click();
  await desktop.locator(sheetSelector).waitFor({ state: 'visible' });
  await desktop.waitForTimeout(400);
  if (screenshotDir) {
    await desktop.screenshot({ path: path.join(screenshotDir, 'dev-diff-desktop-1280x800.png') });
  }
  await desktop.close();

  // ── A4. Exact candidate → content-bound code → refreshed public row. ─────
  reworkItems = [];
  intakeItems = [];
  const directEntryId = 'abababab-abab-4bab-8bab-abababababab';
  developerFeedCatalog = catalogDiff({
    dev: catalogEntry({
      entryId: directEntryId,
      state: 'candidate',
      stateVersion: 7,
      seriesId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    }),
  });
  const direct = await newPage({ width: 375, height: 812 });
  await bootFeed(direct, 'operator-direct-promotion');
  await direct.waitForFunction(() => document.querySelector(
    '[data-testid="developer-feed-badge"]',
  ));
  await direct.locator(badgeSelector).click();
  const directSheet = direct.locator(sheetSelector);
  await directSheet.waitFor({ state: 'visible' });
  const publish = directSheet.locator('[data-action="publish-catalog"]');
  const publishAll = directSheet.locator('[data-action="publish-all"]');
  const selection = directSheet.locator('[data-action="select-catalog"]');
  await publish.waitFor({ state: 'visible' });
  await publishAll.waitFor({ state: 'visible' });
  assert.equal(await selection.isChecked(), true,
    'the only publishable difference was not selected by default');
  await selection.uncheck();
  assert.equal(await publish.isDisabled(), true,
    'publish-selected stayed active with no selected difference');
  assert.equal(await publishAll.isDisabled(), false,
    'publish-all was disabled by an empty manual selection');
  assert.equal(promotionPrepareRequests.length, 1,
    'the exact candidate did not issue one bounded prepare');
  assert.deepEqual(promotionPrepareRequests[0], {
    schema: 'catalog.direct-promotion.prepare.v1',
    operationId: promotionPrepareRequests[0].operationId,
    entryId: directEntryId,
    expectedStateVersion: 7,
    action: 'publish',
  });
  await publishAll.click();
  assert.equal(await selection.isChecked(), true,
    'publish-all did not select the real difference');
  await directSheet.locator('text=Код: ABC123').waitFor({ state: 'visible' });
  await selection.uncheck();
  assert.equal(
    await directSheet.locator('[data-testid="catalog-promotion-confirm"]').isHidden(),
    true,
    'deselecting the item left its publication confirmation active',
  );
  assert.equal(promotionApplyRequests.length, 0,
    'deselecting an item triggered a publication mutation');
  await selection.check();
  await publish.click();
  await directSheet.locator('text=Код: ABC123').waitFor({ state: 'visible' });
  const codeInput = directSheet.locator('[data-testid="catalog-promotion-code-input"]');
  await codeInput.fill('abc');
  await direct.waitForTimeout(1_100);
  const backgroundSession = direct.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session');
  await direct.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await backgroundSession;
  await directSheet.locator('[data-testid="catalog-promotion-confirm"]')
    .waitFor({ state: 'visible' });
  assert.equal(await codeInput.inputValue(), 'abc',
    'a background projection refresh wiped the typed confirmation code');

  await codeInput.fill('000000');
  const refusedApply = direct.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/catalog/operator-promotion/apply'
      && response.status() === 409);
  await directSheet.locator('[data-action="confirm-catalog-publication"]').click();
  await refusedApply;
  await directSheet.locator('[role="status"]')
    .filter({ hasText: 'Публикация не подтверждена' }).waitFor({ state: 'visible' });

  await codeInput.fill('abc123');
  const failedRefresh = direct.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'
      && response.status() === 503);
  await directSheet.locator('[data-action="confirm-catalog-publication"]').click();
  await failedRefresh;
  await directSheet.locator('[role="status"]')
    .filter({ hasText: 'Опубликовано. Не удалось обновить список' })
    .waitFor({ state: 'visible' });
  await direct.waitForTimeout(1_100);
  const refreshedSession = direct.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/session'
      && response.status() === 200);
  await direct.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshedSession;
  await directSheet.locator('[data-testid="dev-diff-empty"]')
    .filter({ hasText: 'Dev-лента совпадает с релизной' }).waitFor();
  assert.equal(promotionApplyRequests.length, 2,
    'the refused and accepted confirmations were not each issued once');
  assert.equal(promotionApplyRequests[1].confirmationCode, 'ABC123',
    'the confirmation code was not normalized before the server check');
  assert.equal(await directSheet.locator('[data-action="publish-catalog"]').count(), 0,
    'the committed public row retained a stale promotion control');
  await direct.close();

  // ── A5. Nothing in flight → the honest empty state. ─────────────────────
  reworkItems = [];
  intakeItems = [];
  developerFeedCatalog = catalogDiff({
    publicEntry: catalogEntry({
      entryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      state: 'published',
      stateVersion: 4,
      seriesId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }),
  });
  const quiet = await newPage({ width: 375, height: 812 });
  await bootFeed(quiet, 'operator-quiet');
  const quietBadge = quiet.locator(badgeSelector);
  await quietBadge.waitFor({ state: 'visible' });
  assert.equal(await quiet.locator('[data-testid="dev-diff-badge-count"]').isVisible(), false,
    'the badge advertised a change count with nothing in flight');
  await quietBadge.click();
  await quiet.locator('[data-testid="dev-diff-empty"]')
    .filter({ hasText: 'Dev-лента совпадает с релизной' }).waitFor();
  await quiet.waitForTimeout(400);
  if (screenshotDir) {
    await quiet.screenshot({ path: path.join(screenshotDir, 'dev-diff-empty-375x812.png') });
  }
  await quiet.close();

  // ── A6. An untrusted projection must never claim that both feeds match. ───
  developerFeedCatalog = {
    schema: 'feed.developer-catalog-diff.v1',
    mechanic: 'sort',
    variant: 'base',
    available: false,
    unavailableReason: 'catalog_projection_invalid',
    dev: null,
    public: null,
  };
  const unknown = await newPage({ width: 375, height: 812 });
  await bootFeed(unknown, 'operator-catalog-unknown');
  await unknown.locator(badgeSelector).click();
  await unknown.locator('[data-testid="dev-diff-catalog-unknown"]')
    .waitFor({ state: 'visible' });
  assert.equal(await unknown.locator('[data-testid="dev-diff-empty"]').count(), 0,
    'an invalid catalog projection claimed that dev and release match');
  await unknown.close();

  // ── B. destroy() drops every listener it added. ─────────────────────────
  const modulePage = await newPage({ width: 390, height: 760 });
  await modulePage.goto(`${origin}/module.html`, { waitUntil: 'domcontentloaded' });
  await modulePage.waitForFunction(() => window.ready === true);

  // The pure projection is the contract the DOM renders; assert it directly.
  const projection = await modulePage.evaluate((matchedRework) => window.developerFeedDiffModel({
    operatorSurfacesActive: true,
    platform: { sourceSha: 'a'.repeat(40), stamp: 'stamp' },
    reworks: [['marble-sort-swipe', [matchedRework]]],
    platformIntake: null,
    vocabulary: {
      schema: 'platform.operator-presentation-vocabulary.v1',
      audience: {
        labs: { label: 'Labs fixture', icon: 'L', tone: 'gray' },
        exactUser: { label: 'Лично', icon: '◉', tone: 'blue' },
        team: { label: 'Team fixture', icon: 'T', tone: 'purple' },
        public: { label: 'Public fixture', icon: 'P', tone: 'green' },
      },
      workState: {
        working: { label: 'Working fixture', icon: 'W', tone: 'amber' },
        ready: { label: 'Ready fixture', icon: 'R', tone: 'cyan' },
        needsHelp: { label: 'Help fixture', icon: 'H', tone: 'red' },
        previousStopped: { label: 'Stopped fixture', icon: 'S', tone: 'neutral' },
      },
    },
    adoption: {
      playableId: 'marble-sort-swipe',
      releaseId: 'pr_777',
      candidateArtifactDigest: `sha256:${'3'.repeat(64)}`,
      sourceCommit: '8'.repeat(40),
    },
    catalog: null,
  }), reworkItem({
    requestId: '56565656-5656-5656-8656-565656565656',
    playableId: 'marble-sort-swipe',
    instruction: 'Убрать подложку.',
    releaseExecution: {
      releaseId: 'pr_777',
      state: 'needs_help',
      bindingDigest: 'f'.repeat(64),
      code: 'build_failed',
      summary: 'Сборка кандидата не проходит.',
      updatedAt: '2026-08-18T08:40:00.000Z',
      notificationStatus: null,
    },
  }));
  assert.equal(projection.mechanics.length, 1);
  assert.equal(projection.mechanics[0].adopted, true);
  assert.equal(projection.mechanics[0].status, 'Аудитория: ◉ Лично',
    'the Feed ignored the strict server-owned audience vocabulary');
  assert.deepEqual(projection.mechanics[0].instructions, [],
    'a NEEDS_HELP queue item leaked into the successful publication receipt');
  assert.deepEqual(projection.mechanics[0].pendingRequests, [{
    instruction: 'Убрать подложку.',
    status: 'Нужна помощь',
    detail: 'Сборка кандидата не проходит.',
  }], 'a NEEDS_HELP request was not shown with its plain-language reason');
  const directWireValidation = await modulePage.evaluate(() => ({
    preparedExtraRejected: window.validateCatalogDirectPromotionPrepared({
      schema: 'catalog.direct-promotion.prepared.v1',
      operationId: 'abababab-abab-4bab-8bab-abababababab',
      action: 'publish',
      entryId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      expectedStateVersion: 7,
      fromState: 'candidate',
      toState: 'published',
      fromAudience: 'exactUser',
      toAudience: 'public',
      runtimeArtifactDigest: `sha256:${'a'.repeat(64)}`,
      confirmationCode: 'ABC123',
      extra: true,
    }) === null,
    resultAccepted: window.validateCatalogDirectPromotionResult({
      schema: 'catalog.direct-promotion.result.v1',
      operationId: 'abababab-abab-4bab-8bab-abababababab',
      entryId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      fromState: 'candidate',
      toState: 'published',
      stateVersion: 8,
      replayed: false,
    }) !== null,
    resultWrongReplayRejected: window.validateCatalogDirectPromotionResult({
      schema: 'catalog.direct-promotion.result.v1',
      operationId: 'abababab-abab-4bab-8bab-abababababab',
      entryId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      fromState: 'candidate',
      toState: 'published',
      stateVersion: 8,
      replayed: 'false',
    }) === null,
  }));
  assert.deepEqual(directWireValidation, {
    preparedExtraRejected: true,
    resultAccepted: true,
    resultWrongReplayRejected: true,
  }, 'direct-public validators accepted drifted wire');
  await modulePage.evaluate(() => window.surface.update({
    operatorSurfacesActive: true,
    platform: { sourceSha: 'a'.repeat(40), stamp: 'stamp' },
    reworks: [],
    platformIntake: null,
    vocabulary: {
      schema: 'platform.operator-presentation-vocabulary.v1',
      audience: {
        labs: { label: 'Labs fixture', icon: 'L', tone: 'gray' },
        exactUser: { label: 'Лично', icon: '◉', tone: 'blue' },
        team: { label: 'Team fixture', icon: 'T', tone: 'purple' },
        public: { label: 'Public fixture', icon: 'P', tone: 'green' },
      },
      workState: {
        working: { label: 'Working fixture', icon: 'W', tone: 'amber' },
        ready: { label: 'Ready fixture', icon: 'R', tone: 'cyan' },
        needsHelp: { label: 'Help fixture', icon: 'H', tone: 'red' },
        previousStopped: { label: 'Stopped fixture', icon: 'S', tone: 'neutral' },
      },
    },
    adoption: null,
    catalog: null,
  }));
  assert.deepEqual(
    await modulePage.locator('.dev-diff__badge-label-line').allTextContents(),
    ['Dev-лента', '◉ Лично'],
    'the dev-feed badge did not refresh from the strict server audience vocabulary',
  );
  assert.equal(projection.changed, 1);
  assert.equal(projection.empty, false);

  const catalogValidation = await modulePage.evaluate(() => {
    const valid = {
      schema: 'feed.developer-catalog-diff.v1', mechanic: 'sort', variant: 'base',
      available: false, unavailableReason: 'catalog_entry_unavailable',
      dev: null, public: null,
    };
    return {
      valid: window.validateDeveloperFeedCatalogDiff(valid),
      extra: window.validateDeveloperFeedCatalogDiff({ ...valid, callerState: 'forbidden' }),
      mixed: window.validateDeveloperFeedCatalogDiff({
        ...valid, available: true, unavailableReason: null,
      }),
    };
  });
  assert.equal(catalogValidation.valid?.schema, 'feed.developer-catalog-diff.v1');
  assert.equal(catalogValidation.extra, null, 'catalog projection accepted an unknown field');
  assert.equal(catalogValidation.mixed, null, 'catalog projection accepted mixed availability');

  // A mixed mechanic + catalog sheet must not claim that the catalog-only
  // mutation publishes every visible difference.
  await modulePage.evaluate(() => {
    window.surface.destroy();
    const runtimeArtifactDigest = `sha256:${'a'.repeat(64)}`;
    window.surface = window.mountDeveloperFeedDiffSurface(document.body, {
      input: {
        operatorSurfacesActive: true,
        reworks: [],
        adoption: {
          playableId: 'marble-sort-swipe',
          releaseId: 'pr_mixed',
          candidateArtifactDigest: `sha256:${'3'.repeat(64)}`,
          sourceCommit: '8'.repeat(40),
        },
        catalog: {
          schema: 'feed.developer-catalog-diff.v1', mechanic: 'sort', variant: 'base',
          available: true, unavailableReason: null,
          dev: {
            entryId: 'abababab-abab-4bab-8bab-abababababab',
            kind: 'series', state: 'candidate', stateVersion: 7,
            seriesId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', levelSpecHash: null,
            runtime: {
              releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              playableId: 'marble-sort-swipe', runtimeArtifactDigest,
              sourceCommit: 'b'.repeat(40),
            },
            stateChangedAt: '2026-08-27T12:00:00Z',
          },
          public: null,
        },
        catalogPromotion: {
          schema: 'catalog.direct-promotion.prepared.v1',
          operationId: '12121212-1212-4212-8212-121212121212',
          action: 'publish', entryId: 'abababab-abab-4bab-8bab-abababababab',
          expectedStateVersion: 7, fromState: 'candidate', toState: 'published',
          fromAudience: 'exactUser', toAudience: 'public', runtimeArtifactDigest,
          confirmationCode: 'ABC123',
        },
      },
      onPromoteCatalog: async () => ({ status: 'committed_refreshed' }),
    });
  });
  await modulePage.locator(badgeSelector).click();
  await modulePage.locator(sheetSelector).waitFor({ state: 'visible' });
  assert.equal(await modulePage.locator('[data-row="mechanic"] input[type="checkbox"]')
    .isDisabled(), true, 'a separately published mechanic looked batch-publishable');
  await modulePage.locator('[data-action="publish-all"]')
    .filter({ hasText: 'Выложить уровни' }).waitFor();
  assert.equal(await modulePage.locator('[data-action="publish-all"]')
    .filter({ hasText: 'Выложить всё' }).count(), 0,
  'a catalog-only mutation over-claimed that it publishes every visible difference');
  await modulePage.locator('[data-close]').last().click();

  // One content-bound confirmation publishes the complete selected mechanic
  // set. The current server projection contains one adopted head, while the
  // wire and surface stay batch-shaped for the later multi-head projection.
  const adoptedLegacyRework = reworkItem({
    requestId: '78787878-7878-4878-8878-787878787878',
    playableId: 'marble-sort-swipe',
    instruction: 'Убрать подложку.',
    releaseExecution: {
      releaseId: '56565656-5656-4656-8656-565656565656',
      state: 'ready_for_approval',
      bindingDigest: '4'.repeat(64),
      code: null,
      summary: null,
      updatedAt: '2026-08-18T09:15:00.000Z',
      notificationStatus: 'confirmed',
    },
  });
  const mechanicPublication = await modulePage.evaluate((legacyRework) => {
    window.surface.destroy();
    const bindingDigest = '4'.repeat(64);
    const candidateArtifactDigest = '5'.repeat(64);
    const prepared = {
      schema: 'feed.playable-publication.prepared.v1',
      operationId: '34343434-3434-4434-8434-343434343434',
      action: 'publish',
      clientInstanceId: '45454545-4545-4454-8454-454545454545',
      items: [{
        releaseId: '56565656-5656-4656-8656-565656565656',
        playableId: 'marble-sort-swipe',
        bindingDigest,
        candidateArtifactDigest,
        runtimeArtifactDigest: `sha256:${'6'.repeat(64)}`,
        changes: ['Убрать подложку.'],
      }, {
        releaseId: '67676767-6767-4767-8767-676767676767',
        playableId: 'arrows-v1-swipe',
        bindingDigest: '7'.repeat(64),
        candidateArtifactDigest: '8'.repeat(64),
        runtimeArtifactDigest: `sha256:${'9'.repeat(64)}`,
        changes: ['Сделать стрелки ярче.'],
      }],
      confirmationCode: 'D0C0DE',
    };
    const input = {
      operatorSurfacesActive: true,
      reworks: [['marble-sort-swipe', [legacyRework]]],
      adoptions: [{
        playableId: 'marble-sort-swipe',
        releaseId: prepared.items[0].releaseId,
        bindingDigest,
        candidateArtifactDigest,
      }, {
        playableId: 'arrows-v1-swipe',
        releaseId: prepared.items[1].releaseId,
        bindingDigest: prepared.items[1].bindingDigest,
        candidateArtifactDigest: prepared.items[1].candidateArtifactDigest,
      }],
      catalog: {
        schema: 'feed.developer-catalog-diff.v1', mechanic: 'sort', variant: 'base',
        available: false, unavailableReason: 'catalog_entry_unavailable',
        dev: null, public: null,
      },
      mechanicPublication: prepared,
    };
    window.mechanicPublicationInput = input;
    window.mechanicPublicationPrepared = prepared;
    window.mechanicPublications = [];
    window.mechanicPublicationPreparations = [];
    window.surface = window.mountDeveloperFeedDiffSurface(document.body, {
      input,
      onPrepareMechanics: async (playableIds) => {
        window.mechanicPublicationPreparations.push(playableIds);
        return prepared;
      },
      onPublishMechanic: async (value, code) => {
        window.mechanicPublications.push({ value, code });
        return { status: 'queued_refreshed' };
      },
    });
    return {
      preparedAccepted: window.validatePlayablePublicationPrepared(prepared) !== null,
      preparedExtraRejected: window.validatePlayablePublicationPrepared({
        ...prepared, extra: true,
      }) === null,
      requestedAccepted: window.validatePlayablePublicationRequested({
        schema: 'feed.playable-publication.requested.v1',
        operationId: prepared.operationId,
        action: 'publish', items: prepared.items, status: 'queued', replayed: false,
      }) !== null,
    };
  }, adoptedLegacyRework);
  assert.deepEqual(mechanicPublication, {
    preparedAccepted: true,
    preparedExtraRejected: true,
    requestedAccepted: true,
  }, 'mechanic publication validators accepted a drifted wire');
  await modulePage.locator(badgeSelector).click();
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 0,
    'opening the inventory silently preselected private mechanics');
  assert.equal(await modulePage.locator('[data-action="publish-mechanic"]').isDisabled(), true,
    'publish-selected stayed active with no selected mechanic');
  const marbleMechanicRow = modulePage.locator(
    '[data-row="mechanic"][data-playable-id="marble-sort-swipe"]',
  );
  assert.equal(await marbleMechanicRow.getByText('Убрать подложку.', { exact: true }).count(), 1,
    'the exact adopted legacy instruction was not rendered once as a publishable difference');
  assert.equal(await marbleMechanicRow.locator('.dev-diff__pending').count(), 0,
    'the exact adopted legacy instruction was also rendered as pending work');
  const selectAllMechanics = modulePage.locator('[data-action="select-all-mechanics"]');
  assert.equal(await selectAllMechanics.isChecked(), false,
    'select-all started checked while every mechanic row was clear');
  assert.equal(await selectAllMechanics.getAttribute('aria-label'), 'Выбрать все механики');
  const marbleMechanic = modulePage.locator(
    '[data-action="select-mechanic"][aria-label="Выбрать Marble Sort"]',
  );
  await marbleMechanic.check();
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 1,
    'one explicit mechanic selection changed more than one row');
  assert.equal(await selectAllMechanics.evaluate((node) => node.indeterminate), true,
    'one selected mechanic did not produce the partial select-all state');
  assert.equal(await modulePage.locator('.dev-diff__select-all').getByText('Выбрать все', { exact: true }).count(), 1,
    'the partial-selection control did not keep the visible select-all label');
  await modulePage.evaluate(() => {
    const prepared = window.mechanicPublicationPrepared;
    const extra = {
      releaseId: '89898989-8989-4898-8898-898989898989',
      playableId: 'minesweeper-v1-swipe',
      bindingDigest: 'a'.repeat(64),
      candidateArtifactDigest: 'b'.repeat(64),
      runtimeArtifactDigest: `sha256:${'c'.repeat(64)}`,
      changes: ['Сделать клетки контрастнее.'],
    };
    window.surface.update({
      ...window.mechanicPublicationInput,
      adoptions: [...window.mechanicPublicationInput.adoptions, {
        playableId: extra.playableId,
        releaseId: extra.releaseId,
        bindingDigest: extra.bindingDigest,
        candidateArtifactDigest: extra.candidateArtifactDigest,
      }],
      mechanicPublication: { ...prepared, items: [...prepared.items, extra] },
    });
  });
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 1,
    'projection refresh silently expanded the explicit mechanic selection');
  assert.equal(await modulePage.locator(
    '[data-action="select-mechanic"][aria-label="Выбрать Marble Sort"]',
  ).isChecked(), true, 'projection refresh lost a still-eligible explicit choice');
  assert.equal(await modulePage.locator(
    '[data-action="select-mechanic"][aria-label="Выбрать Minesweeper"]',
  ).isChecked(), false, 'projection refresh selected a newly eligible mechanic');
  assert.equal(await selectAllMechanics.evaluate((node) => node.indeterminate), true,
    'partial state was lost after projection refresh');
  await modulePage.evaluate(() => window.surface.update(window.mechanicPublicationInput));
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 1,
    'returning to the original projection lost the still-eligible explicit choice');
  await marbleMechanic.uncheck();
  await selectAllMechanics.check();
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 2,
    'select-all did not select every eligible mechanic');
  assert.equal(await selectAllMechanics.getAttribute('aria-label'), 'Убрать все механики');
  await selectAllMechanics.uncheck();
  assert.equal(await modulePage.locator('[data-action="select-mechanic"]:checked').count(), 0,
    'remove-all left a mechanic selected');
  assert.equal(await selectAllMechanics.getAttribute('aria-label'), 'Выбрать все механики');
  await selectAllMechanics.check();
  await modulePage.locator('[data-action="publish-mechanic"]').click();
  assert.deepEqual(
    await modulePage.evaluate(() => window.mechanicPublicationPreparations),
    [['marble-sort-swipe', 'arrows-v1-swipe']],
    'publication reused a stale projected code instead of preparing the selected set afresh',
  );
  await modulePage.locator('text=Код: D0C0DE').waitFor({ state: 'visible' });
  await modulePage.locator('[data-testid="mechanic-publication-code-input"]').fill('d0c0de');
  await modulePage.locator('[data-action="confirm-mechanic-publication"]').click();
  await modulePage.locator('text=Публикация запущена').last().waitFor({ state: 'visible' });
  const submittedMechanicPublication = await modulePage.evaluate(() => window.mechanicPublications);
  assert.equal(submittedMechanicPublication.length, 1,
    'publish-all issued more than one publication mutation');
  assert.equal(submittedMechanicPublication[0].code, 'D0C0DE',
    'the one publication code was not normalized and submitted once');
  assert.equal(submittedMechanicPublication[0].value.items.length, 2,
    'the complete prepared mechanic set was not submitted atomically');
  await modulePage.locator('[data-close]').last().click();

  const listenerBalance = () => modulePage.evaluate(() =>
    Object.fromEntries(window.documentListeners));
  assert.equal((await listenerBalance()).keydown, 1,
    'the surface did not register its document-level Escape handler');

  await modulePage.locator(badgeSelector).click();
  await modulePage.locator(sheetSelector).waitFor({ state: 'visible' });
  await modulePage.evaluate(() => window.surface.destroy());
  assert.equal(await modulePage.locator('[data-testid="dev-diff-surface"]').count(), 0,
    'destroy left the surface root attached');
  assert.equal((await listenerBalance()).keydown, 0,
    'destroy left a leaked document keydown listener behind');

  // A late Escape must reach nothing: no resurrection, no throw.
  await modulePage.keyboard.press('Escape');
  await modulePage.waitForTimeout(100);
  assert.equal(await modulePage.locator(sheetSelector).count(), 0,
    'an Escape after destroy still reached the detached surface');
  await modulePage.evaluate(() => window.surface.destroy());
  assert.equal((await listenerBalance()).keydown, 0,
    'a second destroy double-removed a listener it no longer owns');
  await modulePage.close();

  console.log('developer feed diff browser contract OK');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
