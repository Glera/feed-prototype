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
      { version: 'roster-browser', mountCost: 'light' },
    ]), [challengePlayableId, { version: 'roster-browser', mountCost: 'light' }]]));
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
  await page.close();

  // A challenge is a forced social slot, not part of the default roster. A
  // roster which omits its mechanic must not invalidate the issued deep link.
  const challengeContext = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const challengePage = await challengeContext.newPage();
  await challengePage.addInitScript(({ data, snapshot, challengeStart }) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: challengeStart },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
    localStorage.setItem('swipe_feed_roster_next_session_v1', JSON.stringify(snapshot));
  }, { data: initData, snapshot: initialRoster, challengeStart: challengeId });
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
  initialRoster.entries[0].playableId, { timeout: 5000 });
  let rosterV2 = cpEvents.slice(challengeEventOffset).find((event) =>
    event.event_name === 'builtin_feed_decision_v2');
  for (let retry = 0; retry < 80 && !rosterV2; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    rosterV2 = cpEvents.slice(challengeEventOffset).find((event) =>
      event.event_name === 'builtin_feed_decision_v2');
  }
  assert.ok(rosterV2, 'the first default roster unit after challenge emits CP v2');
  assert.equal(rosterV2.payload.mapping_id, initialRoster.entries[0].builtinMappingId);
  assert.equal(rosterV2.payload.roster_activation_id, initialRoster.activationId);
  await challengeContext.close();

  console.log('feed roster browser: next-session order, forced challenge isolation and CP v2 verified');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
