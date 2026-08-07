/**
 * The persistent debug entry must be an operator-only affordance decided by the
 * SERVER (the same /session capability that reveals the LAB button), must leave
 * zero DOM footprint for anybody else, must keep the historical ?diag route
 * working without any capability, and must never stack a second panel.
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
const buildRoot = mkdtempSync(path.join(tmpdir(), 'operator-debug-entry-'));
const debugSelector = '.feed-bar__debug[aria-label="Debug panel"]';
const labSelector = '.feed-bar__lab[aria-label="Catalog Lab access"]';
const panelSelector = '[data-panel="swipe-debug"]';
let origin = '';
let catalogLabAvailable = false;

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
  backend_version: 'operator-debug-entry-fixture',
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
  if (request.method === 'POST' && url.pathname === '/api/session') {
    request.resume();
    return json(response, sessionResponse());
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
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

// Isolated output directory: several repository checks build this single-file
// app, and sharing dist/ would let one check serve a half-written file.
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
  env: { ...process.env, VITE_API_BASE: origin },
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

  // 1. A non-operator account leaves ZERO DOM footprint — not a hidden button.
  catalogLabAvailable = false;
  const guest = await newPage();
  const guestSession = awaitSession(guest);
  await guest.goto(`${origin}/?browserCase=capability-false`, { waitUntil: 'domcontentloaded' });
  await guestSession;
  await guest.locator(labSelector).waitFor({ state: 'attached' });
  await guest.locator('iframe').first().waitFor({ state: 'attached' });
  await guest.waitForFunction(() => !document.querySelector('.preloader'));
  assert.equal(await guest.locator(debugSelector).count(), 0,
    'a non-operator received the debug entry');
  assert.equal(await guest.locator('.feed-bar__debug').count(), 0,
    'a non-operator received a debug element under some other label');
  assert.equal(await guest.locator(panelSelector).count(), 0,
    'a non-operator received the debug panel');
  assert.equal(await guest.locator(labSelector).isHidden(), true,
    'the fixture no longer describes a non-operator');
  await guest.close();

  // 2. The exact server capability reveals the persistent entry. It is created
  //    only by the asynchronous /session answer, never by the initial build.
  catalogLabAvailable = true;
  const operator = await newPage();
  const operatorSession = awaitSession(operator);
  await operator.goto(`${origin}/?browserCase=capability-true`, { waitUntil: 'domcontentloaded' });
  await operatorSession;
  await operator.locator(debugSelector).waitFor({ state: 'visible' });
  await operator.locator('iframe').first().waitFor({ state: 'attached' });
  await operator.waitForFunction(() => !document.querySelector('.preloader'));
  assert.equal(await operator.locator(debugSelector).count(), 1,
    'the operator debug entry must be a single button');
  assert.equal(new URL(operator.url()).searchParams.has('diag'), false,
    'the persistent entry must not need the ?diag query parameter');
  assert.equal(await operator.locator(panelSelector).count(), 0,
    'the persistent entry opened the panel without a tap');

  // It must not sit on top of the LAB button it ships beside, and it must stay
  // out of the centred product tab switcher.
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const width of [320, 360, 390]) {
    await operator.setViewportSize({ width, height: 760 });
    const debugBox = await operator.locator(debugSelector).boundingBox();
    const labBox = await operator.locator(labSelector).boundingBox();
    const switchBox = await operator.locator('.feed-bar__switch').boundingBox();
    assert.equal(overlaps(debugBox, labBox), false,
      `the debug entry overlaps the LAB button at ${width}px`);
    assert.equal(overlaps(debugBox, switchBox), false,
      `the debug entry overlaps the tab switcher at ${width}px`);
    assert.equal(overlaps(labBox, switchBox), false,
      `the LAB button overlaps the tab switcher at ${width}px`);
  }
  await operator.setViewportSize({ width: 375, height: 812 });
  assert.equal(await operator.locator('.feed-bar__switch .feed-bar__debug').count(), 0,
    'the debug entry must not be a tab of the product switcher');

  // 3. A tap opens the panel; a second tap under the open panel does not stack
  //    a second copy, and neither does the exact same tap sequence repeated.
  const shownIndexBefore = await operator.evaluate(() =>
    document.querySelectorAll('.feed-bar__icon--active').length);
  await operator.locator(debugSelector).click();
  await operator.locator(panelSelector).filter({ hasText: 'SWIPE DIAG' })
    .waitFor({ state: 'visible' });
  assert.equal(await operator.locator(panelSelector).count(), 1);
  assert.match((await operator.locator(panelSelector).textContent()) || '', /SWIPE DIAG/);

  await operator.locator(debugSelector).dispatchEvent('click');
  await operator.locator(debugSelector).dispatchEvent('click');
  await operator.waitForTimeout(250);
  assert.equal(await operator.locator(panelSelector).count(), 1,
    'repeated taps stacked a second debug panel');
  assert.equal(await operator.evaluate(() =>
    document.querySelectorAll('.feed-bar__icon--active').length), shownIndexBefore,
  'opening the debug panel changed the active feed tab');

  // Close restores a closed panel and the entry stays available for the next tap.
  await operator.locator(`${panelSelector} button:has-text("Close")`).click();
  await operator.locator(panelSelector).waitFor({ state: 'detached' });
  await operator.locator(debugSelector).click();
  await operator.locator(panelSelector).waitFor({ state: 'visible' });
  assert.equal(await operator.locator(panelSelector).count(), 1,
    'reopening after Close did not produce exactly one panel');
  await operator.close();

  // 4. The historical QA route is untouched and needs no capability at all.
  catalogLabAvailable = false;
  const qa = await newPage();
  const qaSession = awaitSession(qa);
  await qa.goto(`${origin}/?diag=1`, { waitUntil: 'domcontentloaded' });
  await qaSession;
  await qa.locator(debugSelector).waitFor({ state: 'visible' });
  await qa.locator(panelSelector).waitFor({ state: 'visible' });
  assert.equal(await qa.locator(panelSelector).count(), 1,
    '?diag=1 must open exactly one panel');
  assert.equal(await qa.locator(labSelector).isHidden(), true,
    '?diag=1 must not grant the Catalog Lab entry');
  // A ?diag session that the server does not recognize as an operator keeps its
  // QA button: the capability may only ADD the entry, never take the route away.
  await qa.locator(`${panelSelector} button:has-text("Close")`).click();
  await qa.locator(panelSelector).waitFor({ state: 'detached' });
  assert.equal(await qa.locator(debugSelector).count(), 1,
    'a non-operator ?diag session lost its QA debug entry');
  await qa.close();

  console.log('operator debug entry browser: server gate, zero non-operator DOM, idempotent panel, ?diag route verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
