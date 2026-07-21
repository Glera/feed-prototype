import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userId = 424242;
const playableId = 'merge-locked-v1-swipe';
const stagedPlayableId = 'marble-sort-swipe';
const binding = {
  mapping_id: '10000000-0000-4000-8000-000000000001',
  playable_id: playableId,
  variant_id: '20000000-0000-4000-8000-000000000002',
  catalog_mechanic: 'merge/locked',
  mechanic_family: 'merge',
  mapping_version: 'timing-browser.v1',
  mapping_digest: 'a'.repeat(64),
};
const stagedBinding = {
  mapping_id: '10000000-0000-4000-8000-000000000007',
  playable_id: stagedPlayableId,
  variant_id: '20000000-0000-4000-8000-000000000008',
  catalog_mechanic: 'sort/base',
  mechanic_family: 'sort',
  mapping_version: 'timing-browser.v1',
  mapping_digest: 'c'.repeat(64),
};
const scenarios = {
  delayed: { startedAt: 0, sessionRequests: 0, generatedOfferRequests: [], cpEvents: [] },
  'no-binding': { startedAt: 0, sessionRequests: 0, generatedOfferRequests: [], cpEvents: [] },
  unauthorized: {
    startedAt: 0,
    sessionRequests: 0,
    generatedOfferRequests: [],
    cpEvents: [],
    postRejectionRequests: [],
  },
  staged: {
    startedAt: 0,
    sessionRequests: 0,
    generatedOfferRequests: [],
    cpEvents: [],
    sessionPending: false,
    sessionRelease: null,
    projectionPending: false,
    projectionRelease: null,
    projectionHeld: false,
  },
};
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

const scenarioOf = (request) => {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('tma ')) return null;
  const scenario = new URLSearchParams(authorization.slice(4)).get('harness_scenario');
  return Object.hasOwn(scenarios, scenario) ? scenario : null;
};

const fakePlayable = (requestedPlayableId) => `<!doctype html><html><body><canvas></canvas><script>
const id=${JSON.stringify(requestedPlayableId)};
const send=(type)=>parent.postMessage({source:'playable',id,type},'*');
addEventListener('message',(event)=>{
  const data=event.data||{};
  if(data.target==='playable-swipe'&&data.type==='prepareInteractive')send('interactive_ready');
});
addEventListener('load',()=>send('static_ready'));
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  const scenario = scenarioOf(request);
  if (request.method === 'POST' && url.pathname === '/api/session') {
    if (!scenario) return json(response, { code: 'fixture_identity_missing' }, 401);
    const state = scenarios[scenario];
    state.sessionRequests += 1;
    if (scenario === 'unauthorized') {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return json(response, { detail: 'initData expired' }, 401);
    }
    if (scenario === 'delayed' && state.sessionRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 4200));
    }
    if (scenario === 'staged' && state.sessionRequests === 1) {
      state.sessionPending = true;
      await new Promise((resolve) => { state.sessionRelease = resolve; });
      state.sessionPending = false;
      state.sessionRelease = null;
    }
    const available = scenario === 'delayed' || scenario === 'staged';
    const bindings = scenario === 'staged'
      ? { [stagedPlayableId]: stagedBinding }
      : available ? { [playableId]: binding } : {};
    return json(response, {
      user: { id: userId, ref_code: 'timing-browser' },
      ref_code: 'timing-browser',
      balance: 0,
      puzzles: 0,
      is_new: false,
      backend_version: 'timing-browser',
      builtin_feed_bindings: {
        schema: 'feed.builtin-bindings.v1',
        available,
        unavailable_reason: available ? null : 'fixture_no_binding',
        by_playable_id: bindings,
      },
    });
  }
  if (scenario === 'unauthorized' && (
    url.pathname === '/api/me'
    || url.pathname === '/api/daily/sync'
    || url.pathname === '/api/challenges/inbox'
  )) {
    scenarios.unauthorized.postRejectionRequests.push(url.pathname);
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') {
    if (!scenario) return json(response, { code: 'fixture_identity_missing' }, 401);
    const body = await bodyOf(request);
    const state = scenarios[scenario];
    state.cpEvents.push(...body.events);
    if (scenario === 'staged' && !state.projectionHeld
      && body.events.some((event) => event.event_name === 'builtin_feed_decision')) {
      state.projectionHeld = true;
      state.projectionPending = true;
      await new Promise((resolve) => { state.projectionRelease = resolve; });
      state.projectionPending = false;
      state.projectionRelease = null;
    }
    return json(response, {
      events: body.events.map((event, item_index) => ({
        event_id: event.event_id,
        item_index,
        status: 'projected',
        reject_reason: null,
      })),
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/feed/generated-offer') {
    if (!scenario) return json(response, { code: 'fixture_identity_missing' }, 401);
    const body = await bodyOf(request);
    scenarios[scenario].generatedOfferRequests.push({
      atMs: Date.now() - scenarios[scenario].startedAt,
      body,
    });
    return json(response, {
      schema: 'feed.generated-offer-result.v1',
      requestId: body.requestId,
      outcome: 'no_offer',
      selectionMode: null,
      selectionReason: null,
      allocation: null,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    return json(response, { code: 'daily_not_configured' }, 404);
  }
  if (url.pathname === '/versions.json') return json(response, {});
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
    VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
    VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
    VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'false',
    VITE_CATALOG_DOGFOOD_USER_ID: String(userId),
  },
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  assert.fail(`${build.stdout}\n${build.stderr}`);
}

const initDataFor = (scenario) => new URLSearchParams({
  query_id: `timing-${scenario}`,
  harness_scenario: scenario,
  user: JSON.stringify({ id: userId }),
  hash: 'timing-browser',
}).toString();

const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${message}\n${JSON.stringify(scenarios, null, 2)}`);
};

