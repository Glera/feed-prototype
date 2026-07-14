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
  return match[1];
};

const initDataFor = (instanceToken, scenario) => new URLSearchParams({
  query_id: 'dogfood',
  harness_instance: instanceToken,
  harness_scenario: scenario,
  user: JSON.stringify({ id: 42 }),
  hash: 'dogfood',
}).toString();

try {
  const staleInstance = await controllerInstance(endpoints.successUrl);
  const activeInstance = await controllerInstance(endpoints.recallUrl);
  assert.notEqual(activeInstance, staleInstance, 'each harness navigation needs a fresh instance');

  const staleSnapshot = {
    harnessInstance: staleInstance,
    harnessScenario: 'success',
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
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${staleInstance}&scenario=success`,
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
      authorization: `tma ${initDataFor(staleInstance, 'success')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [{ event_id: 'stale-event' }] }),
  });
  assert.equal(staleControlPlane.status, 202);
  assert.equal((await staleControlPlane.json()).ignored, 'stale_harness_instance');

  let activeState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(activeState.instanceToken, activeInstance);
  assert.equal(activeState.scenario, 'recall');
  assert.equal(activeState.status, 'running');
  assert.equal(activeState.client.chestSeen, false);
  assert.equal(activeState.client.rewardSeen, false);
  assert.equal(activeState.cpEvents.length, 0);
  assert.equal(activeState.trace.some((item) => item.type === 'client_surface'), false);

  const activeSnapshot = {
    harnessInstance: activeInstance,
    harnessScenario: 'recall',
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
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${activeInstance}&scenario=recall`,
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
  console.log('catalog feed dogfood harness: stale instance reports are isolated');
} finally {
  child.kill('SIGTERM');
}
