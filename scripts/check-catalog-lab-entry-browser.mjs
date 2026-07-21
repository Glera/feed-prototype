import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    return json(response, artifactAuthorization);
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
  await enabledPage.getByRole('button', { name: 'Use another code' }).click();

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
