import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binding = {
  mapping_id: '10000000-0000-4000-8000-000000000001',
  playable_id: 'merge-locked-v1-swipe',
  variant_id: '20000000-0000-4000-8000-000000000002',
  catalog_mechanic: 'merge/locked',
  mechanic_family: 'merge',
  mapping_version: 'browser-fixture.v1',
  mapping_digest: 'a'.repeat(64),
};
const stalledBinding = {
  mapping_id: '10000000-0000-4000-8000-000000000003',
  playable_id: 'marble-sort-swipe',
  variant_id: '20000000-0000-4000-8000-000000000004',
  catalog_mechanic: 'sort/marble',
  mechanic_family: 'sort',
  mapping_version: 'browser-fixture.v1',
  mapping_digest: 'b'.repeat(64),
};
const replacementBinding = {
  ...binding,
  mapping_id: '10000000-0000-4000-8000-000000000005',
  variant_id: '20000000-0000-4000-8000-000000000006',
  mapping_version: 'browser-fixture.v2',
  mapping_digest: 'c'.repeat(64),
};
const challengeId = '30000000-0000-4000-8000-000000000007';
const challengeVariantId = '20000000-0000-4000-8000-000000000008';
const challenge = {
  id: challengeId,
  mechanic_id: binding.playable_id,
  variant_id: challengeVariantId,
  metric_key: 'time_ms',
  challenger_value: 1500,
  status: 'open',
  challenger: { id: 99, first_name: 'Fixture', username: null },
};

