/** Phone intake uses the real isolated TMA route; no worker bearer or live sources. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { actor, clone, fixture, hash } from './research-party-fixtures.mjs';

const capabilityGolden = fixture('phone-capability-v1.golden');
const acceptedGolden = fixture('phone-accepted-intake-v1.golden');
const actorKey = `research-party-create:v1:${actor}`;
const prefix = '/api/operator/research-parties';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'research-create-browser-'));
const server = createServer((request, response) => {
  if (new URL(request.url, 'http://fixture').pathname === '/') {
    response.setHeader('content-type', 'text/html'); response.end(readFileSync(path.join(buildRoot, 'index.html')));
  } else { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const built = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'], {
  cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, VITE_API_BASE: origin, VITE_MISSION_ENABLED: 'false', VITE_ISLAND_ENABLED: 'false' },
});
assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
let browser;
const unexpected = []; const errors = [];
const record = (command, owner = actor) => ({ schema: 'research.party-create-pending.v1', actorUserId: owner, command });
const accepted = (command) => ({ ...clone(acceptedGolden), request: clone(command), mutationId: command.mutationId, requestHash: hash(command) });
async function scenario({ search = '?researchParty=new', start = null, remaining = 50, capStatus = 200,
  enabled = true, stored = null, lookup = null, storageDenied = false, clock = false, width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ actor, start, actorKey, stored, storageDenied }) => {
    const init = (id) => 'query_id=synthetic&user=' + encodeURIComponent(JSON.stringify({ id: Number(id) })) + '&hash=synthetic';
    window.__closeCount = 0;
    window.Telegram = { WebApp: {
      initData: init(actor), initDataUnsafe: { user: { id: Number(actor) }, ...(start ? { start_param: start } : {}) }, platform: 'ios',
      ready() {}, expand() {}, disableVerticalSwipes() {}, enableClosingConfirmation() {}, setHeaderColor() {}, setBackgroundColor() {},
      lockOrientation() {}, onEvent() {}, offEvent() {}, close() { window.__closeCount++; },
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    } };
    window.__switchActor = (id) => { window.Telegram.WebApp.initData = init(id); window.Telegram.WebApp.initDataUnsafe.user = { id: Number(id) }; };
    if (stored) sessionStorage.setItem(actorKey, JSON.stringify(stored));
    if (storageDenied) Storage.prototype.setItem = function () { throw new Error('synthetic denied storage'); };
  }, { actor, start, actorKey, stored, storageDenied });
  const state = { page: null, context, capability: clone(capabilityGolden), capStatus, capCode: 'research_actor_not_initialized',
    mode: 'success', capReads: 0, lookups: [], lookup, posts: [], lookupHold: false, hold: null, capHang: false };
  state.capability.capability.remainingCalls = remaining; state.capability.capability.enabled = enabled;
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.href === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    if (url.origin === origin && url.pathname === '/') return route.continue();
    if (url.pathname.startsWith('/api/')) assert.match(request.headers().authorization, /^tma query_id=synthetic/);
    if (url.pathname === '/api/admin/lab-tokens') return route.fulfill({ json: { tokens: [] } });
    if (url.pathname === `${prefix}/capability` && request.method() === 'GET') {
      state.capReads++;
      if (state.capHang) { state.hold = route; return; }
      return route.fulfill({ status: state.capStatus, json: state.capStatus === 200 ? state.capability : { code: state.capCode } });
    }
    if (url.pathname.startsWith(`${prefix}/by-mutation/`) && request.method() === 'GET') {
      state.lookups.push(url.pathname.split('/').pop());
      if (state.lookupHold) { state.hold = route; return; }
      return route.fulfill(state.lookup ? { json: state.lookup } : { status: 404, json: { code: 'research_party_not_found' } });
    }
    if (url.pathname === prefix && request.method() === 'POST') {
      const command = request.postDataJSON(); state.posts.push(command);
      assert.deepEqual(JSON.parse(await state.page.evaluate((key) => sessionStorage.getItem(key), actorKey)).command, command,
        'exact mutation+command must exist in actor storage before POST');
      if (state.mode === 'hold') { state.hold = route; return; }
      if (state.mode === 'refusal') return route.fulfill({ status: 409, json: { code: 'research_daily_cap_stale' } });
      if (state.mode === 'auth') return route.fulfill({ status: 403, json: { detail: 'forbidden' } });
      if (state.mode === 'unknown500') return route.fulfill({ status: 503, json: { code: 'research_party_integrity' } });
      if (state.mode === 'lostAbsent') return route.abort('failed');
      const saved = accepted(command);
      if (state.mode === 'invalidsuccess') return route.fulfill({ json: { ...saved, requestHash: '0'.repeat(64) } });
      state.lookup = saved;
      if (state.mode === 'lostCommitted') return route.abort('failed');
      return route.fulfill({ status: 201, json: saved });
    }
    if (url.pathname === `${prefix}/${acceptedGolden.requestId}` && request.method() === 'GET') {
      return route.fulfill({ json: { schema: 'research.party-result.v1', actorUserId: state.capability.actorUserId,
        intake: state.lookup, shortlist: null, choices: [] } });
    }
    if (url.pathname !== '/favicon.ico') unexpected.push(`${request.method()} ${url.href}`);
    return route.fulfill({ status: 404, json: {} });
  });
  state.page = await context.newPage(); state.page.on('pageerror', (error) => errors.push(error.message));
  if (clock) await state.page.clock.install();
  await state.page.goto(origin + '/' + search, { waitUntil: 'domcontentloaded' });
  await state.page.locator('.lab-auth').waitFor();
  return state;
}
const statusHas = (state, text) => state.page.waitForFunction((text) => document.querySelector('.research-create .research-party__status')?.textContent.includes(text), text);
const submit = (state) => state.page.getByRole('button', { name: 'Создать заявку', exact: true });
async function formReady(state) { await state.page.locator('.research-create__form').waitFor({ state: 'visible' }); }
async function fill(state, budget = '12') {
  await state.page.getByLabel('R — Идеи и тренды', { exact: false }).check();
  await state.page.getByLabel('Poki', { exact: true }).check();
  await state.page.getByLabel('CrazyGames', { exact: true }).check();
  await state.page.getByLabel('Лимит обращений к источникам', { exact: true }).fill(budget);
}
async function snapshot(state, filename) {
  const dir = process.env.RESEARCH_PARTY_CAPTURE_DIR; if (!dir) return;
  mkdirSync(dir, { recursive: true }); await state.page.screenshot({ path: path.join(dir, filename), animations: 'disabled' });
}
try {
  browser = await chromium.launch();
  const lab = await scenario({ search: '?labAuth=1&keep=yes', start: 'lab_auth' });
  const entry = lab.page.locator('[data-testid="research-create-entry"]'); await entry.waitFor({ state: 'visible' });
  assert.equal(await lab.page.getByLabel('One-time code').evaluate((node) => node === document.activeElement), true, 'capability entry must not steal device-code focus');
  await entry.getByRole('button', { name: 'Новая заявка Research' }).click(); await formReady(lab);
  assert.equal(new URL(lab.page.url()).searchParams.has('labAuth'), false);
  assert.equal(new URL(lab.page.url()).searchParams.get('keep'), 'yes');
  assert.equal(await lab.page.locator('iframe,.game').count(), 0);
  assert.equal(lab.posts.length, 0); await lab.context.close();
  for (const options of [{ capStatus: 404 }, { enabled: false }]) {
    const hidden = await scenario({ search: '?labAuth=1', ...options });
    await hidden.page.getByLabel('One-time code').waitFor();
    assert.equal(await hidden.page.locator('[data-testid="research-create-entry"]').isHidden(), true);
    assert.equal(await hidden.page.getByLabel('One-time code').isEnabled(), true);
    await hidden.context.close();
  }
  const normal = await scenario({ start: 'rp_new' }); await formReady(normal);
  assert.equal(await submit(normal).isDisabled(), true);
  assert.equal(await normal.page.getByLabel('Meta Ad Library', { exact: false }).isDisabled(), true);
  await snapshot(normal, '03-create-390.png');
  await fill(normal, '0'); assert.equal(await submit(normal).isDisabled(), true, 'phone form does not launch empty zero-call parties');
  await fill(normal, '51'); assert.equal(await submit(normal).isDisabled(), true);
  await fill(normal, '12');
  await normal.page.getByLabel('Meta Ad Library', { exact: false }).evaluate((node) => {
    node.disabled = false; node.checked = true; node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await submit(normal).isDisabled(), true, 'DOM tampering cannot widen source policy');
  await normal.page.getByLabel('Meta Ad Library', { exact: false }).evaluate((node) => {
    node.checked = false; node.disabled = true; node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submit(normal).evaluate((node) => { node.click(); node.click(); }); await statusHas(normal, 'Заявка сохранена');
  assert.equal(normal.posts.length, 1); assert.deepEqual(normal.posts[0].sourceIds, ['crazygames-charts', 'poki-charts']);
  assert.equal(await normal.page.locator('.research-create').innerText().then((text) => text.includes('Это ещё не готовый Research')), true);
  await normal.page.getByRole('button', { name: 'Открыть результат' }).click();
  await normal.page.getByRole('main', { name: 'Результаты Research', exact: true }).waitFor();
  assert.equal(await normal.page.locator('.research-create').count(), 0);
  assert.equal(new URL(normal.page.url()).searchParams.get('researchParty'), 'new', 'same-page result keeps signed rp_new intact');
  await normal.page.reload(); await statusHas(normal, 'Заявка сохранена');
  assert.equal(normal.posts.length, 1); assert.equal(normal.lookups.at(-1), normal.posts[0].mutationId);
  await normal.page.getByRole('button', { name: 'Новая заявка', exact: true }).click(); await formReady(normal);
  assert.equal(await normal.page.evaluate((key) => sessionStorage.getItem(key), actorKey), null);
  assert.equal(normal.posts.length, 1); await normal.context.close();

  const empty = await scenario({ remaining: 0 }); await formReady(empty); await fill(empty, '1');
  await statusHas(empty, 'Дневной лимит исчерпан'); assert.equal(await submit(empty).isDisabled(), true); await empty.context.close();
  const recoveredZero = await scenario({ remaining: 0, stored: record(acceptedGolden.request), lookup: acceptedGolden });
  await statusHas(recoveredZero, 'Заявка сохранена'); assert.equal(recoveredZero.posts.length, 0);
  assert.equal(recoveredZero.lookups.length, 1, 'zero remaining does not hide historical GET recovery'); await recoveredZero.context.close();

  for (const mode of ['lostAbsent', 'unknown500', 'invalidsuccess', 'lostCommitted']) {
    const state = await scenario(); await formReady(state); await fill(state); state.mode = mode;
    await submit(state).click(); await statusHas(state, mode === 'lostCommitted' ? 'Заявка сохранена' : 'Сохранение заявки пока не подтверждено');
    const stored = await state.page.evaluate((key) => sessionStorage.getItem(key), actorKey); assert.ok(stored);
    await state.page.reload(); await statusHas(state, mode === 'lostCommitted' ? 'Заявка сохранена' : 'Сохранение заявки пока не подтверждено');
    assert.equal(state.posts.length, 1); assert.equal(await state.page.evaluate((key) => sessionStorage.getItem(key), actorKey), stored);
    if (mode !== 'lostCommitted') {
      assert.equal(await state.page.getByRole('button', { name: 'Новая заявка', exact: true }).isHidden(), true);
      state.lookup = accepted(state.posts[0]);
      await state.page.getByRole('button', { name: 'Обновить', exact: true }).click(); await statusHas(state, 'Заявка сохранена');
    }
    assert.equal(state.posts.length, 1); await state.context.close();
  }
  const refused = await scenario(); await formReady(refused); await fill(refused); refused.mode = 'refusal';
  await submit(refused).click(); await statusHas(refused, 'Заявка не сохранена'); await formReady(refused);
  assert.equal(refused.posts.length, 1); assert.equal(await refused.page.evaluate((key) => sessionStorage.getItem(key), actorKey), null);
  refused.mode = 'success'; await submit(refused).click(); await statusHas(refused, 'Заявка сохранена');
  assert.notEqual(refused.posts[0].mutationId, refused.posts[1].mutationId); await refused.context.close();

  const forbidden = await scenario(); await formReady(forbidden); await fill(forbidden); forbidden.mode = 'auth';
  await submit(forbidden).click(); await statusHas(forbidden, 'Сохранение не подтверждено');
  assert.equal(await forbidden.page.getByRole('button', { name: 'Открыть результат' }).isHidden(), true);
  const forbiddenIntent = await forbidden.page.evaluate((key) => sessionStorage.getItem(key), actorKey);
  await forbidden.page.reload(); await statusHas(forbidden, 'Сохранение заявки пока не подтверждено');
  assert.equal(await forbidden.page.evaluate((key) => sessionStorage.getItem(key), actorKey), forbiddenIntent);
  assert.equal(forbidden.posts.length, 1, '403 never becomes accepted or a fresh automatic command');
  await forbidden.context.close();

  const suspended = await scenario(); await formReady(suspended); await fill(suspended); suspended.mode = 'hold';
  await submit(suspended).click();
  for (let i = 0; !suspended.hold && i < 100; i++) await suspended.page.waitForTimeout(20);
  assert.ok(suspended.hold);
  const heldCommand = clone(suspended.posts[0]);
  await suspended.page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  suspended.lookup = accepted(heldCommand);
  await suspended.hold.fulfill({ status: 201, json: suspended.lookup });
  await statusHas(suspended, 'Заявка сохранена');
  assert.deepEqual(suspended.posts, [heldCommand]);
  assert.deepEqual(suspended.lookups, [heldCommand.mutationId], 'BFCache resumes exact GET after the in-flight POST settles');
  await suspended.page.getByRole('button', { name: 'Открыть результат' }).click();
  await suspended.page.getByRole('main', { name: 'Результаты Research', exact: true }).waitFor();
  await suspended.context.close();

  const deniedStorage = await scenario({ storageDenied: true }); await formReady(deniedStorage); await fill(deniedStorage);
  await submit(deniedStorage).click(); await statusHas(deniedStorage, 'Запрос не отправлен');
  assert.equal(deniedStorage.posts.length, 0); await deniedStorage.context.close();
  const uninitialized = await scenario({ capStatus: 409 });
  await statusHas(uninitialized, 'Сначала откройте обычную ленту'); assert.equal(uninitialized.posts.length, 0); await uninitialized.context.close();

  const draft = await scenario({ width: 320 }); await formReady(draft); await fill(draft);
  const budget = draft.page.getByLabel('Лимит обращений к источникам', { exact: true }); await budget.focus();
  await draft.page.evaluate(() => { window.__focus = document.activeElement; window.__live = document.querySelector('.research-create .research-party__status'); });
  await draft.page.getByRole('button', { name: 'Обновить', exact: true }).evaluate((node) => node.click());
  await formReady(draft); await draft.page.waitForTimeout(80);
  assert.equal(await budget.inputValue(), '12');
  assert.equal(await draft.page.evaluate(() => window.__focus === document.activeElement && window.__live === document.querySelector('.research-create .research-party__status')), true);
  assert.equal(await draft.page.locator('.research-create').evaluate((node) => node.scrollWidth > node.clientWidth), false);
  await submit(draft).scrollIntoViewIfNeeded(); await snapshot(draft, '04-create-actions-320.png');
  draft.capStatus = 503; draft.capCode = 'research_party_integrity';
  await draft.page.getByRole('button', { name: 'Обновить', exact: true }).click(); await statusHas(draft, 'Не удалось проверить доступ');
  draft.capStatus = 200;
  await draft.page.getByRole('button', { name: 'Обновить', exact: true }).click(); await formReady(draft);
  assert.equal(await budget.inputValue(), '12', 'temporary read failure does not clear same-account draft');
  await draft.page.evaluate(() => window.__switchActor('9009999999'));
  draft.capability.actorUserId = '9009999999';
  await draft.page.getByRole('button', { name: 'Обновить', exact: true }).click(); await formReady(draft);
  assert.equal(await budget.inputValue(), ''); assert.equal(await draft.page.locator('input:checked').count(), 0, 'new actor never inherits old draft');
  assert.equal(draft.posts.length, 0); await draft.context.close();

  const foreign = await scenario({ stored: record(acceptedGolden.request) });
  await statusHas(foreign, 'Сохранение заявки пока не подтверждено'); foreign.lookupHold = true;
  await foreign.page.getByRole('button', { name: 'Обновить', exact: true }).click();
  for (let i = 0; !foreign.hold && i < 100; i++) await foreign.page.waitForTimeout(20);
  assert.ok(foreign.hold); await foreign.page.evaluate(() => window.__switchActor('9009999999'));
  await foreign.hold.fulfill({ status: 404, json: { code: 'research_party_not_found' } });
  await statusHas(foreign, 'Не удалось проверить доступ');
  assert.equal(await foreign.page.locator('.research-create__form').isHidden(), true); assert.equal(foreign.posts.length, 0);
  await foreign.context.close();

  const timed = await scenario({ clock: true }); await formReady(timed); timed.capHang = true;
  await timed.page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await timed.page.clock.fastForward(12_001); await statusHas(timed, 'Не удалось проверить доступ');
  timed.capHang = false; await timed.page.getByRole('button', { name: 'Обновить', exact: true }).click(); await formReady(timed);
  assert.equal(timed.posts.length, 0); await timed.context.close();
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, [], 'no normal feed, onboarding, telemetry, source fetch or worker endpoints');
  console.log('research-party-create-browser: PASS (capability-only LAB entry, explicit bounded create, exact mutation recovery, zero-limit recovery and actor isolation)');
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve)); rmSync(buildRoot, { recursive: true, force: true });
}
