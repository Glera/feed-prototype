import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalFixturePath = path.resolve(
  root,
  '../swipe-backend/docs/specs/fixtures/feed-roster-session-v1.golden.json',
);
const fixture = JSON.parse(readFileSync(canonicalFixturePath, 'utf8'));
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
const cpEvents = [];
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
const send=(type)=>parent.postMessage({source:'playable',id,type},'*');
addEventListener('message',(event)=>{
  const data=event.data||{};
  if(data.target==='playable-swipe'&&data.type==='prepareInteractive')send('interactive_ready');
});
addEventListener('load',()=>send('static_ready'));
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
  if (request.method === 'POST' && url.pathname === '/api/events') return json(response, { ok: true });
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    return json(response, { code: 'daily_not_configured' }, 404);
  }
  if (url.pathname === '/versions.json') {
    return json(response, Object.fromEntries(initialRoster.entries.map((entry) => [
      entry.playableId,
      { version: 'roster-browser', mountCost: 'light' },
    ])));
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
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.addInitScript(({ data, snapshot }) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: null },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
    if (!sessionStorage.getItem('roster_browser_seeded')) {
      localStorage.setItem('swipe_feed_roster_next_session_v1', JSON.stringify(snapshot));
      sessionStorage.setItem('roster_browser_seeded', '1');
    }
  }, { data: initData, snapshot: initialRoster });

  await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`iframe[title="${initialRoster.entries[0].playableId}"]`, { timeout: 5000 });
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    initialRoster.entries[0].playableId,
    'the frozen startup snapshot owns the current session order',
  );
  await page.waitForFunction((activationId) => {
    const raw = localStorage.getItem('swipe_feed_roster_next_session_v1');
    return raw && JSON.parse(raw).activationId === activationId;
  }, nextRoster.activationId, { timeout: 5000 });
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    initialRoster.entries[0].playableId,
    'a newer /session activation cannot reorder the live ring',
  );
  for (let retry = 0; retry < 80
    && !cpEvents.some((event) => event.event_name === 'builtin_feed_decision_v2');
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const initialV2 = cpEvents.find((event) => event.event_name === 'builtin_feed_decision_v2');
  assert.ok(initialV2);
  assert.equal(initialV2.payload.roster_activation_id, initialRoster.activationId);
  assert.equal(initialV2.payload.mapping_id, initialRoster.entries[0].builtinMappingId);

  // The one-shot init seed is guarded by sessionStorage: reload consumes the
  // staged response rather than reinstalling the original fixture.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`iframe[title="${nextRoster.entries[0].playableId}"]`, { timeout: 5000 });
  assert.equal(
    await page.locator('.page--in-viewport iframe').getAttribute('title'),
    nextRoster.entries[0].playableId,
    'the staged activation applies on the next session load',
  );

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
  console.log('feed roster browser: frozen session order, next-session activation and CP v2 verified');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
