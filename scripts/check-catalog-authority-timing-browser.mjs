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
const binding = {
  mapping_id: '10000000-0000-4000-8000-000000000001',
  playable_id: playableId,
  variant_id: '20000000-0000-4000-8000-000000000002',
  catalog_mechanic: 'merge/locked',
  mechanic_family: 'merge',
  mapping_version: 'timing-browser.v1',
  mapping_digest: 'a'.repeat(64),
};
const scenarios = {
  delayed: { startedAt: 0, sessionRequests: 0, authorityRequests: [], cpEvents: [] },
  'no-binding': { startedAt: 0, sessionRequests: 0, authorityRequests: [], cpEvents: [] },
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

const fakePlayable = `<!doctype html><html><body><canvas></canvas><script>
const id=${JSON.stringify(playableId)};
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
    if (scenario === 'delayed' && state.sessionRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 4200));
    }
    const available = scenario === 'delayed';
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
        by_playable_id: available ? { [playableId]: binding } : {},
      },
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') {
    if (!scenario) return json(response, { code: 'fixture_identity_missing' }, 401);
    const body = await bodyOf(request);
    scenarios[scenario].cpEvents.push(...body.events);
    return json(response, {
      events: body.events.map((event, item_index) => ({
        event_id: event.event_id,
        item_index,
        status: 'projected',
        reject_reason: null,
      })),
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/feed/catalog-authority') {
    if (!scenario) return json(response, { code: 'fixture_identity_missing' }, 401);
    const body = await bodyOf(request);
    scenarios[scenario].authorityRequests.push({ atMs: Date.now() - scenarios[scenario].startedAt, body });
    return json(response, {
      schema: 'feed.catalog-authority-result.v1',
      requestId: body.requestId,
      sourceDecisionId: body.sourceDecisionId,
      planId: '30000000-0000-4000-8000-000000000003',
      planDigest: 'b'.repeat(64),
      outcome: 'builtin_fallback',
      authorizationId: null,
      authorizationDigest: null,
      expiresAt: null,
      fallback: {
        mappingId: binding.mapping_id,
        playableId: binding.playable_id,
        variantId: binding.variant_id,
        catalogMechanic: binding.catalog_mechanic,
      },
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
    return response.end(fakePlayable);
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
  assert.fail(message);
};

const browser = await chromium.launch();
try {
  const openScenario = async (scenario, virtualClock = false) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    if (virtualClock) await page.clock.install();
    const initData = initDataFor(scenario);
    await page.addInitScript(({ id, data }) => {
      window.Telegram = { WebApp: {
        initData: data,
        initDataUnsafe: { user: { id }, start_param: null },
        platform: 'web',
        ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
        setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
      } };
    }, { id: userId, data: initData });
    scenarios[scenario].startedAt = Date.now();
    await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  const delayedPage = await openScenario('delayed');
  await waitFor(
    () => scenarios.delayed.authorityRequests.length === 1,
    12_000,
    'authority did not start after the >3.5s delayed binding',
  );
  assert.ok(scenarios.delayed.authorityRequests[0].atMs >= 3500,
    'fixture must reproduce binding later than the former timeout');
  assert.ok(scenarios.delayed.authorityRequests[0].atMs < 65_000,
    'delayed binding must still fit inside the new bootstrap budget');
  await delayedPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 8000 });
  await waitFor(
    () => scenarios.delayed.cpEvents.some((event) => event.event_name === 'unit_impression'),
    8000,
    'server fallback did not produce the exact built-in impression',
  );
  assert.equal(
    scenarios.delayed.cpEvents.filter((event) => event.event_name === 'unit_impression').length,
    1,
    'delayed authority fallback produces exactly one built-in impression',
  );
  await delayedPage.close();

  const noBindingPage = await openScenario('no-binding', true);
  await waitFor(
    () => scenarios['no-binding'].sessionRequests >= 1,
    2000,
    'no-binding session bootstrap did not settle',
  );
  await noBindingPage.clock.fastForward(20_000);
  assert.equal(await noBindingPage.locator(`iframe[title="${playableId}"]`).count(), 0,
    'missing binding cannot fall back after 20s of a cold-start-safe bootstrap');
  await noBindingPage.clock.fastForward(45_100);
  await noBindingPage.waitForSelector(`iframe[title="${playableId}"]`, { timeout: 3000 });
  assert.equal(scenarios['no-binding'].authorityRequests.length, 0,
    'missing binding cannot call authority without a durable source decision');
  assert.equal(
    scenarios['no-binding'].cpEvents.filter((event) => event.event_name === 'unit_impression').length,
    0,
    'unbound fallback cannot invent a control-plane impression',
  );
  await noBindingPage.close();

  console.log('catalog authority timing browser: delayed binding and no-binding fallback passed');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
