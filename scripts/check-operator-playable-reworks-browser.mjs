import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleSource = readFileSync(path.join(root, 'src/operator-playable-reworks.mjs'));
let origin = '';

const fixture = `<!doctype html>
<html><body><div id="host"></div><script type="module">
import { mountOperatorPlayableReworkControl, screenshotFromFile } from '/operator-playable-reworks.mjs';
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
window.lastRequest = null;
window.submitGate = Promise.resolve();
window.submitError = false;
window.normalizeScreenshot = screenshotFromFile;
window.control = mountOperatorPlayableReworkControl(document.querySelector('#host'), {
  occurrence,
  createMutationId: () => '55555555-5555-5555-8555-555555555555',
  submit: async (request) => {
    window.lastRequest = request;
    await window.submitGate;
    if (window.submitError) throw Object.assign(new Error('offline'), { status: 0 });
  },
});
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (url.pathname === '/operator-playable-reworks.mjs') {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end(moduleSource);
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
  assert.equal(await page.locator('.game__operator-flag-status').innerText(), 'Задача сохранена ✓ · ждёт подключения Labs');
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('operator playable rework browser: large phone screenshot + remove + submit PASS');
