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

const CONTRIBUTION = {
  schema: 'mission.contribution-receipt.v1',
  seq: 7,
  userId: 79123,
  source: 'daily',
  sourceRef: QUEST_ID,
  idempotencyKey: `mcd:79123:2026-08-01:${QUEST_ID}`,
  amount: 1,
  weightsVersion: 'mission-weights.v1',
  weightsDigest: 'a'.repeat(64),
  allocations: [{ caseId: 'case-2', contractVersion: 'v1', amount: 1 }],
  openedGiftSteps: [{
    caseId: 'case-2', contractVersion: 'v1', stepIndex: 1,
    thresholdTokens: 5, amountCents: 1_000, progressAtOpen: 5,
  }],
  unlocked: null,
  bar: {
    caseId: 'case-2', contractVersion: 'v1', progress: 5,
    tokenGoal: 50, nextStepThreshold: 50,
  },
};

/**
 * EXACT wire, copied from swipe-backend `b63b26e`
 * (`tests/test_mission_migration_postgres.py:FUNDING_POLICY`, the constants in
 * `app/mission_contracts.py`). `mission_api._contract_view` returns
 * `dict(policy.document)` with no adaptation, so what the client receives is
 * these bytes.
 *
 * The schema is CLOSED and executable: every money-bearing field is an enum with
 * exactly one legal value naming the behaviour the runtime implements. Keeping a
 * hand-written prose copy here is what let the client's «contract in one tap»
 * drift out of the wire unnoticed — so this object, and the assertion that every
 * one of its keys is rendered, are the anti-drift pair.
 */
const FUNDING_POLICY_DOCUMENT = {
  schema: 'mission.funding-policy.v2',
  currency: 'EUR',
  rounding: 'declared-cents',
  giftFormula: 'guaranteed-plus-opened-steps-v1',
  stepRule: 'prefunded-reserved-at-ready-open-once-v1',
  snapshotRule: 'ledger-seq-alloc-cutoff-v1',
  poolConsumption: 'eligible-ledger-fifo-by-seq-v1',
  eligiblePool: { sources: ['seed', 'revenue_share'] },
};

