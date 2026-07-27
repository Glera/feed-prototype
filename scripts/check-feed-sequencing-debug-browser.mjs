/**
 * Browser regression for the read-only sequencing debug sub-screen (§12).
 *
 * The pure contract lives in check-feed-sequencing-debug.mjs; this check drives
 * the real production build in a browser against a fixture backend and pins the
 * behaviours a source-level guard cannot see: transport verbs and bodies over a
 * whole panel session, the generation fence on a subject/limit change, the
 * single non-leaking 404, server strings never becoming DOM, and a sub-screen
 * that neither stacks nor survives Close.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEBUG_PREFIX = '/api/feed/sequencing/debug';
const DEBUG_PATHS = [`${DEBUG_PREFIX}/profile`, `${DEBUG_PREFIX}/why-now`, `${DEBUG_PREFIX}/history`];
// One payload, reused in every server-owned string a tab renders. If any of them
// is ever interpolated as markup this flips the flag or creates an <img>.
const XSS = '<img src=x onerror="window.__seqPwned=1">';
const SLOW_MS = 900;

let assertions = 0;
const ok = (value, message) => { assertions += 1; assert.ok(value, message); };
const eq = (actual, expected, message) => { assertions += 1; assert.equal(actual, expected, message); };

const EPOCH = {
  personalizationEpoch: 4,
  personalizationWatermark: '2026-07-20T08:00:00.000Z',
  exposuresEpoch: 2,
  exposuresWatermark: '2026-07-19T08:00:00.000Z',
  onboardingEpoch: 3,
};

const envelope = (schema, subjectUserId, sources = []) => ({
  schema,
  subjectUserId,
  readOnly: true,
  recomputed: false,
  sources,
});

const profileBody = (subjectUserId, familyMarker) => ({
  ...envelope('feed.debug-profile.v1', subjectUserId, [{
    kind: 'episode_materialization',
    id: '3c9f1c7a-2b44-4a51-9f0e-6d2c1b8a7e10',
    digest: 'a'.repeat(64),
    asOf: '2026-07-27T07:00:00.000Z',
  }]),
  snapshotAsOf: '2026-07-27T07:00:00.000Z',
  snapshotAgeSeconds: 3725,
  epoch: EPOCH,
  configs: null,
  profile: {
    schema: 'feed.family-profile-projection.v1',
    asOf: '2026-07-27T07:00:00.000Z',
    favoriteSet: [familyMarker],
    families: [{
      familyId: familyMarker,
      score: '0.910000000000',
      confidencePpm: 1000000,
      independentEpisodeCount: 3,
      satiation: '0.720000000000',
      state: XSS,
      favoriteEligible: true,
      inFavoriteSet: true,
      lastStrongTerminalAt: '2026-07-27T06:14:02.500Z',
    }],
  },
});

const whyNowBody = (subjectUserId) => ({
  ...envelope('feed.debug-why-now.v1', subjectUserId, []),
  planId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  chosenSlotType: XSS,
  chosenFamilyId: 'match',
  constraintConflict: true,
  coldStartPhase: false,
  snapshot: {
    schema: 'feed.sequence-plan-snapshot.v1',
    planId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
    runway: [{ familyId: 'match', eligibleUnseenSeries: 2 }],
    rejected: [{ slotType: 'exploration', familyId: 'sort', reason: 'no_runway', admitted: false }],
  },
  snapshotDigest: '4'.repeat(64),
});

const historyBody = (subjectUserId, marker, limit) => ({
  ...envelope('feed.debug-history.v1', subjectUserId, []),
  limit,
  units: [
    {
      decisionId: `decision-${marker}`,
      issuedAt: '2026-07-27T07:05:01.000Z',
      slotType: XSS,
      policyVersion: 'feed-policy-v3',
      arm: 'treatment',
      mechanicId: 'marble-sort-swipe',
      builtinMappingId: null,
      rosterActivationId: null,
      seen: true,
      impressionId: 'ff0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      revealedAt: '2026-07-27T07:05:03.250Z',
    },
    {
      decisionId: 'decision-unseen',
      issuedAt: '2026-07-27T07:04:40.000Z',
      slotType: 'exploration',
      policyVersion: 'feed-policy-v3',
      arm: 'control',
      mechanicId: 'pins',
      builtinMappingId: null,
      rosterActivationId: null,
      seen: false,
      impressionId: null,
      revealedAt: null,
    },
    {
      decisionId: 'decision-drift',
      issuedAt: '2026-07-27T07:04:00.000Z',
      slotType: 'exploration',
      policyVersion: 'feed-policy-v3',
      arm: 'control',
      mechanicId: 'pins',
      builtinMappingId: null,
      rosterActivationId: null,
      // Drift: neither a reveal nor an honest negative.
      seen: 'maybe',
      impressionId: null,
      revealedAt: null,
    },
  ],
  generatedOfferMisses: [],
  favoriteDeliveryMisses: [],
  resets: [{
    resetId: '220d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
    scope: XSS,
    effectiveAt: '2026-07-20T08:00:00.000Z',
    newEpoch: 4,
    receiptDigest: '9'.repeat(64),
  }],
});

const requests = [];
let mode = 'ok';
let origin = '';

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  let bodyBytes = 0;
  for await (const chunk of request) bodyBytes += chunk.length;
  requests.push({ method: request.method, pathname: url.pathname, search: url.search, bodyBytes });

  if (url.pathname.startsWith(DEBUG_PREFIX)) {
    if (mode === 'notfound') return json(response, { detail: 'not found' }, 404);
    const subject = url.searchParams.get('user_id');
    if (url.pathname.endsWith('/profile')) {
      // The subject-less read is the slow one: the panel issues it on mount and
      // the test replaces the subject while it is still in flight.
      if (subject === null) {
        await sleep(SLOW_MS);
        return json(response, profileBody('42', 'STALE-OWN-FAMILY'));
      }
      if (subject === '12345') return json(response, profileBody('54321', 'ECHO-MISMATCH-FAMILY'));
      return json(response, profileBody(subject, `FRESH-${subject}-FAMILY`));
    }
    if (url.pathname.endsWith('/why-now')) return json(response, whyNowBody(subject ?? '42'));
    if (url.pathname.endsWith('/history')) {
      const limit = Number(url.searchParams.get('limit'));
      if (limit === 20) {
        await sleep(SLOW_MS);
        return json(response, historyBody(subject ?? '42', 'STALE-LIMIT-20', limit));
      }
      return json(response, historyBody(subject ?? '42', `FRESH-LIMIT-${limit}`, limit));
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/session') {
    return json(response, {
      user: { id: 42, ref_code: 'sequencing-debug-browser' },
      ref_code: 'sequencing-debug-browser',
      balance: 0,
      puzzles: 0,
      is_new: false,
      backend_version: 'sequencing-debug-browser',
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') return json(response, { events: [] });
  if (request.method === 'POST' && url.pathname === '/api/events') return json(response, { ok: true });
  if (url.pathname === '/versions.json') return json(response, {});
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname.endsWith('.html')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end('<!doctype html><html><body></body></html>');
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
  timeout: 180_000,
  env: { ...process.env, VITE_API_BASE: origin },
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  assert.fail(`${build.stdout}\n${build.stderr}`);
}

const initData = new URLSearchParams({
  query_id: 'sequencing-debug-browser',
  user: JSON.stringify({ id: 42 }),
  hash: 'sequencing-debug-browser',
}).toString();

const debugRequests = (from = 0) =>
  requests.slice(from).filter((item) => item.pathname.startsWith(DEBUG_PREFIX));
const countOf = (pathname, from = 0) =>
  debugRequests(from).filter((item) => item.pathname === pathname).length;
const nonGetPaths = (from = 0) => new Set(
  requests.slice(from).filter((item) => item.method !== 'GET').map((item) => item.pathname),
);

const PANEL = '[data-panel="feed-sequencing-debug"]';
const BODY = `${PANEL} [data-seq-body]`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.addInitScript((data) => {
    window.Telegram = { WebApp: {
      initData: data,
      initDataUnsafe: { user: { id: 42 }, start_param: null },
      platform: 'web',
      ready() {}, expand() {}, disableVerticalSwipes() {}, lockOrientation() {},
      setHeaderColor() {}, setBackgroundColor() {}, onEvent() {},
    } };
  }, initData);

  const panel = page.locator(PANEL);
  const bodyText = () => page.locator(BODY).innerText();
  const waitForBody = (needle) => page.waitForFunction(
    (text) => (document.querySelector('[data-panel="feed-sequencing-debug"] [data-seq-body]')
      ?.textContent ?? '').includes(text),
    needle,
    { timeout: 15_000 },
  );
  /** Commit a control the way a user does: Enter fires the native change and
   *  clears the dirty flag, so a later blur cannot replay the same read. */
  const commit = async (selector, value) => {
    await page.fill(selector, value);
    await page.press(selector, 'Enter');
    await page.locator(selector).blur();
  };
  /** Sample the sub-screen while a superseded response is still in flight. */
  const sampleWhile = async (ms) => {
    const samples = [];
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      samples.push(await bodyText());
      await sleep(40);
    }
    return samples;
  };

  // ── session 1: served projections ─────────────────────────────────────────
  await page.goto(`${origin}/?diag=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-qa="feed-sequencing-open"]', { timeout: 20_000 });
  const sessionStart = requests.length;
  const preOpenNonGet = nonGetPaths(0);
  await page.click('[data-qa="feed-sequencing-open"]');
  await panel.waitFor({ timeout: 5_000 });

  // (2) generation fence: the subject changes while the mount read is in flight.
  await commit('[data-seq-input="subject"]', '777');
  await waitForBody('FRESH-777-FAMILY');
  const subjectSamples = await sampleWhile(SLOW_MS + 500);
  ok(
    subjectSamples.every((text) => !text.includes('STALE-OWN-FAMILY')),
    'a late response for the previous subject must never be painted',
  );
  ok(
    subjectSamples.every((text) => text.includes('FRESH-777-FAMILY')),
    'the current subject stays displayed while the superseded response lands',
  );
  const profileText = await bodyText();
  ok(profileText.includes('777'), 'the panel shows the server-echoed subject');

  // (4) server strings are text, never markup.
  eq(await page.evaluate(() => window.__seqPwned), undefined, 'a server string must not execute');
  eq(await panel.locator('img').count(), 0, 'a server string must not create DOM elements');
  ok(profileText.includes(XSS), 'the payload is displayed verbatim as text');

  // Why now: the stored snapshot stays reachable verbatim.
  await page.click('[data-seq-tab="why-now"]');
  await waitForBody('feed.sequence-plan-snapshot.v1');
  const whyNowText = await bodyText();
  ok(whyNowText.includes('raw snapshot'), 'why-now keeps a raw view of the stored bytes');
  ok(whyNowText.includes('snapshotDigest'), 'why-now shows the snapshot digest');
  eq(await page.evaluate(() => window.__seqPwned), undefined, 'why-now strings must not execute');

  // (2b) the limit control bumps the same fence.
  await page.click('[data-seq-tab="history"]');
  await commit('[data-seq-input="limit"]', '5');
  await waitForBody('decision-FRESH-LIMIT-5');
  const limitSamples = await sampleWhile(SLOW_MS + 500);
  ok(
    limitSamples.every((text) => !text.includes('decision-STALE-LIMIT-20')),
    'a late response for the previous limit must never be painted',
  );
  const historyText = await bodyText();
  ok(historyText.includes('seen ✓'), 'a seen unit is rendered as seen');
  ok(historyText.includes('issued, not seen'), 'an unseen issue stays an open chain');
  ok(historyText.includes('seen: unknown (drift)'), 'a non-boolean seen is drift, not a negative');

  // Reset: receipts plus the three current epoch scopes, still read-only.
  await page.click('[data-seq-tab="reset"]');
  await waitForBody('reset receipts');
  const resetText = await bodyText();
  for (const scope of ['personalization', 'exposures', 'onboarding']) {
    ok(resetText.includes(scope), `the reset tab names the ${scope} epoch scope`);
  }
  ok(resetText.includes('epoch=4'), 'the current personalization epoch is shown');
  ok(resetText.includes('operator CLI act'), 'the reset tab states where the reset act lives');
  eq(
    await page.locator(`${BODY} button`).filter({ hasText: /reset/i }).count(),
    0,
    'the reset tab offers no reset control',
  );

  // (3b) a subject echo mismatch is surfaced, and the server value still wins.
  await commit('[data-seq-input="subject"]', '12345');
  await page.click('[data-seq-tab="profile"]');
  await waitForBody('ECHO-MISMATCH-FAMILY');
  const echoText = await bodyText();
  ok(
    echoText.includes('server echoed subjectUserId 54321 for requested user_id 12345'),
    'a subject the server did not read is flagged',
  );
  ok(echoText.includes('54321'), 'the displayed subject is the server echo');

  // (1) the whole session: GET only, no bodies, only the three debug paths.
  const sessionDebug = debugRequests(sessionStart);
  ok(sessionDebug.length >= 5, 'the session actually exercised the projections');
  for (const item of sessionDebug) {
    eq(item.method, 'GET', `${item.pathname} must be read with GET`);
    eq(item.bodyBytes, 0, `${item.pathname} must carry no request body`);
    ok(DEBUG_PATHS.includes(item.pathname), `${item.pathname} is not one of the three projections`);
  }
  for (const pathname of nonGetPaths(sessionStart)) {
    ok(
      preOpenNonGet.has(pathname),
      `driving the sub-screen introduced a new state-changing call to ${pathname}`,
    );
  }

  // (5) a second open replaces the screen instead of stacking another overlay.
  await page.click('[data-seq-action="close"]');
  eq(await panel.count(), 0, 'Close removes the sub-screen');
  // dispatchEvent, not click: the first overlay covers the QA button, and the
  // point of the test is exactly what a second open does.
  await page.dispatchEvent('[data-qa="feed-sequencing-open"]', 'click');
  await panel.first().waitFor({ timeout: 5_000 });
  await page.dispatchEvent('[data-qa="feed-sequencing-open"]', 'click');
  await panel.first().waitFor({ timeout: 5_000 });
  eq(await panel.count(), 1, 'a double mount must not stack overlays');
  await page.click('[data-seq-action="close"]');
  eq(await panel.count(), 0, 'the replacing screen closes too');

  // ── session 2: the single non-leaking 404 ─────────────────────────────────
  mode = 'notfound';
  await page.goto(`${origin}/?diag=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-qa="feed-sequencing-open"]', { timeout: 20_000 });
  const notFoundStart = requests.length;
  await page.click('[data-qa="feed-sequencing-open"]');
  await panel.waitFor({ timeout: 5_000 });
  await page.waitForSelector(`${PANEL} [data-seq-state="unavailable"]`, { timeout: 15_000 });
  const unavailableMessages = [await page.locator(`${PANEL} [data-seq-state="unavailable"]`).innerText()];
  eq(
    await panel.locator('[data-seq-action="retry"]').count(),
    0,
    'the single 404 must offer no retry control',
  );
  for (const tab of ['why-now', 'history']) {
    await page.click(`[data-seq-tab="${tab}"]`);
    await page.waitForSelector(`${PANEL} [data-seq-state="unavailable"]`, { timeout: 15_000 });
    unavailableMessages.push(
      await page.locator(`${PANEL} [data-seq-state="unavailable"]`).innerText(),
    );
    eq(
      await panel.locator('[data-seq-action="retry"]').count(),
      0,
      `the ${tab} 404 must offer no retry control`,
    );
  }
  // The reset tab reuses the history and profile states it already has.
  await page.click('[data-seq-tab="reset"]');
  await sleep(400);
  eq(
    new Set(unavailableMessages).size,
    1,
    'the unavailable message must not vary by projection — the server does not either',
  );
  for (const pathname of DEBUG_PATHS) {
    eq(countOf(pathname, notFoundStart), 1, `${pathname} must be asked exactly once under a 404`);
  }
  for (const item of debugRequests(notFoundStart)) {
    eq(item.method, 'GET', 'even a failing projection read stays a GET');
  }
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`feed sequencing debug browser: ${assertions} assertions`);