const browser = await chromium.launch();
try {
  const openScenario = async (scenario, virtualClock = false) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    if (virtualClock) await page.clock.install();
    const initData = initDataFor(scenario);
    await page.addInitScript(({ id, data }) => {
      window.__telegramCloseCount = 0;
      window.Telegram = { WebApp: {
        initData: data,
        initDataUnsafe: { user: { id }, start_param: null },
        platform: 'web',
        ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
        setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
        close() { window.__telegramCloseCount += 1; },
      } };
    }, { id: userId, data: initData });
    scenarios[scenario].startedAt = Date.now();
    await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  const delayedPage = await openScenario('delayed');
  await delayedPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  assert.ok(Date.now() - scenarios.delayed.startedAt < 3500,
    'the built-in must become interactive before the deliberately delayed session binding');
  await waitFor(
    () => scenarios.delayed.generatedOfferRequests.length === 1,
    10000,
    'session bootstrap did not start request-id-only generated discovery',
  );
  assert.equal(await delayedPage.locator(`iframe[title="${playableId}"]`).count(), 1,
    'background authority must leave the already-visible built-in interactive');
  // Navigation is not an opportunity source. It must remain fluid while the
  // detached selector retains its own bounded retry lifecycle.
  const delayedSwipeSurface = delayedPage.locator('.page--in-viewport .game__autoplay');
  const delayedSwipeBox = await delayedSwipeSurface.boundingBox();
  assert.ok(delayedSwipeBox, 'current delayed-scenario swipe surface is missing');
  const delayedSwipeX = delayedSwipeBox.x + delayedSwipeBox.width / 2;
  await delayedPage.mouse.move(delayedSwipeX, delayedSwipeBox.y + delayedSwipeBox.height * 0.85);
  await delayedPage.mouse.down();
  await delayedPage.mouse.move(
    delayedSwipeX,
    delayedSwipeBox.y + delayedSwipeBox.height * 0.15,
    { steps: 8 },
  );
  await delayedPage.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(scenarios.delayed.generatedOfferRequests.length, 1,
    'navigation must not mint another generated-offer request');
  const delayedDecisionEvents = scenarios.delayed.cpEvents.filter(
    (event) => event.event_name === 'builtin_feed_decision',
  );
  assert.equal(delayedDecisionEvents.length, 1,
    'background discovery must not synthesize an impression-less built-in decision');
  assert.equal(
    scenarios.delayed.cpEvents.filter((event) => event.event_name === 'unit_impression').length,
    1,
    'the additive selector must not invent a visible built-in impression',
  );
  await delayedPage.close();

  // Exercise the real Feed lifecycle beyond both former 15s stage boundaries.
  // Neither a cold session nor a held control-plane projection may withhold the
  // built-in iframe; generated discovery is an independent background concern.
  const stagedPage = await openScenario('staged', true);
  await waitFor(
    () => scenarios.staged.sessionPending,
    2000,
    'staged session request did not reach the held fixture response',
  );
  await stagedPage.clock.fastForward(20_000);
  assert.equal(scenarios.staged.generatedOfferRequests.length, 0,
    'cold session bootstrap must not start discovery before authentication resolves');
  assert.equal(await stagedPage.locator(`iframe[title="${playableId}"]`).count(), 1,
    'cold session bootstrap must leave the current built-in interactive');
  scenarios.staged.sessionRelease();
  await stagedPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  await waitFor(
    () => scenarios.staged.generatedOfferRequests.length === 1,
    10000,
    'resolved session did not start source-independent generated discovery',
  );
  assert.equal(await stagedPage.locator(`iframe[title="${playableId}"]`).count(), 1,
    'initial additive opportunity must leave the unbound Merge frame interactive');
  await stagedPage.clock.fastForward(500);
  const swipeSurface = stagedPage.locator('.page--in-viewport .game__autoplay');
  const swipeBox = await swipeSurface.boundingBox();
  assert.ok(swipeBox, 'current built-in swipe surface is missing');
  const swipeX = swipeBox.x + swipeBox.width / 2;
  // Cross half a page deliberately. Before the navigation-source fix this made
  // the fractional visual position round to the target, so goTo() skipped the
  // source exit and the target decision even though the UI visibly advanced.
  await stagedPage.mouse.move(swipeX, swipeBox.y + swipeBox.height * 0.85);
  await stagedPage.mouse.down();
  await stagedPage.mouse.move(swipeX, swipeBox.y + swipeBox.height * 0.15, { steps: 8 });
  await stagedPage.mouse.up();
  await waitFor(
    () => scenarios.staged.projectionPending,
    3000,
    'mapped Sort navigation did not reach the held control-plane projection',
  );
  const stagedDecision = scenarios.staged.cpEvents.findLast(
    (event) => event.event_name === 'builtin_feed_decision',
  );
  assert.equal(stagedDecision?.payload?.mapping_id, stagedBinding.mapping_id,
    'only the mapped Sort opportunity enters the staged authority path');
  await stagedPage.clock.fastForward(20_000);
  assert.ok(scenarios.staged.generatedOfferRequests.length >= 1
    && scenarios.staged.generatedOfferRequests.length <= 3,
  'held source projection may overlap only the selector\'s bounded timer retries');
  assert.equal(await stagedPage.locator(`iframe[title="${stagedPlayableId}"]`).count(), 1,
    'held source projection must not withhold the navigated built-in frame');
  scenarios.staged.projectionRelease();
  await stagedPage.clock.fastForward(500);
  await waitFor(
    () => scenarios.staged.cpEvents.some((event) => event.event_name === 'unit_impression'),
    3000,
    'delayed projection did not produce its exact built-in impression',
  );
  assert.ok(scenarios.staged.generatedOfferRequests.length <= 3,
    'released projection may overlap only the selector timer retry, not mint an unbounded opportunity');
  assert.equal(await stagedPage.locator(`iframe[title="${stagedPlayableId}"]`).count(), 1,
    'detached generated discovery must not replace the navigated built-in');
  assert.equal(
    scenarios.staged.cpEvents.filter((event) => event.event_name === 'unit_impression').length,
    1,
    'late binding and projection still emit one honest built-in impression',
  );
  await stagedPage.close();

  const noBindingPage = await openScenario('no-binding');
  await noBindingPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  assert.ok(Date.now() - scenarios['no-binding'].startedAt < 3000,
    'an authoritative unavailable binding document must restore builtin immediately');
  await waitFor(
    () => scenarios['no-binding'].generatedOfferRequests.length === 1,
    10000,
    'source-independent selector must not depend on a reviewed builtin binding',
  );
  assert.deepEqual(
    Object.keys(scenarios['no-binding'].generatedOfferRequests[0].body).sort(),
    ['requestId', 'schema'],
    'generated discovery sends only its replay identity',
  );
  assert.equal(
    scenarios['no-binding'].cpEvents.filter((event) => event.event_name === 'unit_impression').length,
    0,
    'unbound fallback cannot invent a control-plane impression',
  );
  await noBindingPage.close();

  const unauthorizedPage = await openScenario('unauthorized');
  await unauthorizedPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  await waitFor(
    () => scenarios.unauthorized.sessionRequests === 1,
    1000,
    'the rejected Telegram bootstrap request did not start',
  );
  // Race foreground with the still-pending /session request. Once that shared
  // request settles as 401, no other authenticated endpoint may be attempted.
  await unauthorizedPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await unauthorizedPage.waitForSelector('.session-auth-banner', { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 2300));
  await unauthorizedPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(scenarios.unauthorized.sessionRequests, 1,
    'one rejected signed credential must not trigger startup or foreground retry storms');
  assert.equal(scenarios.unauthorized.generatedOfferRequests.length, 0,
    'catalog discovery must remain disabled when Telegram authentication failed');
  assert.deepEqual(scenarios.unauthorized.postRejectionRequests, [],
    'a foreground race must not fall through into other authenticated APIs after /session rejects');
  assert.match(await unauthorizedPage.locator('.session-auth-banner').innerText(),
    /Generated-content|Generated-/,
    'the fallback feed must explain why generated content is unavailable');
  const closeButton = unauthorizedPage.locator('.session-auth-banner button');
  assert.equal(await closeButton.count(), 1, 'the auth notice must expose one recovery action');
  await unauthorizedPage.evaluate(() => {
    window.__telegramCloseCount = 0;
    window.Telegram.WebApp.close = () => { window.__telegramCloseCount += 1; };
  });
  await closeButton.click();
  assert.equal(await unauthorizedPage.evaluate(() => window.__telegramCloseCount), 1,
    'the recovery action must ask Telegram to close the stale WebView');
  await unauthorizedPage.close();

  const outsideTelegramPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await outsideTelegramPage.goto(origin, { waitUntil: 'domcontentloaded' });
  await outsideTelegramPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await outsideTelegramPage.locator('.session-auth-banner').count(), 0,
    'an unauthenticated browser/AppLovin fallback must not claim Telegram rejected a signed session');
  await outsideTelegramPage.close();

  console.log('catalog authority timing browser: builtin swipe stays interactive through late binding/projection');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