const cpEvents = [];
const cpEventBatches = [];
const ticketRequests = [];
const requestLog = [];
let origin = '';
let runStartFailuresRemaining = 100;
let sessionRequests = 0;
let delayedDailySync = true;

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const fakePlayable = `<!doctype html><html><body><canvas></canvas><script>
const id='merge-locked-v1-swipe';
const send=(type,extra={})=>parent.postMessage({source:'playable',id,type,...extra},'*');
addEventListener('message',(event)=>{
  const data=event.data||{};
  if(data.target!=='playable-swipe')return;
  if(data.type==='prepareInteractive')setTimeout(()=>send('interactive_ready'),0);
});
addEventListener('load',()=>send('static_ready'));
window.triggerAcceptedAction=()=>{
  send('manual_action',{actionType:'fixture.accepted',actionSeq:1,accepted:true,changedState:true});
};
window.triggerLoss=()=>send('completed',{outcome:'lost'});
</script></body></html>`;
const stalledPlayable = `<!doctype html><html><body><script>
const id='marble-sort-swipe';
addEventListener('load',()=>parent.postMessage({source:'playable',id,type:'static_ready'},'*'));
// Deliberately never acknowledges prepareInteractive: the feed may issue this
// candidate, but it must never record an impression for it.
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  requestLog.push(`${request.method} ${url.pathname}`);
  if (request.method === 'POST' && url.pathname === '/api/session') {
    const currentBinding = sessionRequests++ === 0 ? binding : replacementBinding;
    return json(response, {
      user: { id: 42, ref_code: 'fixture' },
      ref_code: 'fixture',
      balance: 0,
      puzzles: 0,
      is_new: false,
      backend_version: 'browser-fixture',
      builtin_feed_bindings: {
        schema: 'feed.builtin-bindings.v1',
        available: true,
        unavailable_reason: null,
        by_playable_id: {
          [binding.playable_id]: currentBinding,
          [stalledBinding.playable_id]: stalledBinding,
        },
      },
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') {
    assert.match(String(request.headers.authorization), /^tma /);
    const body = await bodyOf(request);
    cpEventBatches.push(body.events);
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
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    if (delayedDailySync) {
      delayedDailySync = false;
      // Hold the opaque-preloader observation window open long enough for a
      // contended headless browser to finish its initial iframe warm-up.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return json(response, { detail: 'not configured in fixture' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/start') {
    const ticket = await bodyOf(request);
    ticketRequests.push(ticket);
    if (runStartFailuresRemaining > 0) {
      runStartFailuresRemaining -= 1;
      return json(response, { detail: 'retry fixture' }, 503);
    }
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
  if (request.method === 'POST' && url.pathname === '/api/results') {
    return json(response, { is_best: true, stars_awarded: 0, balance: 0, puzzle_balance: 0 });
  }
  if (request.method === 'GET' && url.pathname === `/api/challenges/${challengeId}`) {
    return json(response, challenge);
  }
  if (request.method === 'POST' && url.pathname === `/api/challenges/${challengeId}/accept`) {
    return json(response, challenge);
  }
  if (url.pathname === '/versions.json') return json(response, {});
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname.endsWith('.html')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(url.pathname.includes('marble-sort-swipe') ? stalledPlayable : fakePlayable);
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

const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VITE_API_BASE: origin,
    VITE_CONTROL_PLANE_ENABLED: 'true',
  },
  timeout: 120_000,
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.addInitScript(() => {
    window.__fixtureHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => window.__fixtureHidden,
    });
    window.Telegram = {
      WebApp: {
        initData: `query_id=fixture&user=${encodeURIComponent(JSON.stringify({ id: 42 }))}&hash=fixture`,
        initDataUnsafe: { user: { id: 42 }, start_param: null },
        platform: 'web',
        ready() {}, expand() {}, disableVerticalSwipes() {}, setHeaderColor() {},
        setBackgroundColor() {}, lockOrientation() {}, onEvent() {},
      },
    };
  });
  const initData = `query_id=fixture&user=${encodeURIComponent(JSON.stringify({ id: 42 }))}&hash=fixture`;
  await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')]
    .some((frame) => frame.title === 'merge-locked-v1-swipe'));
  await page.waitForFunction(() => document.querySelector('.game--ready'));
  const frame = page.frames().find((candidate) => candidate.url().includes('merge-locked-v1-swipe.html'));
  assert.ok(frame, 'first built-in iframe mounted');

  // The server mapping can arrive while the full-screen preloader still owns
  // the viewport. That is an issued decision, not a seen unit; active dwell is
  // not allowed to start behind the cover.
  // Same-origin fixture requests can temporarily occupy all HTTP/1 sockets;
  // inspect the durable local queue as well as delivered events.
  for (let retry = 0; retry < 30; retry += 1) {
    const delivered = cpEvents.some((event) => event.event_name === 'builtin_feed_decision');
    const durable = await page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith('swipe_control_plane_outbox_v2:'))
      .flatMap(([, value]) => JSON.parse(value || '{}').pending ?? [])
      .some((event) => event.event_name === 'builtin_feed_decision'));
    if (delivered || durable) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const earlyDebug = await page.evaluate(() => ({
    preloaderClass: document.querySelector('.preloader')?.className ?? null,
    storage: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
  }));
  const durableEarlyEvents = Object.entries(earlyDebug.storage)
    .filter(([key]) => key.startsWith('swipe_control_plane_outbox_v2:'))
    .flatMap(([, value]) => JSON.parse(value || '{}').pending ?? []);
  const earlyNames = [...cpEvents, ...durableEarlyEvents].map((event) => event.event_name);
  assert.ok(
    earlyNames.includes('builtin_feed_decision'),
    `decision did not flush while preloader was visible: ${requestLog.join(', ')} ${JSON.stringify(earlyDebug)}`,
  );
  assert.equal(earlyNames.includes('unit_impression'), false);
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('.preloader:not(.preloader--hidden)'))),
    true,
    'opaque preloader still owns the viewport',
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const queuedAfterDelay = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('swipe_control_plane_outbox_v2:'))
    .flatMap(([, value]) => JSON.parse(value || '{}').pending ?? [])
    .map((event) => event.event_name));
  assert.equal(
    [...cpEvents.map((event) => event.event_name), ...queuedAfterDelay].includes('unit_impression'),
    false,
  );
  await page.waitForFunction(() => !document.querySelector('.preloader'), null, { timeout: 5000 });
  for (let retry = 0; retry < 30
    && !cpEvents.some((event) => event.event_name === 'unit_impression');
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(cpEvents.some((event) => event.event_name === 'unit_impression'));

  // Refresh the reviewed map while the first exposure is already issued. The
  // global map moves to v2, but this exposure and its future ticket must remain
  // frozen on the v1 decision identity.
  await page.evaluate(() => {
    window.__fixtureHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.__fixtureHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let retry = 0; retry < 40 && sessionRequests < 2; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(sessionRequests >= 2, 'foreground refresh fetched replacement mapping');

  await page.evaluate(() => window.__feedHostGesture('merge-locked-v1-swipe'));
  await page.waitForTimeout(50);
  await frame.evaluate(() => window.triggerAcceptedAction());
  await page.waitForTimeout(120);
  await frame.evaluate(() => window.triggerLoss());
  for (let retry = 0; retry < 40
    && !cpEvents.some((event) => event.event_name === 'attempt_result');
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!cpEvents.some((event) => event.event_name === 'attempt_result')) {
    const localState = await page.evaluate(() => Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.includes('control_plane') || key.includes('run_ticket'))
        .map((key) => [key, localStorage.getItem(key)]),
    ));
    assert.fail(`attempt chain did not flush: ${JSON.stringify(localState)}`);
  }

  // A BFCache round-trip pauses and resumes the same exposure/run. It must not
  // manufacture a close/reopen pair or strand the frame host-paused.
  const pausesBeforeBfcache = cpEvents.filter((event) => event.event_name === 'session_pause').length;
  const resumesBeforeBfcache = cpEvents.filter((event) => event.event_name === 'session_resume').length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.waitForTimeout(50);
  assert.equal(cpEvents.some((event) => event.event_name === 'unit_exit'), false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(100);
  assert.equal(
    cpEvents.filter((event) => event.event_name === 'session_pause').length,
    pausesBeforeBfcache + 1,
  );
  assert.equal(
    cpEvents.filter((event) => event.event_name === 'session_resume').length,
    resumesBeforeBfcache + 1,
  );

  // Commit navigation to a candidate that never reaches interactive_ready.
  // The decision is issued at commit, the source exits as a swipe, and the
  // stalled target must never become an impression.
  await page.locator('.game--show-close .game__close').click();
  for (let retry = 0; retry < 30 && !cpEvents.some((event) => event.event_name === 'unit_exit'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (let retry = 0; retry < 30
    && cpEvents.filter((event) => event.event_name === 'builtin_feed_decision').length < 2;
    retry += 1) await new Promise((resolve) => setTimeout(resolve, 50));

  const names = cpEvents.map((event) => event.event_name);
  for (const required of [
    'builtin_feed_decision',
    'unit_impression',
    'builtin_level_impression',
    'attempt_start',
    'manual_action',
    'attempt_result',
    'unit_exit',
  ]) assert.ok(
    names.includes(required),
    `missing ${required}: ${names.join(', ')}; requests=${requestLog.join(', ')}`,
  );

  const decision = cpEvents.find((event) => event.event_name === 'builtin_feed_decision');
  const impression = cpEvents.find((event) => event.event_name === 'unit_impression');
  const level = cpEvents.find((event) => event.event_name === 'builtin_level_impression');
  const attempt = cpEvents.find((event) => event.event_name === 'attempt_start');
  const action = cpEvents.find((event) => event.event_name === 'manual_action');
  const result = cpEvents.find((event) => event.event_name === 'attempt_result');
  const exit = cpEvents.find((event) => event.event_name === 'unit_exit');

  assert.deepEqual(Object.keys(decision.payload).sort(), ['decision_id', 'feed_position', 'mapping_id']);
  assert.equal(decision.payload.mapping_id, binding.mapping_id);
  assert.equal(impression.payload.decision_id, decision.payload.decision_id);
  assert.equal(level.payload.impression_id, impression.payload.impression_id);
  assert.equal('level_spec_hash' in level.payload, false);
  assert.equal(attempt.payload.level_impression_id, level.payload.level_impression_id);
  assert.equal(action.payload.run_id, attempt.payload.run_id);
  assert.equal(action.payload.level_impression_id, level.payload.level_impression_id);
  assert.equal(action.payload.accepted, true);
  assert.equal(action.payload.changed_state, true);
  assert.equal(result.payload.run_id, attempt.payload.run_id);
  assert.equal(result.payload.outcome, 'lose');
  assert.equal(exit.payload.impression_id, impression.payload.impression_id);
  assert.equal(exit.payload.reason, 'swipe');
  assert.equal(exit.payload.dwell_censored, false);
  assert.ok(exit.payload.dwell_active_ms >= 50, `unexpected dwell ${exit.payload.dwell_active_ms}`);
  const decisions = cpEvents.filter((event) => event.event_name === 'builtin_feed_decision');
  const impressions = cpEvents.filter((event) => event.event_name === 'unit_impression');
  assert.equal(decisions.length, 2, 'source and stalled target were both issued');
  assert.equal(impressions.length, 1, 'only the revealed source was seen');
  assert.equal(decisions[1].payload.mapping_id, stalledBinding.mapping_id);
  assert.equal(
    impressions.some((event) => event.payload.decision_id === decisions[1].payload.decision_id),
    false,
    'stalled target has no impression',
  );

  // The first /runs/start was a 503 after its intent had been persisted. A
  // fresh document must recover and retry the exact same ticket before any new
  // interaction creates another one.
  assert.ok(ticketRequests.length >= 1);
  const persistedTicket = ticketRequests[0];
  const attemptsBeforeReload = ticketRequests.length;
  assert.ok(
    ticketRequests.every((ticket) => JSON.stringify(ticket) === JSON.stringify(persistedTicket)),
    'all pre-reload retries preserve exact ticket identity',
  );
  runStartFailuresRemaining = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (let retry = 0; retry < 40 && ticketRequests.length === attemptsBeforeReload; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ticketRequests.length > attemptsBeforeReload, 'reload recovered pending run start');
  assert.deepEqual(
    ticketRequests[attemptsBeforeReload],
    persistedTicket,
    'reload retry preserves exact ticket identity',
  );
  assert.equal(persistedTicket.variant_id, binding.variant_id);

  // Every individual outbox request is ordered. Across a document reload, an
  // in-flight request owned by the old page may complete after the replacement
  // page has retried the same durable envelopes; the causal inbox deliberately
  // accepts that at-least-once permutation. Prove exact retry identity and a
  // contiguous logical sequence instead of imposing an impossible global wire
  // order across two document lifetimes.
  for (const batch of cpEventBatches) {
    const batchSeq = batch
      .filter((event) => event.client_instance_id === decision.client_instance_id)
      .map((event) => event.seq);
    assert.deepEqual(
      batchSeq,
      [...batchSeq].sort((left, right) => left - right),
      'each wire batch preserves client seq order',
    );
  }
  const uniqueEvents = new Map();
  for (const event of cpEvents.filter(
    (candidate) => candidate.client_instance_id === decision.client_instance_id,
  )) {
    const original = uniqueEvents.get(event.event_id);
    if (original) assert.deepEqual(event, original, 'reload retries the exact immutable envelope');
    else uniqueEvents.set(event.event_id, event);
  }
  const seq = [...uniqueEvents.values()].map((event) => event.seq).sort((left, right) => left - right);
  assert.deepEqual(
    seq,
    Array.from({ length: seq.length }, (_, index) => index),
    'durable logical sequence is contiguous without identity loss',
  );

  // A challenge landing is a forced social slot, not a built-in feed choice.
  // Its immutable variant may differ from today's mapping: it must create a
  // challenge-bound ticket and zero false builtin decisions/impressions.
  await page.waitForTimeout(150);
  const builtinBeforeChallenge = cpEvents.filter((event) =>
    event.event_name === 'builtin_feed_decision' || event.event_name === 'unit_impression').length;
  const ticketsBeforeChallenge = ticketRequests.length;
  await page.goto(
    `${origin}/?initData=${encodeURIComponent(initData)}&c=${challengeId}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => document.querySelector('.game--ready'));
  await page.waitForTimeout(200);
  assert.equal(
    cpEvents.filter((event) =>
      event.event_name === 'builtin_feed_decision' || event.event_name === 'unit_impression').length,
    builtinBeforeChallenge,
    'challenge landing is excluded from builtin attribution',
  );
  const challengeFrame = page.frames().find((candidate) => candidate.url().includes('merge-locked-v1-swipe.html'));
  assert.ok(challengeFrame, 'challenge mechanic mounted');
  await page.evaluate(() => window.__feedHostGesture('merge-locked-v1-swipe'));
  await challengeFrame.evaluate(() => window.triggerAcceptedAction());
  let challengeTicket = ticketRequests
    .slice(ticketsBeforeChallenge)
    .find((ticket) => ticket.challenge_id === challengeId);
  for (let retry = 0; retry < 40 && !challengeTicket; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    challengeTicket = ticketRequests
      .slice(ticketsBeforeChallenge)
      .find((ticket) => ticket.challenge_id === challengeId);
  }
  assert.ok(challengeTicket, 'challenge action created its own bound ticket');
  assert.equal(challengeTicket.challenge_id, challengeId);
  assert.equal(challengeTicket.variant_id, challengeVariantId);
  assert.equal(
    cpEvents.filter((event) =>
      event.event_name === 'builtin_feed_decision' || event.event_name === 'unit_impression').length,
    builtinBeforeChallenge,
    'challenge action remains outside builtin evidence',
  );

  console.log(`control-plane feed browser: ${cpEvents.length} events; identity/lifecycle recovery verified`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
