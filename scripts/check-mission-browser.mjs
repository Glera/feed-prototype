/**
 * Mission slice v0 in the real production Feed build (stubbed backend).
 *
 * Covers the three client findings of the Stage 1 cross-review R1, each on the
 * path where a unit test cannot be honest — the browser:
 *
 *   F4  a daily claim whose FIRST answer is the mandatory retryable 503 of an
 *       empty case queue: the contribution is committed only by the background
 *       retry, and the player must still get exactly one ceremony and exactly
 *       one history row from that later answer;
 *   F5  the case screen shows the full `reservedAndOpenedCents` the pool really
 *       holds — not only the delta a crossing opened;
 *   R2/2 «the contract in one tap» renders every money-bearing field of the CLOSED
 *       funding-policy schema, against the exact document the backend sends;
 *   F6  a `/session` that no longer carries `mission_dogfood` restores the HUD
 *       badge exactly, so the double gate really closes.
 *
 * Plus the two properties everything else rests on: the additive retheme (the
 * puzzle counter node stays live and correct underneath) and the ceremony
 * watermark (shown once, and not again after a reload).
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
    env: { ...process.env, VITE_API_BASE: origin, VITE_MISSION_ENABLED: 'true' },
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
  unlocked: null,
  bar: { caseId: 'case-2', contractVersion: 'v1', progress: 5, tokenGoal: 50 },
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
  schema: 'mission.funding-policy.v1',
  currency: 'EUR',
  rounding: 'floor-cents',
  giftFormula: 'guaranteed-plus-floor-proportional-share-v1',
  snapshotRule: 'ledger-seq-alloc-cutoff-v1',
  poolConsumption: 'eligible-ledger-fifo-by-seq-v1',
  eligiblePool: { sources: ['seed', 'revenue_share'] },
};

const caseView = () => ({
  schema: 'mission.case-view.v1',
  activeCase: {
    caseId: 'case-2',
    contractVersion: 'v1',
    bar: { progress: backend.barProgress, tokenGoal: 50 },
    money: {
      currency: 'EUR',
      communityTokens: backend.barProgress,
      guaranteedCents: 10_000,
      // Deliberately different from reservedAndOpened: before the fix the screen
      // could show only the €120 delta and never the €220 actually held.
      reservedCents: 10_000,
      reservedAndOpenedCents: 22_000,
      deliveredCents: 0,
    },
    contract: {
      caseId: 'case-2',
      contractVersion: 'v1',
      contractDigest: 'b'.repeat(64),
      document: {
        schema: 'mission.case-contract.v1',
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
        unlockShare: 'proportional',
        // Executable since backend R1/F2: UNLOCK is refused before this instant.
        unlockCutoffAt: '2026-09-01T00:00:00+00:00',
        latestFulfillmentAt: '2026-09-15T00:00:00+00:00',
        queuePosition: 1,
        fundingPolicy: { version: 'mission-funding.v1', digest: 'c'.repeat(64) },
      },
      fundingPolicy: {
        version: 'mission-funding.v1',
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
      giftAdditionalCents: 12_000,
      giftTotalCents: 22_000,
      progress: 50,
      tokenGoal: 50,
    },
  },
  lastFulfilled: null,
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
    if (url.pathname === '/api/challenges' && method === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"fixture unavailable"}' });
  });

  const page = await context.newPage();
  const bar = page.locator('.hud__mission');
  const badge = page.locator('.hud__puzzles');
  const foreground = async () => {
    // The foreground edge is dedupd for 1s and is what re-reads /session.
    await sleep(1200);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };

  // ── 1. both gates open: the case bar and the paw badge appear ──────────────
  await page.goto(`${origin}/?initData=mission-browser`, { waitUntil: 'domcontentloaded' });
  await bar.waitFor({ state: 'visible', timeout: 15_000 });
  // The bar mounts empty and is filled by the read API — never by a local guess.
  await page.waitForFunction(
    () => document.querySelector('.hud__mission-count')?.textContent === '4 / 50',
    null,
    { timeout: 15_000 },
  );
  assert.equal(await bar.locator('.hud__mission-title').textContent(), '10 кг корма');
  assert.equal(await badge.getAttribute('data-mission'), '1', 'the badge must be rethemed');
  assert.equal(await badge.locator('.hud__mission-paw-value').textContent(), '2', 'the badge shows MY case tokens');
  assert.equal(await badge.getAttribute('aria-label'), 'Мои лапки');
  // The retheme is additive: the puzzle node is still there, still correct, and
  // merely hidden — which is what makes the revoke in step 5 exact.
  assert.equal(await badge.locator('.hud__puzzles-value').count(), 1, 'the puzzle node must survive the retheme');
  assert.equal(await badge.locator('.hud__puzzles-value').isVisible(), false, 'the puzzle balance leaves the surface');
  assert.equal(await badge.locator('.hud__puzzles-value').textContent(), '10', 'and keeps being painted underneath');

  // ── 2. the case screen shows the four obligatory numbers (F5) ──────────────
  await bar.click();
  const screen = page.locator('.mission-screen');
  await screen.waitFor({ state: 'visible' });
  assert.match(await screen.locator('.mission-meter__count').textContent(), /^4 \/ 50 лапок сообщества$/);
  const tiles = screen.locator('.mission-tile');
  assert.equal(await tiles.count(), 4);
  const tileByLabel = async (label) => {
    const tile = screen.locator('.mission-tile', { has: page.locator(`.mission-tile__label:text-is("${label}")`) });
    return {
      value: (await tile.locator('.mission-tile__value').textContent()) ?? '',
      detail: await tile.locator('.mission-tile__detail').count()
        ? await tile.locator('.mission-tile__detail').textContent()
        : null,
    };
  };
  assert.deepEqual(await tileByLabel('Гарантировано'), { value: '€100', detail: null });
  assert.deepEqual(
    await tileByLabel('Зарезервировано и открыто'),
    { value: '€220', detail: '+€120 открыто игрой' },
    'the pool must show what it HOLDS, with the play-opened part as its detail',
  );
  assert.deepEqual(await tileByLabel('Мои лапки'), { value: '2', detail: null });
  assert.deepEqual(await tileByLabel('Передано'), { value: 'ждём', detail: null });
  // «Контракт кейса» resolves the pinned money policy in ONE tap.
  await screen.locator('.mission-contract__summary').click();
  assert.match(await screen.locator('.mission-defs').first().textContent(), /Приют «Лапа»/);
  assert.match(
    await screen.locator('.mission-defs').first().textContent(),
    /2026-09-01/,
    'the published unlock cutoff is now an executable promise and belongs in the contract',
  );
  // Anti-drift: one tap must render EVERY key of the policy wire document, by
  // the document's own keys — not by a hand-written list that can silently fall
  // behind the next closed-schema change.
  const policyKeys = Object.keys(FUNDING_POLICY_DOCUMENT).filter((key) => key !== 'schema');
  const renderedKeys = await screen.locator('.mission-policy .mission-def').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.policyKey),
  );
  assert.deepEqual(
    [...renderedKeys].sort(),
    [...policyKeys].sort(),
    'one tap must render exactly the policy document keys the backend sends',
  );
  // …and each one by its EXACT wire value, so a renamed enum cannot hide behind
  // a friendly label.
  const policyText = await screen.locator('.mission-policy').textContent();
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
  assert.match(policyText, /вниз до целых центов/);
  assert.match(policyText, /FIFO/);
  assert.match(policyText, /посев/);
  assert.equal(await screen.locator('.mission-history__empty').count(), 1, 'no contribution yet, no history');
  await screen.locator('.mission-screen__close').click();
  await screen.waitFor({ state: 'detached' });

  // ── 3. daily claim: 503 first, ceremony only from the retry answer (F4) ────
  await page.locator('[data-bar-tab="daily"]').click();
  await page.locator('.daily-panel__claim').waitFor({ state: 'visible' });
  await page.locator('.daily-panel__claim').click();
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14);
  await sleep(300);
  assert.equal(backend.claimCalls, 1, 'the first claim was refused retryably');
  assert.equal(await page.locator('.mission-card').count(), 0, 'a refused claim commits nothing to celebrate');
  // The operator refills the queue; the background retry now commits the
  // contribution and the receipt arrives ONLY on that answer.
  backend.claimStatus = 200;
  const card = page.locator('.mission-card');
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  assert.ok(backend.claimCalls >= 2, `the ceremony must come from the retry (calls=${backend.claimCalls})`);
  assert.equal(await card.locator('.mission-card__title').textContent(), 'Ты принёс 1 лапок');
  assert.equal(await card.locator('.mission-card__sub').textContent(), 'Вклад внесён — общий бар сдвинулся');
  assert.equal(await card.locator('.mission-card__count').textContent(), '5 / 50', 'the bar is the receipt bar');
  await sleep(2500);
  assert.equal(await page.locator('.mission-card').count(), 1, 'exactly one ceremony per contribution');
  // The read API refresh — not an optimistic guess — moves the badge and bar.
  await page.waitForFunction(() => document.querySelector('.hud__mission-paw-value')?.textContent === '3');
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
  assert.equal(await ceremony.locator('.mission-ceremony__title').textContent(), 'Мы сделали это');
  const sums = await ceremony.locator('.mission-sum').allTextContents();
  assert.deepEqual(sums, [
    'Гарантировано€100',
    'Открыто игрой+€120',
    'Подарок ждёт передачи€220',
  ], 'the three sums come from the UNLOCKED receipt');
  assert.equal(
    await ceremony.locator('.mission-ceremony__next').textContent(),
    'Следующая цель уже открыта — 10 кг корма',
  );
  await ceremony.locator('.mission-ceremony__btn').click();
  await ceremony.waitFor({ state: 'detached' });
  await foreground();
  await sleep(1500);
  assert.equal(await page.locator('.mission-ceremony').count(), 0, 'a shown ceremony must not return on focus');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await bar.waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(1500);
  assert.equal(await page.locator('.mission-ceremony').count(), 0, 'the watermark must survive a reload');

  // ── 5. revoked capability: the HUD returns to the pre-mission build (F6) ───
  backend.capability = false;
  const requestsBeforeRevoke = backend.caseRequests;
  await foreground();
  await bar.waitFor({ state: 'detached', timeout: 15_000 });
  assert.equal(await badge.count(), 1, 'the badge itself must stay');
  assert.equal(await badge.getAttribute('data-mission'), null, 'the mission marker must be gone');
  assert.equal(await badge.locator('.hud__mission-paw').count(), 0, 'the paw node must be removed');
  assert.equal(await badge.getAttribute('aria-label'), 'Puzzles', 'the original ARIA label must be restored');
  assert.equal(await badge.locator('.hud__puzzles-value').isVisible(), true, 'the puzzle counter returns');
  assert.equal(
    await badge.locator('.hud__puzzles-value').textContent(),
    '14',
    'and shows the CURRENT balance — the node was never detached, so it never went stale',
  );
  assert.equal(await badge.locator('img').isVisible(), true, 'the puzzle icon returns too');
  assert.equal(await page.locator('.mission-screen, .mission-ceremony, .hud__mission').count(), 0);
  await sleep(1500);
  assert.equal(
    backend.caseRequests,
    requestsBeforeRevoke,
    'a revoked capability must issue no further /api/mission/* request',
  );

  console.log(
    'mission browser: both gates + additive paw retheme + reserved-and-opened tile'
    + ' + one-tap contract over every key of the exact closed funding-policy wire'
    + ' + 503→retry ceremony exactly once + watermark across reload + exact revoke restore verified',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
