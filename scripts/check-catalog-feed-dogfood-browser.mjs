import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CATALOG_DOGFOOD_LEVEL_COUNT: '1',
    CATALOG_DOGFOOD_TIMEOUT_MS: '15000',
    VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS: '500',
  },
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(
    () => reject(new Error(`catalog dogfood browser harness startup timed out\n${stderr}`)),
    120_000,
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl && parsed.transientResultUrl
          && parsed.timeoutResultUrl && parsed.stateUrl) {
          clearTimeout(timeout);
          resolve(parsed);
          return;
        }
      } catch { /* npm/build output is not the endpoint JSON */ }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    reject(new Error(
      `catalog dogfood browser harness exited before startup (${String(code)})\n${stderr}\n${stdout}`,
    ));
  });
});

const exactSpecHash = '1'.repeat(64);
const browser = await chromium.launch();

const runScenario = async (url, { firstFailure }) => {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const state = window.__catalogFeedDogfoodHarness;
      return state?.status === 'pass' || state?.status === 'fail';
    }, null, { timeout: 30_000 });
    const state = await page.evaluate(() => window.__catalogFeedDogfoodHarness);
    const diagnostic = JSON.stringify({
      status: state?.status,
      message: state?.message,
      results: state?.results,
      resultAttempts: state?.resultAttempts,
      checkpoints: state?.checkpoints,
      client: state?.client,
      runtimeEvents: state?.runtimeEvents,
      diagnostics: state?.diagnostics,
      browserErrors,
    }, null, 2);

    assert.equal(state.status, 'pass', diagnostic);
    assert.equal(state.client.catalogSeen, true, diagnostic);
    assert.equal(state.client.builtinSeen, true, diagnostic);
    assert.equal(state.client.generatedBadgeVisible, true, diagnostic);
    assert.equal(state.client.chestSeen, true, diagnostic);
    assert.equal(state.client.rewardSeen, true, diagnostic);
    assert.equal(state.diagnostics.length, 0, diagnostic);
    assert.deepEqual(browserErrors, [], diagnostic);
    assert.equal(
      state.runtimeEvents.some((item) => item.stage === 'completed_sent'),
      true,
      diagnostic,
    );

    const levelResults = state.results.filter((item) => item.kind === 'level');
    const chestResults = state.results.filter((item) => item.kind === 'chest');
    assert.equal(levelResults.length, 1, diagnostic);
    assert.equal(levelResults[0].outcome, 'confirmed', diagnostic);
    assert.equal(levelResults[0].body.ordinal, 1, diagnostic);
    assert.equal(levelResults[0].body.series_level, 1, diagnostic);
    assert.equal(levelResults[0].body.applied_spec_hash, exactSpecHash, diagnostic);
    assert.equal(chestResults.length, 1, diagnostic);
    assert.equal(chestResults[0].outcome, 'confirmed', diagnostic);
    assert.equal(chestResults[0].body.metric_key, 'series', diagnostic);
    assert.equal(chestResults[0].body.metric_value, 1, diagnostic);
    assert.equal(state.checkpoints.chestAfterExactReceipts?.pass, true, diagnostic);
    assert.equal(state.checkpoints.rewardAfterChestReceipt?.pass, true, diagnostic);

    const levelAttempts = state.resultAttempts.filter((item) => item.kind === 'level');
    const chestAttempts = state.resultAttempts.filter((item) => item.kind === 'chest');
    assert.deepEqual(
      levelAttempts.map((item) => [item.outcome, item.status]),
      firstFailure === 'transient'
        ? [['transient', 503], ['confirmed', 200]]
        : firstFailure === 'timeout'
          ? [['hung', 0], ['confirmed', 200]]
          : [['confirmed', 200]],
      diagnostic,
    );
    if (firstFailure) {
      assert.deepEqual(levelAttempts[0].body, levelAttempts[1].body, diagnostic);
    }
    assert.deepEqual(
      chestAttempts.map((item) => [item.outcome, item.status]),
      [['confirmed', 200]],
      diagnostic,
    );
  } finally {
    await page.close();
  }
};

try {
  await runScenario(endpoints.successUrl, { firstFailure: null });
  await runScenario(endpoints.transientResultUrl, { firstFailure: 'transient' });
  await runScenario(endpoints.timeoutResultUrl, { firstFailure: 'timeout' });
  console.log(
    'catalog feed dogfood browser: one-level happy path, transient recovery, and hung-request recovery verified',
  );
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
