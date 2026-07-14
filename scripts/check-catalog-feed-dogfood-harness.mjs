import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(() => reject(new Error(`harness startup timed out\n${stderr}`)), 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl && parsed.recallUrl && parsed.stateUrl) {
          clearTimeout(timeout);
          resolve(parsed);
          return;
        }
      } catch { /* npm/build output is not the endpoint JSON */ }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    reject(new Error(`harness exited before startup (${String(code)})\n${stderr}\n${stdout}`));
  });
});

const controllerInstance = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/data-harness-instance="([0-9a-f-]+)"/);
  assert.ok(match, 'controller must embed its harness instance token');
  const feedMatch = html.match(/data-testid="feed"[^>]+src="([^"]+)"/);
  assert.ok(feedMatch, 'controller must embed the instance-bound Feed URL');
  return { instanceToken: match[1], feedUrl: new URL(feedMatch[1], url).href };
};

const userIdFor = (instanceToken) => Number.parseInt(instanceToken.replaceAll('-', '').slice(0, 12), 16) + 1;
const initDataFor = (instanceToken, scenario) => new URLSearchParams({
  query_id: 'dogfood',
  harness_instance: instanceToken,
  harness_scenario: scenario,
  user: JSON.stringify({ id: userIdFor(instanceToken) }),
  hash: 'dogfood',
}).toString();

try {
  const recall = await controllerInstance(endpoints.recallUrl);
  const staleInstance = recall.instanceToken;
  const recallFeed = await fetch(recall.feedUrl).then((response) => response.text());
  const telegramSdkAt = recallFeed.indexOf('https://telegram.org/js/telegram-web-app.js');
  const harnessIdentityAt = recallFeed.indexOf(`const harnessInstance=${JSON.stringify(staleInstance)}`);
  assert.ok(telegramSdkAt >= 0 && harnessIdentityAt > telegramSdkAt,
    'harness identity must be installed after the Telegram SDK replaces window.Telegram');

  const legacyStart = await fetch(`${new URL(endpoints.stateUrl).origin}/api/runs/start`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(staleInstance, 'recall')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ticket_id: '20000000-0000-4000-8000-000000000001',
      run_id: 'legacy-recall-fallback',
      mechanic_id: 'merge-locked-v1-swipe',
      variant_id: '10000000-0000-4000-8000-000000000002',
      kind: 'single',
    }),
  });
  assert.equal(legacyStart.status, 200);
  const legacyTicket = await legacyStart.json();
  assert.equal(legacyTicket.schema, undefined, 'legacy fallback must not receive a v2 ticket view');
  assert.equal(legacyTicket.ticket_id, '20000000-0000-4000-8000-000000000001');
  assert.equal(legacyTicket.run_id, 'legacy-recall-fallback');
  assert.equal(legacyTicket.kind, 'single');
  assert.equal(legacyTicket.state, 'active');

  const success = await controllerInstance(endpoints.successUrl);
  const activeInstance = success.instanceToken;
  assert.notEqual(activeInstance, staleInstance, 'each harness navigation needs a fresh instance');

  const staleSnapshot = {
    harnessInstance: staleInstance,
    harnessScenario: 'recall',
    currentFrame: 'catalog',
    currentIframeCount: 1,
    catalogSeen: true,
    builtinSeen: false,
    chestSeen: true,
    rewardSeen: true,
    recoverySeen: false,
    preloaderVisible: false,
  };
  const staleClient = await fetch(
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${staleInstance}&scenario=recall`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(staleSnapshot),
    },
  );
  assert.equal(staleClient.status, 202);
  assert.equal((await staleClient.json()).ignored, 'stale_harness_instance');

  const staleControlPlane = await fetch(`${new URL(endpoints.stateUrl).origin}/api/cp/events`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(staleInstance, 'recall')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [{ event_id: 'stale-event' }] }),
  });
  assert.equal(staleControlPlane.status, 202);
  assert.equal((await staleControlPlane.json()).ignored, 'stale_harness_instance');

  const catalogStart = await fetch(`${new URL(endpoints.stateUrl).origin}/api/runs/start`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(activeInstance, 'success')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'run.start.v2',
      ticket_id: '20000000-0000-4000-8000-000000000002',
      run_id: 'series-success-after-recall',
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      kind: 'series',
      decision_id: '10000000-0000-4000-8000-000000000005',
    }),
  });
  assert.equal(catalogStart.status, 200);
  const catalogTicket = await catalogStart.json();
  assert.equal(catalogTicket.schema, 'run.ticket.v2');
  assert.equal(catalogTicket.ticket_id, '20000000-0000-4000-8000-000000000002');
  assert.equal(catalogTicket.run_id, 'series-success-after-recall');
  assert.equal(catalogTicket.decision_id, '10000000-0000-4000-8000-000000000005');

  let activeState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(activeState.instanceToken, activeInstance);
  assert.equal(activeState.scenario, 'success');
  assert.equal(activeState.status, 'running');
  assert.equal(activeState.client.chestSeen, false);
  assert.equal(activeState.client.rewardSeen, false);
  assert.equal(activeState.cpEvents.length, 0);
  assert.equal(activeState.ticketRequests.length, 1);
  assert.equal(activeState.ticketRequests[0].schema, 'run.start.v2');
  assert.equal(activeState.trace.some((item) => item.type === 'client_surface'), false);

  const activeSnapshot = {
    harnessInstance: activeInstance,
    harnessScenario: 'success',
    currentFrame: 'none',
    currentIframeCount: 0,
    catalogSeen: false,
    builtinSeen: false,
    chestSeen: false,
    rewardSeen: false,
    recoverySeen: false,
    preloaderVisible: true,
  };
  const activeClient = await fetch(
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${activeInstance}&scenario=success`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activeSnapshot),
    },
  );
  assert.equal(activeClient.status, 200);

  activeState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(activeState.instanceToken, activeInstance);
  assert.equal(activeState.client.currentFrame, 'none');
  assert.equal(activeState.trace.filter((item) => item.type === 'client_surface').length, 1);
  console.log('catalog feed dogfood harness: recall→success queues and stale instances are isolated');
} finally {
  child.kill('SIGTERM');
}
