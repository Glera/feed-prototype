import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
let attempts = 0;
let origin = '';
const occurrence = {
  flagSurface: 'preview',
  decisionId: '10000000-0000-4000-8000-000000000001',
  contentImpressionId: '10000000-0000-4000-8000-000000000002',
  catalogEntryId: '10000000-0000-4000-8000-000000000003',
  seriesId: '10000000-0000-4000-8000-000000000004',
  ordinal: 1,
  levelSpecHash: 'a'.repeat(64),
  skinHash: null,
  levelEventId: '10000000-0000-4000-8000-000000000010',
  levelImpressionId: null,
  runId: null,
  attemptEventId: null,
};

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};
const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const pageHtml = `<!doctype html><html><body><main id="host"></main><script type="module">
import {
  mountOperatorLevelFlagControl,
  operatorLevelFlaggingAvailable,
  validateOperatorLevelFlagResponse,
} from '/src/operator-level-flags.mjs';
const params = new URLSearchParams(location.search);
const enabled = operatorLevelFlaggingAvailable(params.get('enabled') === '1' ? true : false);
const occurrence = ${JSON.stringify(occurrence)};
let seq = 6;
if (enabled) window.control = mountOperatorLevelFlagControl(document.querySelector('#host'), {
  occurrence,
  createMutationId: () => '10000000-0000-4000-8000-' + String(++seq).padStart(12, '0'),
  submit: async (request) => {
    const response = await fetch('/api/operator-level-flags', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.code), { status: response.status, code: body.code });
    validateOperatorLevelFlagResponse(body, request);
  },
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/api/operator-level-flags') {
    const body = await bodyOf(request);
    requests.push(body);
    attempts += 1;
    if (attempts === 1) return json(response, { code: 'operator_level_flag_integrity' }, 503);
    return json(response, {
      schema: 'catalog.operator-flag.v1',
      flagId: '10000000-0000-4000-8000-000000000099',
      mutationId: body.mutationId,
      requestHash: 'c'.repeat(64),
      actorUserId: 42,
      intent: body.intent,
      comment: body.comment,
      flagSurface: body.flagSurface,
      subject: body.subject,
      causal: body.causal,
      createdAt: '2026-07-16T12:00:00.000Z',
      replayed: true,
    });
  }
  if (url.pathname === '/src/operator-level-flags.mjs') {
    response.setHeader('content-type', 'text/javascript');
    return response.end(readFileSync(path.join(root, 'src/operator-level-flags.mjs')));
  }
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html');
    return response.end(pageHtml);
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
  const disabled = await browser.newPage();
  await disabled.goto(`${origin}/?enabled=0`);
  assert.equal(await disabled.locator('.game__operator-flag').count(), 0,
    'capability=false rendered an operator surface');
  await disabled.close();

  const enabled = await browser.newPage();
  await enabled.goto(`${origin}/?enabled=1`);
  await enabled.locator('.game__operator-flag-open').click();
  await enabled.locator('select[name="intent"]').selectOption('delete_candidate');
  await enabled.locator('textarea[name="comment"]').fill('Слишком похож на прошлый уровень');
  await enabled.locator('button[type="submit"]').click();
  await enabled.locator('.game__operator-flag-status').filter({ hasText: 'временно недоступен' }).waitFor();
  await enabled.locator('button[type="submit"]').click();
  await enabled.locator('.game__operator-flag-status').filter({ hasText: 'Пометка сохранена' }).waitFor();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1], 'retry changed the immutable mutation request');
  assert.equal(requests[0].schema, 'catalog.operator-flag.request.v1');
  assert.equal(requests[0].flagSurface, 'preview');
  assert.deepEqual(requests[0].subject, {
    catalogEntryId: occurrence.catalogEntryId,
    seriesId: occurrence.seriesId,
    ordinal: occurrence.ordinal,
    levelSpecHash: occurrence.levelSpecHash,
    skinHash: null,
  });
  assert.deepEqual(requests[0].causal, {
    decisionId: occurrence.decisionId,
    contentImpressionId: occurrence.contentImpressionId,
    levelImpressionId: occurrence.levelImpressionId,
    runId: null,
  });
  await enabled.evaluate(() => window.control.destroy());
  assert.equal(await enabled.locator('.game__operator-flag').count(), 0);
  await enabled.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log('operator level flags browser: capability absence, exact POST and mutation replay verified');