const caseView = () => ({
  schema: 'mission.case-view.v1',
  activeCase: {
    caseId: 'case-2',
    contractVersion: 'v1',
    bar: {
      progress: backend.barProgress,
      tokenGoal: 50,
      nextStepThreshold: backend.barProgress < 5 ? 5 : backend.barProgress < 50 ? 50 : null,
    },
    money: {
      currency: 'EUR',
      communityTokens: backend.barProgress,
      guaranteedCents: 10_000,
      ladderTotalCents: 12_000,
      collectedCents: backend.barProgress < 5 ? 10_000 : backend.barProgress < 50 ? 11_000 : 12_000,
      deliveredCents: 0,
    },
    giftLadder: [
      { stepIndex: 0, thresholdTokens: 0, amountCents: 10_000, state: 'guaranteed', openingReceipt: null },
      {
        stepIndex: 1, thresholdTokens: 5, amountCents: 1_000,
        state: backend.barProgress < 5 ? 'reserved' : 'opened',
        openingReceipt: backend.barProgress < 5 ? null : { contributionSeq: 7 },
      },
      {
        stepIndex: 2, thresholdTokens: 50, amountCents: 1_000,
        state: backend.barProgress < 50 ? 'reserved' : 'opened',
        openingReceipt: null,
      },
    ],
    contract: {
      caseId: 'case-2',
      contractVersion: 'v1',
      contractDigest: 'b'.repeat(64),
      document: {
        schema: 'mission.case-contract.v2',
        caseId: 'case-2',
        contractVersion: 'v1',
        recipient: 'Приют «Лапа»',
        needKind: 'scalable',
        guaranteedDeliverable: '10 кг корма',
        stretchDeliverables: [],
        rolloverRule: 'остаток переходит в следующий кейс',
        confirmationKind: 'photo_report',
        currency: 'EUR',
        guaranteedCents: 10_000,
        confirmedNeedCents: 50_000,
        stretchCapCents: 20_000,
        tokenGoal: 50,
        giftLadder: [
          { stepIndex: 0, thresholdTokens: 0, amountCents: 10_000 },
          { stepIndex: 1, thresholdTokens: 5, amountCents: 1_000 },
          { stepIndex: 2, thresholdTokens: 50, amountCents: 1_000 },
        ],
        ladderTotalCents: 12_000,
        // Executable since backend R1/F2: UNLOCK is refused before this instant.
        unlockCutoffAt: '2026-09-01T00:00:00+00:00',
        latestFulfillmentAt: '2026-09-15T00:00:00+00:00',
        queuePosition: 1,
        fundingPolicy: { version: 'mission-funding.v2', digest: 'c'.repeat(64) },
      },
      fundingPolicy: {
        version: 'mission-funding.v2',
        digest: 'c'.repeat(64),
        document: FUNDING_POLICY_DOCUMENT,
      },
    },
  },
  myContribution: { caseTokens: backend.caseTokens, totalTokens: backend.caseTokens },
  lastUnlocked: backend.unlockedSeq === null ? null : {
    eventSeq: backend.unlockedSeq,
    caseId: 'case-1',
    contractVersion: 'v1',
    occurredAt: '2026-08-01T10:00:00+00:00',
    receiptDigest: 'd'.repeat(64),
    receipt: {
      guaranteedCents: 10_000,
      giftTotalCents: 12_000,
      releasedUnopenedCents: 0,
      progress: 50,
      tokenGoal: 50,
    },
  },
  lastFulfilled: backend.fulfilledSeq === null ? null : {
    eventSeq: backend.fulfilledSeq,
    caseId: 'case-1',
    contractVersion: 'v1',
    occurredAt: '2026-08-02T10:00:00+00:00',
    receiptDigest: 'e'.repeat(64),
    receipt: { giftTotalCents: 12_000 },
    transferReceipt: {
      amountCents: 12_000,
      currency: 'EUR',
      transferDate: '2026-08-02',
      recipient: 'Приют «Лапа»',
      transferReference: 'internal-do-not-render',
    },
  },
});

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
  await page.goto(`${origin}/?initData=mission-browser`, { waitUntil: 'domcontentloaded' });
  await bar.waitFor({ state: 'visible', timeout: 15_000 });
  // The denominator is the nearest unopened step, never the final goal guess.
  await page.waitForFunction(
    () => document.querySelector('.hud__mission-count')?.textContent === '4 / 5',
    null,
    { timeout: 15_000 },
  );
  assert.equal(await bar.locator('.hud__mission-title').count(), 0, 'the compact HUD has no season title');
  assert.equal(await bar.locator('.hud__mission-track i').getAttribute('style'), 'width: 80%;');
  assert.equal(await bar.locator('.hud__mission-gift').textContent(), '🎁ⓘ');
  assert.equal(await badge.isVisible(), false, 'there is no personal paw wallet in mission HUD');
  assert.equal(await badge.locator('.hud__puzzles-value').count(), 1, 'the puzzle node must remain untouched');
  assert.equal(await badge.locator('.hud__puzzles-value').isVisible(), false, 'the puzzle balance leaves the surface');
  assert.equal(await badge.locator('.hud__puzzles-value').textContent(), '10', 'and keeps being painted underneath');
  assert.equal(await page.locator('.hud__level-plus').getAttribute('aria-label'), 'Добавить друга — скоро');
  await challenge.waitFor({ state: 'attached' });
  assert.equal(await challenge.isVisible(), false, 'incoming challenges are hidden from mission HUD');
  const missionNav = page.locator('.feed-bar--mission [data-mission-label]');
  await missionNav.first().waitFor({ state: 'visible' });
  assert.deepEqual(await missionNav.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-mission-label'))), [
    'Daily', 'Collections', 'Feed', 'Map',
  ]);
  assert.equal(await page.locator('.feed-bar__icon--mission-map').isDisabled(), true);

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
  assert.deepEqual(await tileByLabel('Мой вклад'), { value: '2 лапок', detail: null });
  assert.equal(await screen.getByText('Передано', { exact: true }).count(), 0, 'no transfer claim before fulfillment');
  assert.deepEqual(await screen.locator('.mission-ladder__step').allTextContents(), [
    'Гарантия€100', '5 лапок€10', '50 лапок€10',
  ]);
  const description = screen.locator('.mission-description');
  assert.equal(await description.getAttribute('open'), null);
  assert.equal(await description.locator('.mission-description__more').textContent(), 'Читать дальше');
  // ⓘ opens the complete public contract/materials in its own sheet.
  assert.match(await contractSheet.locator('.mission-defs').first().textContent(), /Приют «Лапа»/);
  assert.match(
    await screen.locator('.mission-defs').first().textContent(),
    /2026-09-01/,
    'the published unlock cutoff is now an executable promise and belongs in the contract',
  );
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
  await description.locator('.mission-description__summary').click();
  assert.equal(await description.locator('.mission-description__copy').isVisible(), true);
  assert.equal(await screen.locator('.mission-history__empty').count(), 1, 'no contribution yet, no history');
  await screen.locator('.mission-screen__close').click();
  await screen.waitFor({ state: 'detached' });

  // ── 3. daily claim: 503 first, ceremony only from the retry answer (F4) ────
  await page.evaluate(() => {
    window.__missionFlightCount = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('.mission-paw-flight')) window.__missionFlightCount += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
  const sums = await ceremony.locator('.mission-sum').allTextContents();
  assert.deepEqual(sums, [
    'Платформазаранее резервирует помощь',
    'Сообществооткрывает ступени лапками',
  ], 'the ceremony explains the platform/community ladder roles');
  assert.equal(
    await ceremony.locator('.mission-ceremony__next').textContent(),
    'Следующая цель уже открыта — 10 кг корма',
  );
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
  assert.equal(await challenge.isVisible(), true, 'challenge inbox returns outside mission HUD');
  assert.deepEqual(await page.locator('.feed-bar__switch > [data-bar-tab]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-bar-tab')),
  ), ['daily', 'meta', 'feed', 'collections']);
  assert.equal(await page.locator('.feed-bar--mission, .feed-bar__icon--mission-map').count(), 0);
  assert.equal(await page.locator('[data-mission-label]').count(), 0);
  assert.equal(await page.locator('.mission-screen, .mission-ceremony, .hud__mission').count(), 0);
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
