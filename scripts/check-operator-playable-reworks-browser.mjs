import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  OPERATOR_FORM_KEYBOARD_GEOMETRIES,
  applyOperatorFormGeometry,
  describeOperatorFormField,
} from './operator-form-visibility.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The control is served as its real ES module graph, so its shared imports
// (screenshot preparation) resolve exactly as they do in the production bundle.
const MODULE_PATH = /^\/[a-z0-9-]+\.mjs$/;
let origin = '';

const fixture = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="host"></div><script type="module">
import { mountOperatorPlayableReworkControl, screenshotFromFile } from '/operator-playable-reworks.mjs';
import { observeOperatorFormViewport } from '/operator-form-viewport.mjs';
// ?viewport=1 reproduces the production composition this control actually ships
// in: the real stylesheet, and the host inside the bottom feed bar, inside the
// .feed container that clips everything above the top zone. That is the only place its
// popover geometry — anchored above the bar, growing upward — can be measured
// against a shrinking (keyboard) viewport.
const barComposition = () => {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/styles.css';
  document.head.append(stylesheet);
  const viewport = document.createElement('div');
  viewport.className = 'viewport';
  const feed = document.createElement('div');
  feed.className = 'feed';
  const bar = document.createElement('div');
  bar.className = 'feed-bar';
  document.body.append(viewport);
  viewport.append(feed);
  feed.append(bar);
  return bar;
};
if (new URL(location.href).searchParams.has('viewport')) {
  barComposition().append(document.querySelector('#host'));
}
// ?fakeViewport=1 stages the case no browser harness can produce: a host that
// shrinks the VISUAL viewport for the keyboard and leaves the LAYOUT viewport
// alone (visualViewport.height < innerHeight, offsetTop > 0). Playwright's
// setViewportSize always moves both, so without an injectable source the
// divergent host is never exercised — and a bottom-anchored popover that is
// only shortened there sinks further behind the keyboard. The helper is
// measured directly, so it must carry the geometry on its own.
if (new URL(location.href).searchParams.has('fakeViewport')) {
  const bar = barComposition();
  const holder = document.createElement('div');
  holder.className = 'game__operator-playable-rework';
  const form = document.createElement('form');
  form.className = 'game__operator-flag-form';
  form.innerHTML = '<label>Что поправить'
    + '<textarea name="instruction" rows="4"></textarea></label>'
    + '<p>наполнитель, чтобы форма была выше доступной полосы</p>'.repeat(6);
  holder.append(form);
  bar.append(holder);
  class FakeVisualViewport extends EventTarget {
    constructor(height, offsetTop) { super(); this.height = height; this.offsetTop = offsetTop; }
    move(height, offsetTop, type) {
      this.height = height;
      this.offsetTop = offsetTop;
      this.dispatchEvent(new Event(type));
    }
  }
  window.fakeViewport = new FakeVisualViewport(300, 40);
  window.fakeForm = form;
  window.fakeObserver = observeOperatorFormViewport(form, { viewport: window.fakeViewport });
}
const occurrence = {
  playableId: 'solitaire-v1-swipe',
  mappingId: '11111111-1111-5111-8111-111111111111',
  rosterActivationId: '22222222-2222-5222-8222-222222222222',
  runtime: {
    version: 'fixture-v1',
    artifactDigest: 'sha256:${'3'.repeat(64)}',
    sourceCommit: '${'4'.repeat(40)}',
  },
  feedPosition: 6,
  level: null,
  runId: null,
};
const request = (id, instruction) => ({
  schema: 'feed.playable-rework.request.v1', mutationId: id,
  playableId: occurrence.playableId, mappingId: occurrence.mappingId,
  rosterActivationId: occurrence.rosterActivationId, runtime: occurrence.runtime,
  context: {
    feedPosition: occurrence.feedPosition, level: null, runId: null,
    capturedAt: '2026-08-14T12:00:00.000Z',
    screenshot: { kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null },
  },
  instruction,
});
const escalation = (requestId, requestHash) => ({
  schema: 'feed.playable-escalation.v1', requestId, requestHash,
  decision: 'pending', actionable: true, allowedDecisions: ['do', 'obsolete'],
  issue: {
    status: 'confirmed', url: 'https://github.com/Glera/p4g-workspace-meta/issues/140', number: 140,
  },
  routing: { status: 'not_requested', ticketDigest: null, boundAt: null },
  root: { state: 'open', administrativeClosure: null },
  replayed: false,
});
const fixtureParams = new URL(location.href).searchParams;
const queue = fixtureParams.has('escalation') ? [
  {
    requestId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa', state: 'open',
    requestHash: '${'a'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 3, queued: 0 },
    execution: {
      state: 'blocked', code: 'playable_rework_agent_unsupported',
      summary: 'Эта правка требует обычной разработки.', updatedAt: '2026-08-14T12:10:00.000Z',
    },
    operatorPresentation: {
      kind: 'capability_gap_root', effectDelivered: false,
      escalation: escalation('aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa', '${'a'.repeat(64)}'),
    },
    request: request('aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa', 'Добавить новый игровой режим.'),
    createdAt: '2026-08-14T12:10:00.000Z',
  },
  {
    requestId: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb', state: 'open',
    requestHash: '${'b'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 3, queued: 0 },
    execution: {
      state: 'blocked', code: 'playable_rework_agent_unsupported',
      summary: 'Эта правка требует обычной разработки.', updatedAt: '2026-08-14T12:00:00.000Z',
    },
    operatorPresentation: {
      kind: 'capability_gap_root', effectDelivered: false,
      escalation: escalation('bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb', '${'b'.repeat(64)}'),
    },
    request: request('bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb', 'Устаревшая идея.'),
    createdAt: '2026-08-14T12:00:00.000Z',
  },
  {
    requestId: 'cccccccc-cccc-5ccc-8ccc-cccccccccccc', state: 'open',
    requestHash: '${'c'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 3, queued: 0 },
    execution: {
      state: 'blocked', code: 'playable_rework_agent_unsupported',
      summary: 'Эта правка требует обычной разработки.', updatedAt: '2026-08-14T11:50:00.000Z',
    },
    operatorPresentation: {
      kind: 'capability_gap_root', effectDelivered: false,
      escalation: escalation('cccccccc-cccc-5ccc-8ccc-cccccccccccc', '${'c'.repeat(64)}'),
    },
    request: request('cccccccc-cccc-5ccc-8ccc-cccccccccccc', 'Закрыть неактуальную идею.'),
    createdAt: '2026-08-14T11:50:00.000Z',
  },
] : fixtureParams.has('honesty') ? [
  {
    requestId: '88888888-8888-5888-8888-888888888888', state: 'open',
    requestHash: '${'8'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 2, queued: 0 },
    operatorPresentation: { kind: 'current', effectDelivered: true },
    request: request('88888888-8888-5888-8888-888888888888', 'Уже доставленная правка.'),
    createdAt: '2026-08-14T12:10:00.000Z',
  },
  {
    requestId: '99999999-9999-5999-8999-999999999999', state: 'open',
    requestHash: '${'9'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 2, queued: 0 },
    operatorPresentation: { kind: 'superseded', effectDelivered: false },
    request: request('99999999-9999-5999-8999-999999999999', 'Уже заменённая правка.'),
    createdAt: '2026-08-14T12:00:00.000Z',
  },
] : fixtureParams.has('queue') ? [
  {
    requestId: '66666666-6666-5666-8666-666666666666', state: 'open',
    requestHash: '${'6'.repeat(64)}',
    sourceAdapter: 'telegram', queueDisposition: 'active_batch', batchPresent: true,
    queueCounts: { active: 1, queued: 1 },
    request: request('66666666-6666-5666-8666-666666666666', 'Исправить центрирование.'),
    createdAt: '2026-08-14T12:00:00.000Z',
  },
  {
    requestId: '77777777-7777-5777-8777-777777777777', state: 'open',
    requestHash: '${'7'.repeat(64)}',
    sourceAdapter: 'codex', queueDisposition: 'queued', batchPresent: false,
    queueCounts: { active: 1, queued: 1 },
    request: request('77777777-7777-5777-8777-777777777777', 'Перезапечь обложку.'),
    createdAt: '2026-08-14T12:05:00.000Z',
  },
] : [];
window.lastRequest = null;
window.submitGate = Promise.resolve();
window.submitError = false;
window.submitReplay = false;
window.refreshes = 0;
window.cancelledTasks = [];
window.escalationDecisions = [];
window.escalationGate = Promise.resolve();
window.escalationError = false;
window.mutationIds = [
  '55555555-5555-5555-8555-555555555555',
  '66666666-6666-5666-8666-666666666666',
  '77777777-7777-5777-8777-777777777777',
];
window.normalizeScreenshot = screenshotFromFile;
window.control = mountOperatorPlayableReworkControl(document.querySelector('#host'), {
  occurrence,
  queue,
  createMutationId: () => window.mutationIds.shift(),
  submit: async (request) => {
    window.lastRequest = request;
    await window.submitGate;
    if (window.submitError) throw Object.assign(new Error('offline'), { status: 0 });
    return { replayed: window.submitReplay };
  },
  cancel: async (task) => { window.cancelledTasks.push(task); },
  escalate: async (task, decision, mutationId) => {
    window.escalationDecisions.push({ task, decision, mutationId });
    await window.escalationGate;
    if (window.escalationError) throw Object.assign(new Error('offline'), { status: 0 });
    const current = task.operatorPresentation.escalation;
    return {
      ...current,
      decision: decision === 'do' ? 'accepted' : 'obsolete',
      actionable: false,
      allowedDecisions: [],
      routing: decision === 'do'
        ? { status: 'pending', ticketDigest: null, boundAt: null }
        : { status: 'not_requested', ticketDigest: null, boundAt: null },
      root: decision === 'do'
        ? { state: 'open', administrativeClosure: null }
        : {
          state: 'closed',
          administrativeClosure: {
            kind: 'administrative', reason: 'obsolete', note: 'Отменено оператором как неактуальное.',
          },
        },
    };
  },
  refresh: () => { window.refreshes += 1; },
});
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (url.pathname === '/styles.css') {
    response.setHeader('content-type', 'text/css; charset=utf-8');
    response.end(readFileSync(path.join(root, 'src', 'styles.css')));
    return;
  }
  if (MODULE_PATH.test(url.pathname)) {
    try {
      const source = readFileSync(path.join(root, 'src', url.pathname.slice(1)));
      response.setHeader('content-type', 'application/javascript; charset=utf-8');
      response.end(source);
    } catch {
      response.statusCode = 404;
      response.end();
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fixture);
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.game__operator-flag-open').click();
  await page.locator('textarea[name="instruction"]').fill('Сделать автоплей понятнее.');

  const shortEdgeResult = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1_200;
    canvas.height = 280;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7346d8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    return window.normalizeScreenshot(new File([blob], 'panorama.webp', { type: blob.type }));
  });
  assert.equal(shortEdgeResult.kind, 'data_url');
  assert.equal(shortEdgeResult.mimeType, 'image/jpeg');
  assert.ok(shortEdgeResult.dataUrl.length <= 500_000);

  const phonePngDataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1_280;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[index] = seed & 255;
      pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  });
  const phonePng = Buffer.from(phonePngDataUrl.split(',')[1], 'base64');
  assert.ok(phonePng.length > 380_000, 'fixture must exceed the former phone screenshot limit');

  const remountPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await remountPage.goto(origin, { waitUntil: 'domcontentloaded' });
  await remountPage.locator('.game__operator-flag-open').click();
  await remountPage.locator('textarea[name="instruction"]').fill('Не переносить на следующую механику.');
  await remountPage.locator('input[name="screenshot"]').setInputFiles({
    name: 'phone-screenshot.png', mimeType: 'image/png', buffer: phonePng,
  });
  await remountPage.locator('button[type="submit"]').click();
  await remountPage.locator('.game__operator-flag-status').waitFor({ state: 'visible' });
  await remountPage.evaluate(() => window.control.destroy());
  await remountPage.waitForTimeout(500);
  assert.equal(await remountPage.evaluate(() => window.lastRequest), null);
  await remountPage.close();

  const input = page.locator('input[name="screenshot"]');
  const selection = page.locator('[data-rework-screenshot]');
  await input.setInputFiles({ name: 'phone-screenshot.png', mimeType: 'image/png', buffer: phonePng });
  await selection.waitFor({ state: 'visible' });
  assert.match(await selection.innerText(), /phone-screenshot\.png/);
  assert.match(await selection.innerText(), /подготовим автоматически/);

  await selection.locator('[data-action="remove-screenshot"]').click();
  assert.equal(await input.inputValue(), '');
  await selection.waitFor({ state: 'hidden' });

  await input.setInputFiles({ name: 'phone-screenshot.png', mimeType: 'image/png', buffer: phonePng });
  await page.evaluate(() => { window.submitError = true; });
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.game__operator-flag-status')?.textContent.includes('Нет связи'));
  await page.locator('[data-action="cancel"]').click();
  await page.locator('.game__operator-flag-open').click();
  assert.equal(await page.locator('.game__operator-flag-status').innerText(), '',
    'a fresh capture must not inherit the previous attempt status');
  await page.locator('textarea[name="instruction"]').fill('Сделать автоплей понятнее после retry.');
  await page.evaluate(() => { window.lastRequest = null; window.submitError = false; });
  await page.evaluate(() => {
    window.submitGate = new Promise((resolve) => { window.releaseSubmit = resolve; });
  });
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => window.lastRequest !== null);
  assert.equal(await page.evaluate(() => window.lastRequest.instruction), 'Сделать автоплей понятнее после retry.');
  assert.equal(await input.isDisabled(), true);
  assert.equal(await selection.locator('[data-action="remove-screenshot"]').isDisabled(), true);
  const screenshot = await page.evaluate(() => window.lastRequest.context.screenshot);
  assert.equal(screenshot.kind, 'data_url');
  assert.equal(screenshot.mimeType, 'image/jpeg');
  assert.match(screenshot.dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(screenshot.dataUrl.length <= 500_000, 'normalized screenshot exceeds transport budget');
  await page.evaluate(() => window.releaseSubmit());
  assert.equal(await page.locator('.game__operator-flag-status').innerText(), 'Замечание сохранено.');
  await page.close();

  const queuePage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await queuePage.goto(`${origin}/?queue=1`, { waitUntil: 'domcontentloaded' });
  const queueOpen = queuePage.locator('.game__operator-flag-open');
  assert.equal(await queueOpen.getAttribute('aria-label'), 'В работе · ещё 1');
  assert.equal(await queuePage.locator('[data-rework-count]').innerText(), '2');
  await queueOpen.click();
  const details = queuePage.locator('.game__operator-playable-rework-details');
  await details.waitFor({ state: 'visible' });
  assert.equal(await details.locator('.game__operator-playable-rework-item').count(), 2);
  assert.match(await details.innerText(), /Исправить центрирование\./);
  assert.match(await details.innerText(), /Перезапечь обложку\./);
  assert.match(await details.innerText(), /Telegram/);
  assert.match(await details.innerText(), /Codex/);
  assert.equal(await details.locator('[data-action="obsolete-rework"]').count(), 2);
  await details.locator('[data-action="obsolete-rework"]').nth(1).click();
  await queuePage.waitForFunction(() => window.cancelledTasks.length === 1);
  assert.deepEqual(await queuePage.evaluate(() => ({
    requestId: window.cancelledTasks[0].requestId,
    requestHash: window.cancelledTasks[0].requestHash,
  })), {
    requestId: '77777777-7777-5777-8777-777777777777',
    requestHash: '7'.repeat(64),
  });
  const cancelledRow = details.locator('.game__operator-playable-rework-item').nth(1);
  assert.equal(await cancelledRow.locator('b').innerText(), 'Неактуально');
  assert.equal(await queueOpen.getAttribute('aria-label'), 'В работе · добавить замечание');
  assert.equal(await queuePage.locator('[data-rework-count]').innerText(), '1');
  assert.equal(await details.isVisible(), true,
    'cancelling a row remounted and destroyed the open queue details');
  assert.equal(await queuePage.evaluate(() => window.refreshes), 0,
    'cancelling a row issued a redundant projection refresh from the mounted control');
  await details.locator('[data-action="add-feedback"]').click();
  await queuePage.locator('[data-action="cancel"]').click();
  assert.equal(
    await details.locator('[data-action="close-details"]').evaluate((element) => document.activeElement === element),
    true,
    'cancelling queue capture must focus the reopened queue details',
  );
  await details.locator('[data-action="add-feedback"]').click();
  await queuePage.locator('textarea[name="instruction"]').fill('Добавить ещё одно замечание.');
  await queuePage.locator('button[type="submit"]').click();
  await queuePage.locator('.game__operator-flag-status')
    .filter({ hasText: 'это попадёт в следующий пакет' }).waitFor();
  assert.equal(await queuePage.locator('.game__operator-playable-rework').getAttribute('data-rework-submit-result'), 'saved');
  await queuePage.waitForFunction(() => window.refreshes === 1);
  assert.equal(await queueOpen.evaluate((element) => document.activeElement === element), true,
    'successful queue capture must restore focus to the persistent action');
  await queueOpen.click();
  await details.locator('[data-action="add-feedback"]').click();
  await queuePage.locator('textarea[name="instruction"]').fill('Повторить сохранённое замечание.');
  await queuePage.evaluate(() => { window.submitReplay = true; });
  await queuePage.locator('button[type="submit"]').click();
  await queuePage.locator('.game__operator-flag-status')
    .filter({ hasText: 'Такое замечание уже сохранено' }).waitFor();
  await queuePage.close();

  const escalationPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await escalationPage.goto(`${origin}/?escalation=1`, { waitUntil: 'domcontentloaded' });
  const escalationOpen = escalationPage.locator('.game__operator-flag-open');
  assert.equal(await escalationOpen.getAttribute('aria-label'), 'Нужна помощь · добавить замечание');
  await escalationOpen.click();
  const escalationDetails = escalationPage.locator('.game__operator-playable-rework-details');
  await escalationDetails.waitFor({ state: 'visible' });
  assert.equal(await escalationDetails.locator('[data-action="escalate-rework"]').count(), 3);
  assert.equal(await escalationDetails.locator('[data-action="obsolete-escalation"]').count(), 3);
  assert.equal(await escalationDetails.locator('.game__operator-playable-rework-escalation-issue').count(), 3);
  assert.match(await escalationDetails.innerText(), /Делать \(~день Mac B\)/);
  await escalationPage.evaluate(() => {
    window.escalationGate = new Promise((resolve) => { window.releaseEscalation = resolve; });
    window.escalationError = true;
  });
  await escalationDetails.locator('[data-action="escalate-rework"]').first().click();
  assert.equal(await escalationDetails.locator('[data-action="escalate-rework"]').first().isDisabled(), true);
  assert.match(
    await escalationDetails.locator('[data-escalation-status]').first().innerText(),
    /Передаю Mac B/,
  );
  await escalationPage.evaluate(() => window.releaseEscalation());
  await escalationDetails.locator('[data-escalation-status]').first()
    .filter({ hasText: 'Повторите то же действие' }).waitFor();
  assert.equal(
    await escalationDetails.locator('[data-action="obsolete-escalation"]').first().isDisabled(),
    true,
    'ambiguous do outcome must not allow the opposite decision',
  );
  await escalationPage.evaluate(() => { window.escalationError = false; });
  await escalationDetails.locator('[data-action="escalate-rework"]').first().click();
  await escalationDetails.locator('.game__operator-playable-rework-item').first().locator('b')
    .filter({ hasText: 'Тикет создан · передаётся Mac B' }).waitFor();
  assert.deepEqual(await escalationPage.evaluate(() => window.escalationDecisions.slice(0, 2)
    .map(({ task, decision, mutationId }) => ({ requestId: task.requestId, decision, mutationId }))), [
    {
      requestId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      decision: 'do', mutationId: '55555555-5555-5555-8555-555555555555',
    },
    {
      requestId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      decision: 'do', mutationId: '55555555-5555-5555-8555-555555555555',
    },
  ]);
  await escalationDetails.locator('[data-action="escalate-rework"]').first().click();
  await escalationDetails.locator('.game__operator-playable-rework-item').nth(1).locator('b')
    .filter({ hasText: 'Тикет создан · передаётся Mac B' }).waitFor();
  assert.deepEqual(await escalationPage.evaluate(() => {
    const { task, decision, mutationId } = window.escalationDecisions[2];
    return { requestId: task.requestId, decision, mutationId };
  }), {
    requestId: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
    decision: 'do', mutationId: '66666666-6666-5666-8666-666666666666',
  }, 'two different roots reused one decision mutation identity');
  await escalationDetails.locator('[data-action="obsolete-escalation"]').click();
  await escalationDetails.locator('.game__operator-playable-rework-item').nth(2).locator('b')
    .filter({ hasText: 'Неактуально' }).waitFor();
  assert.equal(await escalationDetails.locator('[data-action="escalate-rework"]').count(), 0);
  assert.equal(await escalationDetails.locator('[data-action="obsolete-escalation"]').count(), 0);
  assert.equal(await escalationOpen.getAttribute('aria-label'), 'В работе · добавить замечание');
  assert.equal(await escalationPage.locator('[data-rework-count]').innerText(), '2');
  await escalationPage.close();

  const honestyPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await honestyPage.goto(`${origin}/?honesty=1`, { waitUntil: 'domcontentloaded' });
  const honestyOpen = honestyPage.locator('.game__operator-flag-open');
  assert.equal(await honestyOpen.getAttribute('aria-label'), 'Готово к проверке');
  await honestyOpen.click();
  const honestyDetails = honestyPage.locator('.game__operator-playable-rework-details');
  await honestyDetails.waitFor({ state: 'visible' });
  const honestyText = await honestyDetails.innerText();
  assert.doesNotMatch(honestyText, /В работе/,
    'delivered and superseded rows remained presented as in progress');
  assert.match(honestyText, /Готово к проверке/);
  assert.match(honestyText, /Заменена следующей правкой/);
  assert.equal(await honestyDetails.locator('[data-action="obsolete-rework"]').count(), 0,
    'historical rows exposed an operator cancellation action');
  await honestyPage.close();

  // The on-screen keyboard shrinks the visible viewport from the bottom. This
  // popover is anchored above the feed bar and grows UPWARD, so the instruction
  // textarea used to be pushed clean off the top of the screen and the operator
  // typed blind (iOS Telegram dogfood on the sibling intake form,
  // Glera/p4g-workspace-meta#108 comment 5324549317). The focused field must
  // stay inside whatever height the keyboard leaves.
  // "On screen" is asserted against every clipping ancestor, not against the
  // window: this popover lives inside `.feed`, which clips everything above
  // `--top-zone-h`, so a rect-in-viewport test passes on states where the field
  // is entirely behind that edge.
  const keyboardPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await keyboardPage.goto(`${origin}/?viewport=1`, { waitUntil: 'domcontentloaded' });
  await keyboardPage.waitForFunction(() => getComputedStyle(document.querySelector('.feed-bar')).position === 'absolute');
  await keyboardPage.locator('.game__operator-flag-open').click();
  const keyboardFieldSelector = '.game__operator-flag-form textarea[name="instruction"]';
  await keyboardPage.locator(keyboardFieldSelector).click();
  await keyboardPage.evaluate(() => {
    window.keptForm = document.querySelector('.game__operator-flag-form');
  });
  for (const geometry of OPERATOR_FORM_KEYBOARD_GEOMETRIES) {
    const measured = await applyOperatorFormGeometry(keyboardPage, geometry, keyboardFieldSelector);
    const where = describeOperatorFormField(measured);
    assert.equal(measured.focused, true,
      `the keyboard simulation lost focus at ${geometry.name}`);
    assert.equal(measured.visible, true,
      `the focused rework field is clipped away at ${geometry.name}: ${where}`);
    assert.equal(measured.hitsField, true,
      `the rework field is not the element at its own centre at ${geometry.name}: ${where}`);
    assert.equal(measured.formWithinClip, true,
      `the rework popover itself overflows its clipping ancestor at ${geometry.name}: ${where}`);
    assert.ok(/^\d+px$/.test(measured.published.maxHeight),
      `no measured height was published to the rework form at ${geometry.name}`);
    // `.feed` has no scrollbar and no gesture, so any offset on it is an engine
    // caret-reveal that drags the whole bar — and this popover — off screen.
    assert.equal(measured.feedScrollTop, 0,
      `the feed was left displaced under the rework popover at ${geometry.name}: ${where}`);
  }

  // Cleanup is the control's own destroy path: every published property is
  // withdrawn and no later resize may re-assert anything.
  const publishedOn = (handle) => keyboardPage.evaluate((name) => {
    const form = window[name];
    return [
      form.style.getPropertyValue('--operator-form-lift'),
      form.style.getPropertyValue('--operator-form-max-height'),
      form.style.getPropertyValue('--operator-form-field-max-height'),
    ].join('|');
  }, handle);
  await keyboardPage.evaluate(() => window.control.destroy());
  assert.equal(await publishedOn('keptForm'), '||',
    'destroy left a measured bound on the detached form');
  await keyboardPage.setViewportSize({ width: 390, height: 520 });
  await keyboardPage.waitForTimeout(600);
  assert.equal(await publishedOn('keptForm'), '||',
    'a resize after destroy still reached a leaked visual-viewport listener');
  await keyboardPage.close();

  // The divergent host: the visual viewport shrinks for the keyboard while the
  // layout viewport does not. `setViewportSize` moves both, so this is staged
  // through the helper's injectable viewport source. Bounding alone is wrong
  // here — a bottom-anchored popover must also be LIFTED out from behind the
  // keyboard, and the geometry has to follow visualViewport `scroll` (which iOS
  // fires without a resize) as well as `resize`.
  const divergent = await browser.newPage({ viewport: { width: 390, height: 600 } });
  await divergent.goto(`${origin}/?fakeViewport=1`, { waitUntil: 'domcontentloaded' });
  await divergent.waitForFunction(() => Boolean(window.fakeObserver)
    && getComputedStyle(document.querySelector('.feed-bar')).position === 'absolute');
  const divergentState = () => divergent.evaluate(() => {
    const form = window.fakeForm;
    const rect = form.getBoundingClientRect();
    const feed = document.querySelector('.feed').getBoundingClientRect();
    return {
      lift: form.style.getPropertyValue('--operator-form-lift'),
      maxHeight: form.style.getPropertyValue('--operator-form-max-height'),
      fieldMaxHeight: form.style.getPropertyValue('--operator-form-field-max-height'),
      formTop: Math.round(rect.top),
      formBottom: Math.round(rect.bottom),
      // The band the operator can actually see, per the injected source.
      bandTop: window.fakeViewport.offsetTop,
      bandBottom: window.fakeViewport.offsetTop + window.fakeViewport.height,
      clipTop: Math.round(feed.top),
      innerHeight: window.innerHeight,
    };
  });
  await divergent.evaluate(() => window.fakeObserver.reveal());
  let staged = await divergentState();
  // innerHeight 600, visible band 40..340: the popover is anchored 60px above a
  // bar that now sits behind the keyboard, so it must rise by the whole 260px
  // gap and fit between the feed's top clip (88) and its lifted bottom (272).
  assert.equal(staged.innerHeight, 600, 'the divergent fixture needs an exact 600px layout viewport');
  assert.deepEqual(
    { lift: staged.lift, maxHeight: staged.maxHeight, fieldMaxHeight: staged.fieldMaxHeight },
    { lift: '260px', maxHeight: '184px', fieldMaxHeight: '158px' },
    'the helper ignored a visual viewport that diverges from the layout viewport',
  );
  assert.deepEqual({ top: staged.formTop, bottom: staged.formBottom }, { top: 88, bottom: 272 },
    'the popover did not move into the visible band of a divergent viewport');
  assert.ok(staged.formBottom <= staged.bandBottom,
    `the popover stayed behind the keyboard (${staged.formBottom} > ${staged.bandBottom})`);
  assert.ok(staged.formTop >= staged.clipTop,
    `the popover stayed behind the feed clip (${staged.formTop} < ${staged.clipTop})`);

  // iOS pans the visual viewport under an open keyboard and reports it as
  // `scroll` with no `resize` at all.
  await divergent.evaluate(() => window.fakeViewport.move(240, 60, 'scroll'));
  staged = await divergentState();
  assert.deepEqual({ lift: staged.lift, maxHeight: staged.maxHeight, bottom: staged.formBottom },
    { lift: '300px', maxHeight: '144px', bottom: 232 },
    'a visual-viewport scroll without a resize left the popover behind the keyboard');

  // Keyboard dismissed: the band is the whole layout viewport again, so the
  // popover drops back to its designed anchor with no lift.
  await divergent.evaluate(() => window.fakeViewport.move(600, 0, 'resize'));
  staged = await divergentState();
  assert.deepEqual({ lift: staged.lift, maxHeight: staged.maxHeight, bottom: staged.formBottom },
    { lift: '0px', maxHeight: '444px', bottom: 532 },
    'the popover did not return to its anchor once the visual viewport was whole again',
  );

  await divergent.evaluate(() => window.fakeObserver.release());
  staged = await divergentState();
  assert.deepEqual(
    { lift: staged.lift, maxHeight: staged.maxHeight, fieldMaxHeight: staged.fieldMaxHeight },
    { lift: '', maxHeight: '', fieldMaxHeight: '' },
    'release left a measured bound behind on the divergent fixture',
  );
  await divergent.evaluate(() => window.fakeViewport.move(200, 100, 'resize'));
  assert.equal((await divergentState()).maxHeight, '',
    'a released observer still listened to its injected viewport source');
  await divergent.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('operator playable rework browser: screenshot + always-open queue capture + keyboard viewport PASS');
