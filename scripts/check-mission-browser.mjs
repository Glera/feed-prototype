/** Mission Stage 1 in the real production Feed build (stubbed backend).
 *
 * Covers the approved iteration-5 surface against the exact v2 ladder wire:
 * nearest-step HUD, full public contract in a separate sheet, no own toast,
 * one receipt-driven paw flight, UNLOCKED/FULFILLED copy, mission navigation,
 * hidden challenge rail, and exact capability-revoke restoration.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import {
  MISSION_DEMO_CONTRIBUTION,
  missionDemoCaseWire,
} from '../src/mission-demo-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'mission-browser-'));
const port = Number(process.env.MISSION_BROWSER_PORT || 5247);
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const build = spawnSync(
  'npx',
  ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'],
  {
    cwd: root,
    encoding: 'utf8',
    // The build flag is the FIRST gate; the capability below is the second.
    env: {
      ...process.env,
      VITE_API_BASE: origin,
      VITE_MISSION_ENABLED: 'true',
      VITE_ISLAND_ENABLED: 'false',
    },
    timeout: 240_000,
  },
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const QUEST_ID = 'login';
const PUZZLE_REWARD = 4;

const backend = {
  capability: true,
  puzzleBalance: 10,
  claimed: false,
  claimCalls: 0,
  // The empty-queue fuse: the first claim is refused retryably and commits
  // NOTHING — the contribution exists only from the retry onwards.
  claimStatus: 503,
  caseRequests: 0,
  caseTokens: 2,
  barProgress: 4,
  unlockedSeq: null,
  fulfilledSeq: null,
  dailyReceipt: null,
};

const CONTRIBUTION = MISSION_DEMO_CONTRIBUTION;
const caseView = () => missionDemoCaseWire({
  progress: backend.barProgress,
  caseTokens: backend.caseTokens,
  unlockedSeq: backend.unlockedSeq,
  fulfilledSeq: backend.fulfilledSeq,
});
const FUNDING_POLICY_DOCUMENT = caseView().activeCase.contract.fundingPolicy.document;

const dailyState = (withReceipt) => ({
  day: '2026-08-01',
  reset_at: new Date(Date.now() + 3_600_000).toISOString(),
  seconds_remaining: 3600,
  puzzle_balance: backend.puzzleBalance,
  quests: [{
    id: QUEST_ID,
    title: 'Зайти в игру',
    progress: 1,
    target: 1,
    reward_puzzles: PUZZLE_REWARD,
    completed: true,
    claimed: backend.claimed,
  }],
  ...(withReceipt ? { mission_contribution: CONTRIBUTION } : {}),
});

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
    return;
  }
  if (url.pathname === '/versions.json') {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const telegramSdk = `
window.Telegram={WebApp:{
  initData:'',initDataUnsafe:{user:{id:79123}},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  showConfirm(_m,cb){cb(true);},requestWriteAccess(cb){cb(true);},
  openTelegramLink(){},close(){}
}};`;

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (value) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
    if (url.pathname === '/api/session') {
      return json({
        user: { id: 79123, ref_code: 'msn', first_name: 'Mission' },
        ref_code: 'msn',
        balance: 0,
        puzzles: backend.puzzleBalance,
        is_new: false,
        ...(backend.capability ? { mission_dogfood: true } : {}),
      });
    }
    if (url.pathname === '/api/mission/case') {
      backend.caseRequests += 1;
      // The server's own gate: a caller without the capability is a 404, never
      // a 403 — the surface does not confirm its own existence.
      if (!backend.capability) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not Found"}' });
      }
      return json(caseView());
    }
    if (url.pathname === '/api/daily/sync') return json(dailyState(false));
    if (url.pathname === '/api/daily/claim') {
      backend.claimCalls += 1;
      if (backend.claimStatus !== 200) {
        return route.fulfill({
          status: backend.claimStatus,
          contentType: 'application/json',
          body: '{"detail":"mission_queue_unavailable"}',
        });
      }
      if (!backend.claimed) {
        backend.claimed = true;
        backend.puzzleBalance += PUZZLE_REWARD;
        backend.caseTokens += CONTRIBUTION.amount;
        backend.barProgress = CONTRIBUTION.bar.progress;
      }
      return json(dailyState(true));
    }
    if (url.pathname === '/api/me') return json({ user: null, balance: 0, puzzles: backend.puzzleBalance });
    if (url.pathname === '/api/challenges' && method === 'GET') return json({
      box: 'in',
      items: [{
        id: 'challenge-1', mechanic_id: 'sort', metric_key: 'time_ms',
        challenger_value: 42, played: false,
        challenger: { first_name: 'Друг', username: null },
      }],
    });
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"fixture unavailable"}' });
  });

  const page = await context.newPage();
  const bar = page.locator('.hud__mission');
  const badge = page.locator('.hud__puzzles');
  const challenge = page.locator('.story[data-challenge="challenge-1"]');
  const foreground = async () => {
    // The foreground edge is dedupd for 1s and is what re-reads /session.
    await sleep(1200);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };

  // ── 1. both gates open: iteration-5 HUD and navigation appear ──────────────
  await page.goto(`${origin}/?initData=mission-browser&metaworld=1`, { waitUntil: 'domcontentloaded' });
  await bar.waitFor({ state: 'visible', timeout: 15_000 });
  // The denominator is the nearest unopened step, never the final goal guess.
  await page.waitForFunction(
    () => document.querySelector('.hud__mission-count')?.textContent === '4 / 5',
    null,
    { timeout: 15_000 },
  );
  assert.equal(await bar.locator('.hud__mission-title').count(), 0, 'the compact HUD has no season title');
  assert.equal(await bar.locator('.hud__mission-track i').getAttribute('style'), 'width: 80%;');
  assert.equal(await bar.locator('.hud__mission-gift').textContent(), '🎁');
  assert.equal(await bar.locator('.hud__mission-open .hud__mission-info').count(), 0, 'interactive roles never nest');
  assert.equal(await bar.locator('.hud__mission-info').evaluate((node) => node.tagName), 'BUTTON');
  const infoBounds = await bar.locator('.hud__mission-info').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  assert.ok(infoBounds.width >= 24 && infoBounds.height >= 24, 'contract info has a real touch target');
  assert.equal(await badge.isVisible(), false, 'there is no personal paw wallet in mission HUD');
  assert.equal(await badge.locator('.hud__puzzles-value').count(), 1, 'the puzzle node must remain untouched');
  assert.equal(await badge.locator('.hud__puzzles-value').isVisible(), false, 'the puzzle balance leaves the surface');
  assert.equal(await badge.locator('.hud__puzzles-value').textContent(), '10', 'and keeps being painted underneath');
  assert.equal(await page.locator('.hud__level-plus').getAttribute('aria-label'), 'Добавить друга — скоро');
  assert.equal(await page.locator('.hud__level-plus').getAttribute('tabindex'), '0');
  const levelBounds = await page.locator('.hud__level').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, radius: getComputedStyle(node).borderRadius };
  });
  assert.deepEqual(levelBounds, { width: 72, height: 84, radius: '15px' });
  assert.equal(await page.locator('.hud__mission-friend-slot').count(), 4, 'the static friends row is honest and empty');
  await page.locator('.hud__level-plus').press('Enter');
  await page.getByText('Добавление друзей — скоро', { exact: true }).waitFor({ state: 'visible' });
  await challenge.waitFor({ state: 'attached' });
  assert.equal(await challenge.isVisible(), false, 'incoming challenges are hidden from mission HUD');
  const missionNav = page.locator('.feed-bar--mission [data-mission-label]');
  await missionNav.first().waitFor({ state: 'visible' });
  assert.deepEqual(await missionNav.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-mission-label'))), [
    'Дейлики', 'Коллекции', 'Лента', 'Карта',
  ]);
  assert.equal(await page.locator('.feed-bar__icon--mission-map').isDisabled(), false);
  await page.locator('.feed-bar__icon--mission-map').click();
  await page.locator('.helpmap-preview').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByLabel('Закрыть карту').click();
  await page.locator('.helpmap-preview').waitFor({ state: 'detached', timeout: 10_000 });

  // ── 2. case canvas: bar, collected/mine, ladder, separate contract sheet ───
  await bar.locator('.hud__mission-info').click();
  const screen = page.locator('.mission-screen');
  await screen.waitFor({ state: 'visible' });
  const contractSheet = screen.locator('.mission-contract-sheet');
  await contractSheet.waitFor({ state: 'visible' });
  assert.match(await screen.locator('.mission-meter__count').textContent(), /^4 \/ 5 лапок сообщества$/);
  assert.equal(await screen.locator('.mission-meter__track i').getAttribute('style'), 'width: 80%;');
  const tiles = screen.locator('.mission-tile');
  assert.equal(await tiles.count(), 2);
  const tileByLabel = async (label) => {
    const tile = screen.locator('.mission-tile', { has: page.locator(`.mission-tile__label:text-is("${label}")`) });
    return {
      value: (await tile.locator('.mission-tile__value').textContent()) ?? '',
      detail: await tile.locator('.mission-tile__detail').count()
        ? await tile.locator('.mission-tile__detail').textContent()
        : null,
    };
  };
  assert.deepEqual(await tileByLabel('уже собрано'), { value: '€100', detail: null });
  assert.deepEqual(await tileByLabel('Мой вклад'), { value: '2 лапки', detail: null });
  assert.equal(await screen.getByText('Передано', { exact: true }).count(), 0, 'no transfer claim before fulfillment');
  assert.deepEqual(await screen.locator('.mission-ladder__step').allTextContents(), [
    '✓€100гарантированный подарокоткрыт',
    '🔒€10за 5 лапок сообществавпереди',
    '🔒€10за 50 лапок сообществавпереди',
  ]);
  assert.equal(await screen.locator('.mission-description').count(), 0, 'media-blocked copy creates no false read-more affordance');
  // ⓘ opens the complete public contract/materials in its own sheet.
  assert.match(await contractSheet.locator('.mission-defs').first().textContent(), /Приют «Лапа»/);
  assert.match(
    await screen.locator('.mission-defs').first().textContent(),
    /2026-09-01/,
    'the published unlock cutoff is now an executable promise and belongs in the contract',
  );
  assert.equal(await contractSheet.getAttribute('role'), 'dialog');
  assert.equal(await contractSheet.getAttribute('aria-modal'), 'true');
  assert.equal(await contractSheet.evaluate((node) => document.activeElement === node), true);
  backend.caseTokens = 3;
  await foreground();
  await contractSheet.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains('mission-contract-sheet') === true,
    null,
    { timeout: 15_000 },
  );
  assert.equal(await contractSheet.evaluate((node) => document.activeElement === node), true, 'refresh preserves the open contract');
  backend.caseTokens = 2;
  await foreground();
  // Anti-drift: one tap must render EVERY key of the policy wire document, by
  // the document's own keys — not by a hand-written list that can silently fall
  // behind the next closed-schema change.
  const policyKeys = Object.keys(FUNDING_POLICY_DOCUMENT).filter((key) => key !== 'schema');
  const renderedKeys = await contractSheet.locator('.mission-policy .mission-def').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.policyKey),
  );
  assert.deepEqual(
    [...renderedKeys].sort(),
    [...policyKeys].sort(),
    'one tap must render exactly the policy document keys the backend sends',
  );
  // …and each one by its EXACT wire value, so a renamed enum cannot hide behind
  // a friendly label.
  const policyText = await contractSheet.locator('.mission-policy').textContent();
  for (const key of policyKeys) {
    const value = FUNDING_POLICY_DOCUMENT[key];
    const wireValues = typeof value === 'string' ? [value] : value.sources;
    for (const wire of wireValues) {
      assert.ok(
        policyText.includes(wire),
        `one tap must show the exact wire value ${wire} of ${key}`,
      );
    }
  }
  // The executable meaning travels with the enum, not instead of it.
  assert.match(policyText, /целыми центами/);
  assert.match(policyText, /FIFO/);
  assert.match(policyText, /каждая ступень открывается один раз/);
  assert.match(policyText, /посев/);
  await contractSheet.locator('.mission-contract-sheet__close').click();
  await contractSheet.waitFor({ state: 'hidden' });
  assert.equal(await screen.locator('.mission-history__empty').count(), 1, 'no contribution yet, no history');
  await screen.locator('.mission-screen__close').click();
  await screen.waitFor({ state: 'detached' });

  // ── 3. daily claim: 503 first, ceremony only from the retry answer (F4) ────
  await page.evaluate(() => {
    window.__missionFlightCount = 0;
    window.__missionGiftBounceCount = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('.mission-paw-flight')) window.__missionFlightCount += 1;
        }
        if (
          record.target instanceof Element
          && record.target.matches('.hud__mission-gift')
          && record.target.classList.contains('hud__mission-gift--bounce')
        ) window.__missionGiftBounceCount += 1;
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    window.__missionFlightObserver = observer;
  });
  await page.locator('[data-bar-tab="daily"]').click();
  await page.locator('.daily-panel__claim').waitFor({ state: 'visible' });
  await page.locator('.daily-panel__claim').click();
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14);
  await sleep(300);
  assert.equal(backend.claimCalls, 1, 'the first claim was refused retryably');
  assert.equal(await page.locator('.mission-card, .mission-toast').count(), 0, 'a refused claim creates no own toast');
  // The operator refills the queue; the background retry now commits the
  // contribution and the receipt arrives ONLY on that answer.
  backend.claimStatus = 200;
  await page.waitForFunction(() => window.__missionFlightCount === 1, null, { timeout: 20_000 });
  assert.ok(backend.claimCalls >= 2, `the ceremony must come from the retry (calls=${backend.claimCalls})`);
  await sleep(2500);
  assert.equal(await page.evaluate(() => window.__missionFlightCount), 1, 'exactly one receipt-driven paw flight');
  assert.equal(await page.evaluate(() => window.__missionGiftBounceCount), 1, 'one crossed ladder step bounces the gift once');
  assert.equal(await page.locator('.mission-card, .mission-toast').count(), 0, 'own contribution never creates a toast');
  // The read API refresh — not an optimistic guess — moves the shared bar.
  assert.equal(await bar.locator('.hud__mission-count').textContent(), '5 / 50');
  await page.locator('[data-bar-tab="feed"]').click();
  await bar.click();
  await screen.waitFor({ state: 'visible' });
  assert.equal(await screen.locator('.mission-history__row').count(), 1, 'exactly one history row per contribution');
  assert.equal(await screen.locator('.mission-history__source').textContent(), 'ежедневное задание');
  assert.equal(await screen.locator('.mission-history__amount').textContent(), '+1');
  await screen.locator('.mission-screen__close').click();
  await screen.waitFor({ state: 'detached' });

  // ── 4. the UNLOCKED ceremony, shown exactly once ───────────────────────────
  backend.unlockedSeq = 11;
  await foreground();
  const ceremony = page.locator('.mission-ceremony--unlocked');
  await ceremony.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await ceremony.locator('.mission-ceremony__title').textContent(), 'Приют получает €120');
  assert.equal(await ceremony.locator('.mission-ceremony__moment').count(), 0, 'the removed eyebrow must not return');
  assert.equal(await ceremony.locator('.mission-ceremony__paws').textContent(), '50 лапок');
  assert.deepEqual(await ceremony.locator('.mission-ceremony__breakdown').allTextContents(), [
    '€100 — гарантия платформы',
    '€20 — собрало сообщество',
  ], 'the ceremony shows the exact platform/community money split');
  assert.equal(await ceremony.locator('.mission-ceremony__next').count(), 0, 'the successor announcement is absent');
  assert.equal(await ceremony.locator('.mission-ceremony__btn').textContent(), 'Ура!');
  await ceremony.locator('.mission-ceremony__btn').click();
  await ceremony.waitFor({ state: 'detached' });
  await foreground();
  await sleep(1500);
  assert.equal(await page.locator('.mission-ceremony').count(), 0, 'a shown ceremony must not return on focus');

  // ── 5. FULFILLED report has public facts, never the technical transfer ref ─
  backend.fulfilledSeq = 12;
  await foreground();
  const fulfilled = page.locator('.mission-ceremony--fulfilled');
  await fulfilled.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await fulfilled.locator('.mission-ceremony__title').textContent(), 'Корм передан');
  assert.match(await fulfilled.locator('.mission-ceremony__sub').textContent(), /€120/);
  assert.equal((await fulfilled.textContent()).includes('internal-do-not-render'), false);
  await fulfilled.locator('.mission-ceremony__btn').click();
  await fulfilled.waitFor({ state: 'detached' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await bar.waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(1500);
  assert.equal(await page.locator('.mission-ceremony').count(), 0, 'the watermark must survive a reload');

  // ── 6. revoked capability: exact pre-mission HUD/nav/challenge restoration ─
  backend.capability = false;
  const requestsBeforeRevoke = backend.caseRequests;
  await foreground();
  await bar.waitFor({ state: 'detached', timeout: 15_000 });
  assert.equal(await badge.count(), 1, 'the badge itself must stay');
  assert.equal(await badge.getAttribute('aria-label'), 'Puzzles', 'the original ARIA label must be restored');
  assert.equal(await badge.locator('.hud__puzzles-value').isVisible(), true, 'the puzzle counter returns');
  assert.equal(
    await badge.locator('.hud__puzzles-value').textContent(),
    '14',
    'and shows the CURRENT balance — the node was never detached, so it never went stale',
  );
  assert.equal(await badge.locator('img').isVisible(), true, 'the puzzle icon returns too');
  assert.equal(await page.locator('.hud__level-plus').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.hud__level-plus').getAttribute('aria-label'), null);
  assert.equal(await page.locator('.hud__level-plus').getAttribute('tabindex'), null);
  assert.equal(await challenge.isVisible(), true, 'challenge inbox returns outside mission HUD');
  assert.equal(await page.locator('.stories').getAttribute('aria-label'), 'Challenges');
  assert.deepEqual(await page.locator('.feed-bar__switch > [data-bar-tab]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-bar-tab')),
  ), ['daily', 'meta', 'feed', 'collections']);
  assert.equal(await page.locator('.feed-bar--mission, .feed-bar__icon--mission-map').count(), 0);
  assert.equal(await page.locator('[data-mission-label]').count(), 0);
  assert.equal(await page.locator('.mission-screen, .mission-ceremony, .hud__mission, .hud__mission-friends').count(), 0);
  assert.equal(await page.locator('.viewport--mission').count(), 0);
  await sleep(1500);
  assert.equal(
    backend.caseRequests,
    requestsBeforeRevoke,
    'a revoked capability must issue no further /api/mission/* request',
  );

  console.log(
    'mission browser: iteration-5 HUD/nav + hidden challenge rail + nearest ladder step'
    + ' + separate full-contract sheet + own 503→retry paw flight exactly once'
    + ' + UNLOCKED/FULFILLED copy + watermark + exact revoke restore verified',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
