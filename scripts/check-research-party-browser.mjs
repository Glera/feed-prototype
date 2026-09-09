/** Real production route + TMA transport, backed by required Backend golden bytes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { actor, requestId, clone, readyResult, choiceCommand, choiceReceipt, pendingRecord } from './research-party-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'research-party-browser-'));
const server = createServer((request, response) => {
  if (new URL(request.url, 'http://fixture').pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
  } else { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const endpoint = `/api/operator/research-parties/${requestId}`;
const key = `research-party-choice:v1:${actor}:${requestId}`;
const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'], {
  cwd: root, encoding: 'utf8', timeout: 240_000,
  env: { ...process.env, VITE_API_BASE: origin, VITE_MISSION_ENABLED: 'false', VITE_ISLAND_ENABLED: 'false' },
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
let browser;
const unexpected = [];
const errors = [];
const held = [];
async function scenario({ result = readyResult(), search = `?researchParty=${requestId}`, start = null,
  width = 390, stored = null, storageDenied = false, clock = false, nativeClose = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ actor, start, key, stored, storageDenied, nativeClose }) => {
    const init = (id) => 'query_id=synthetic&user=' + encodeURIComponent(JSON.stringify({ id: Number(id) })) + '&hash=synthetic';
    window.__closeCount = 0;
    window.Telegram = { WebApp: {
      initData: init(actor), initDataUnsafe: { user: { id: Number(actor) }, ...(start ? { start_param: start } : {}) }, platform: 'ios',
      ready() {}, expand() {}, disableVerticalSwipes() {}, enableClosingConfirmation() {}, setHeaderColor() {},
      setBackgroundColor() {}, lockOrientation() {}, onEvent() {}, offEvent() {},
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
      ...(nativeClose ? { close() { window.__closeCount++; } } : {}),
    } };
    window.__switchActor = (id) => {
      window.Telegram.WebApp.initData = init(id);
      window.Telegram.WebApp.initDataUnsafe.user = { id: Number(id) };
    };
    if (stored) sessionStorage.setItem(key, JSON.stringify(stored));
    if (storageDenied) Storage.prototype.setItem = function () { throw new Error('synthetic storage denied'); };
  }, { actor, start, key, stored, storageDenied, nativeClose });
  const state = { result: clone(result), gets: 0, posts: [], mode: 'success', getStatus: 200, getMode: 'success', context, page: null };
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.href === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    if (url.origin === origin && url.pathname === '/') return route.continue();
    if (url.pathname === endpoint && request.method() === 'GET') {
      state.gets++;
      assert.match(request.headers().authorization, /^tma query_id=synthetic/);
      assert.doesNotMatch(request.headers().authorization, /bearer/i);
      if (state.getMode === 'hang') { held.push(route); return; }
      return route.fulfill({ status: state.getStatus, contentType: 'application/json',
        body: JSON.stringify(state.getStatus === 200 ? state.result : { detail: { code: 'research_result_unavailable' } }) });
    }
    if (url.pathname === `${endpoint}/choices` && request.method() === 'POST') {
      const command = request.postDataJSON(); state.posts.push(command);
      const stored = await state.page.evaluate((key) => sessionStorage.getItem(key), key);
      assert.deepEqual(JSON.parse(stored).command, command, 'the exact command must be recoverable before dispatch');
      assert.match(request.headers().authorization, /^tma query_id=synthetic/);
      if (state.mode === 'hold') { held.push(route); state.heldPost = route; return; }
      if (state.mode === 'reject422' || state.mode === 'conflict409') return route.fulfill({
        status: state.mode === 'reject422' ? 422 : 409, contentType: 'application/json',
        body: JSON.stringify({ code: state.mode === 'reject422' ? 'invalid_research_choice' : 'research_choice_already_recorded' }),
      });
      if (state.mode === 'server500') return route.fulfill({ status: 500, body: 'upstream failed' });
      if (state.mode === 'generic422') return route.fulfill({ status: 422, body: 'unreadable proxy refusal' });
      if (state.mode === 'network') return route.abort('failed');
      if (state.mode === 'auth403') return route.fulfill({ status: 403, body: '{}' });
      const previous = state.result.choices.find((item) => item.command.mutationId === command.mutationId);
      const receipt = previous || choiceReceipt(state.result, command);
      if (!previous && state.mode !== 'invalidsuccess') state.result.choices.push(receipt);
      if (state.mode === 'lostCommitted') return route.abort('failed');
      if (state.mode === 'invalidsuccess') receipt.commandHash = '0'.repeat(64);
      return route.fulfill({ status: previous ? 200 : 201, contentType: 'application/json', body: JSON.stringify({
        schema: 'research.party-choice-response.v1', choice: receipt, replayed: Boolean(previous),
      }) });
    }
    if (url.pathname !== '/favicon.ico') unexpected.push(`${request.method()} ${url.href}`);
    return route.fulfill({ status: 404, body: '' });
  });
  state.page = await context.newPage();
  state.page.on('pageerror', (error) => errors.push(error.message));
  if (clock) await state.page.clock.install();
  await state.page.goto(origin + '/' + search, { waitUntil: 'domcontentloaded' });
  await state.page.locator('.research-party').waitFor();
  return state;
}
const countCards = (state, count) => state.page.waitForFunction((count) => document.querySelectorAll('.research-party__card').length === count, count);
const retryReady = (state) => state.page.waitForFunction(() => {
  const button = document.querySelector('[data-testid="research-choice-retry"]');
  return button && !button.hidden && !button.disabled;
});
const statusHas = (state, copy) => state.page.waitForFunction((copy) => document.querySelector('.research-party__status')?.textContent.includes(copy), copy);
const choice = (state, index, label) => state.page.locator('.research-party__card').nth(index).getByRole('button', { name: label, exact: true });
const durableCount = (state, count) => state.page.waitForFunction((count) => [...document.querySelectorAll('.research-party__choice-status')]
  .filter((node) => ['Выбрано', 'Отклонено'].includes(node.textContent)).length === count, count);
const localRecord = (state) => state.page.evaluate((key) => sessionStorage.getItem(key), key);
async function capture(state, name) {
  const dir = process.env.RESEARCH_PARTY_CAPTURE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await state.page.screenshot({ path: path.join(dir, name + '.png'), animations: 'disabled' });
}
try {
  browser = await chromium.launch();
  const first = await scenario({ clock: true });
  await countCards(first, 5);
  await first.page.clock.fastForward(500);
  assert.equal(await first.page.locator('.research-party__choice-status').allTextContents().then((rows) => rows.every((s) => s === 'Решение не выбрано')), true);
  assert.equal(first.posts.length, 0);
  assert.equal(await first.page.locator('iframe,.game').count(), 0);
  await capture(first, '01-ready-390');
  await choice(first, 0, 'Выбрать').evaluate((node) => { node.click(); node.click(); });
  await durableCount(first, 1);
  assert.equal(first.posts.length, 1, 'double click is one immutable command');
  assert.equal(await localRecord(first), null);
  assert.equal(await choice(first, 0, 'Выбрать').isDisabled(), true);
  await choice(first, 1, 'Отклонить').click();
  await durableCount(first, 2);
  assert.deepEqual(first.posts.map((p) => p.action), ['select', 'reject']);
  assert.notEqual(first.posts[0].mutationId, first.posts[1].mutationId);
  // Polling must preserve actual nodes, scroll, focus and the one live region.
  await choice(first, 2, 'Выбрать').focus();
  await first.page.evaluate(() => {
    window.__focused = document.activeElement;
    window.__live = document.querySelector('.research-party__status');
    window.__scroll = document.querySelector('.research-party').scrollTop;
  });
  const beforeReads = first.gets;
  await first.page.clock.fastForward(10_001);
  await first.page.waitForFunction((before) => window.__focused === document.activeElement && !!window.__live, beforeReads);
  await first.page.waitForTimeout(80);
  assert.ok(first.gets > beforeReads);
  assert.deepEqual(await first.page.evaluate(() => [window.__focused === document.activeElement,
    window.__live === document.querySelector('.research-party__status'),
    window.__scroll === document.querySelector('.research-party').scrollTop]), [true, true, true]);
  first.result.choices.push(choiceReceipt(first.result, choiceCommand(first.result, 3, 'reject')));
  await first.page.clock.fastForward(10_001); await durableCount(first, 3);
  assert.equal(await first.page.evaluate(() => window.__focused === document.activeElement), true);
  assert.equal(await first.page.evaluate(() => window.__live === document.querySelector('.research-party__status')), true);
  await first.context.close();

  const narrow = await scenario({ width: 320, result: readyResult({ count: 7, literal: true }) });
  await countCards(narrow, 7);
  assert.equal(await narrow.page.locator('.research-party__title').first().textContent(), '<img src=x onerror=alert(1)> & идея');
  assert.equal(await narrow.page.locator('.research-party__cards img,.research-party__cards script').count(), 0);
  assert.equal(await narrow.page.evaluate(() => document.querySelector('.research-party').scrollWidth > document.querySelector('.research-party').clientWidth), false);
  await choice(narrow, 0, 'Выбрать').scrollIntoViewIfNeeded();
  assert.ok((await choice(narrow, 0, 'Выбрать').boundingBox()).height >= 46);
  await capture(narrow, '02-card-actions-320');
  await narrow.context.close();

  const lost = await scenario(); await countCards(lost, 5);
  lost.mode = 'lostCommitted'; await choice(lost, 0, 'Выбрать').click();
  await durableCount(lost, 1);
  await lost.page.reload(); await durableCount(lost, 1);
  assert.equal(lost.posts.length, 1, 'lost response recovers with GET, never POST replay');
  assert.equal(await localRecord(lost), null);
  await lost.context.close();

  for (const mode of ['server500', 'network', 'invalidsuccess', 'generic422']) {
    const state = await scenario(); await countCards(state, 5); state.mode = mode;
    await choice(state, 0, 'Отклонить').click(); await statusHas(state, 'Решение пока не подтверждено');
    const saved = await localRecord(state); assert.ok(saved);
    await state.page.reload(); await statusHas(state, 'Решение пока не подтверждено');
    assert.equal(await localRecord(state), saved);
    assert.equal(await choice(state, 1, 'Выбрать').isDisabled(), true);
    assert.equal(state.posts.length, 1);
    // An immutable competing action is authoritative and settles uncertainty.
    state.result.choices.push(choiceReceipt(state.result, choiceCommand(state.result, 0, 'select')));
    await state.page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await durableCount(state, 1); assert.equal(await localRecord(state), null);
    assert.equal(await choice(state, 1, 'Выбрать').isEnabled(), true);
    await state.context.close();
  }

  for (const replayed of [false, true]) {
    const retry = await scenario(); await countCards(retry, 5); retry.mode = 'network';
    await choice(retry, 0, 'Отклонить').click(); await statusHas(retry, 'Решение пока не подтверждено');
    const stored = await localRecord(retry);
    await retry.page.reload(); await statusHas(retry, 'Решение пока не подтверждено');
    await retry.page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await statusHas(retry, 'Решение пока не подтверждено'); await retryReady(retry);
    assert.equal(retry.posts.length, 1, 'reload and manual GET never replay the POST');
    assert.equal(await localRecord(retry), stored);
    assert.equal(await choice(retry, 1, 'Выбрать').isDisabled(), true);
    retry.mode = 'success';
    // The receipt can become durable after our last GET but before the human
    // retries. The same command then returns the existing receipt with 200.
    if (replayed) retry.result.choices.push(choiceReceipt(retry.result, retry.posts[0]));
    await retry.page.getByRole('button', { name: 'Повторить сохранение решения', exact: true })
      .evaluate((node) => { node.click(); node.click(); });
    await durableCount(retry, 1);
    assert.equal(retry.posts.length, 2, 'one explicit retry despite a double click');
    assert.deepEqual(retry.posts[1], retry.posts[0], 'candidate/action/mutation/hash are retained');
    assert.equal(retry.result.choices.length, 1, 'replay does not create a second receipt');
    assert.equal(await localRecord(retry), null);
    assert.equal(await choice(retry, 1, 'Выбрать').isEnabled(), true);
    await retry.context.close();
  }
  for (const changed of ['actor', 'storage', 'replaced', 'missing']) {
    const retry = await scenario(); await countCards(retry, 5); retry.mode = 'network';
    await choice(retry, 0, 'Выбрать').click(); await statusHas(retry, 'Решение пока не подтверждено');
    await retryReady(retry);
    const stored = await localRecord(retry);
    if (changed === 'actor') await retry.page.evaluate(() => window.__switchActor('9009999999'));
    else if (changed === 'storage') await retry.page.evaluate(() => { Storage.prototype.getItem = () => { throw new Error('unreadable'); }; });
    else await retry.page.evaluate(({ key, changed }) => {
      if (changed === 'missing') sessionStorage.removeItem(key);
      else {
        const record = JSON.parse(sessionStorage.getItem(key));
        record.command.action = 'reject';
        sessionStorage.setItem(key, JSON.stringify(record));
      }
    }, { key: key, changed });
    await retry.page.getByRole('button', { name: 'Повторить сохранение решения', exact: true }).click();
    await statusHas(retry, changed === 'actor' ? 'Не удалось проверить результат' : 'Не удалось безопасно восстановить');
    assert.equal(retry.posts.length, 1, 'retry cannot use a foreign actor or unreadable retained record');
    assert.equal(await retry.page.getByRole('button', { name: 'Повторить сохранение решения', exact: true }).isHidden(), true);
    if (changed === 'actor') assert.equal(await localRecord(retry), stored);
    await retry.context.close();
  }

  const rejected = await scenario(); await countCards(rejected, 5); rejected.mode = 'reject422';
  const readsBeforeReject = rejected.gets;
  await choice(rejected, 0, 'Выбрать').click(); await statusHas(rejected, 'Это решение не сохранено');
  assert.ok(rejected.gets > readsBeforeReject, 'a definite refusal reconciles current owner via GET');
  assert.equal(await localRecord(rejected), null);
  assert.equal(await choice(rejected, 0, 'Выбрать').isEnabled(), true);
  assert.equal(rejected.posts.length, 1, 'no automatic resubmission of refused commands');
  rejected.mode = 'success'; await choice(rejected, 0, 'Выбрать').click(); await durableCount(rejected, 1);
  assert.notEqual(rejected.posts[0].mutationId, rejected.posts[1].mutationId, 'new command only on explicit second human action');
  await rejected.context.close();

  const conflict = await scenario(); await countCards(conflict, 5); conflict.mode = 'conflict409';
  conflict.result.choices.push(choiceReceipt(conflict.result, choiceCommand(conflict.result, 0, 'reject')));
  await choice(conflict, 0, 'Выбрать').click(); await durableCount(conflict, 1);
  assert.equal(await conflict.page.locator('.research-party__choice-status').first().textContent(), 'Отклонено');
  assert.equal(await localRecord(conflict), null); assert.equal(conflict.posts.length, 1);
  await conflict.context.close();

  const unavailable = await scenario({ storageDenied: true }); await countCards(unavailable, 5);
  await choice(unavailable, 0, 'Выбрать').click(); await statusHas(unavailable, 'Решение не отправлено');
  assert.equal(unavailable.posts.length, 0); await unavailable.context.close();

  const staleResult = readyResult(); const staleCommand = choiceCommand(staleResult);
  staleCommand.shortlistHash = '0'.repeat(64);
  const stale = await scenario({ stored: pendingRecord(staleResult, staleCommand) }); await countCards(stale, 5);
  await statusHas(stale, 'Не удалось безопасно восстановить');
  assert.equal(await choice(stale, 0, 'Выбрать').isDisabled(), true); assert.equal(stale.posts.length, 0);
  assert.equal(await stale.page.getByRole('button', { name: 'Повторить сохранение решения', exact: true }).isHidden(), true);
  await stale.context.close();

  for (const denied of [401, 403, 404]) {
    const state = await scenario(); await countCards(state, 5);
    state.getStatus = denied;
    await state.page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await statusHas(state, 'Результат недоступен этому аккаунту');
    assert.equal(await state.page.locator('.research-party__card').count(), 0);
    assert.equal(state.posts.length, 0); await state.context.close();
  }
  const foreign = await scenario(); await countCards(foreign, 5);
  foreign.mode = 'hold'; await choice(foreign, 0, 'Выбрать').click();
  await foreign.page.waitForFunction(() => document.querySelector('.research-party__status').textContent.includes('Решение пока'));
  while (!foreign.heldPost) await new Promise((resolve) => setTimeout(resolve, 20));
  const originalLocal = await localRecord(foreign);
  await foreign.page.evaluate(() => window.__switchActor('9009999999'));
  const saved = choiceReceipt(foreign.result, foreign.posts[0]);
  await foreign.heldPost.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
    schema: 'research.party-choice-response.v1', choice: saved, replayed: false,
  }) });
  await countCards(foreign, 0);
  assert.equal(await localRecord(foreign), originalLocal, 'old account uncertainty stays scoped, never becomes another actor choice');
  await foreign.page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await statusHas(foreign, 'Не удалось проверить результат');
  assert.equal(foreign.posts.length, 1); await foreign.context.close();

  const timeout = await scenario({ clock: true }); await countCards(timeout, 5);
  timeout.getMode = 'hang'; await timeout.page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await timeout.page.clock.fastForward(12_001); await statusHas(timeout, 'Не удалось проверить результат');
  timeout.getMode = 'success'; await timeout.page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await countCards(timeout, 5); assert.equal(timeout.posts.length, 0);
  await timeout.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await countCards(timeout, 0);
  await timeout.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await countCards(timeout, 5); assert.equal(timeout.posts.length, 0);
  await timeout.context.close();

  for (const mode of ['pending', 'legacy', 'help']) {
    const result = readyResult(); result.shortlist = null;
    if (mode === 'pending') { result.intake.terminal = null; result.intake.telegram = null; }
    if (mode === 'help') result.intake.terminal = { ...result.intake.terminal, status: 'NEEDS_HELP', normalizedPack: null,
      radar: null, blocker: { reasonCode: 'synthetic_blocker', safeSummary: 'Нужен допустимый источник' } };
    if (mode === 'legacy') result.intake.terminal.mutationId = '18800000-0000-4000-8000-000000000998';
    const state = await scenario({ result });
    await statusHas(state, mode === 'pending' ? 'В работе' : mode === 'help' ? 'Нужна помощь' : 'без доступного списка');
    assert.equal(await state.page.locator('.research-party__card').count(), 0); assert.equal(state.posts.length, 0);
    await state.context.close();
  }
  for (const options of [{ search: '?researchParty=broken' }, { search: '?researchParty=' },
    { search: '', start: 'rp_broken' },
    { search: `?researchParty=${requestId}&candidateFeedRelease=foreign` },
    { search: `?researchParty=${requestId}`, start: 'rp_18800000-0000-4000-8000-000000000999' }]) {
    const state = await scenario(options); await statusHas(state, 'Ссылка на Research недействительна');
    assert.equal(state.gets, 0); assert.equal(state.posts.length, 0); await state.context.close();
  }
  const mixed = await scenario({ start: `rp_${requestId}` }); await countCards(mixed, 5);
  await mixed.page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  assert.equal(await mixed.page.evaluate(() => window.__closeCount), 1);
  assert.equal(mixed.gets, 1, 'native close must not navigate into the same startParam again');
  await mixed.context.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, [], 'Research route must never boot games, versions, roster, telemetry or other API surfaces');
  console.log('research-party-browser: PASS (TMA route, 5/7 cards, immutable actions, refusals, uncertain reload, actor isolation, bounded reads, accessibility and mobile)');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
