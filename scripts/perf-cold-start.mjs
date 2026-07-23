// Cold-start p95 harness for the swipe feed (perf-cold-start baseline).
//
// WHAT IT MEASURES, per cold run (fresh browser context ⇒ empty HTTP cache):
//   A) time to the first painted feed screen   — browser First Contentful Paint
//      (cross-checked against the passive mark `perf:feed-first-render`)
//   B) time to the first card with working autoplay — the passive mark
//      `perf:first-card-autoplay`, emitted by feed.ts the instant the first
//      CURRENT card is revealed and its autoplay has been kicked off.
// Both are relative to navigation start (performance.timeOrigin of the fresh doc).
//
// HOW IT SERVES A FAITHFUL PROD LAYOUT:
//   The prod deploy (../swipe-platform) is the feed's single-file index.html
//   sitting next to every mechanic `<id>-swipe.html` + payload + versions.json.
//   The dev-only Vite `configureServer` plugin that serves mechanics does NOT
//   run under `vite preview`, so we reproduce the deploy by copying the mechanic
//   siblings into the freshly-built dist/ and letting `vite preview` serve them
//   as static siblings — exactly like the deployed static site.
//
// METHOD CAVEATS (see PERF-BASELINE.md): desktop headless Chromium over
// localhost is NOT a phone inside Telegram — no cellular RTT, no device CPU
// throttle, no Telegram WebView. External origins (telegram.org SDK, any
// backend) are blocked so the number reflects our own asset cold-start, not
// third-party CDN latency. This is a repeatable baseline METHOD, not the final
// gate figure.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = path.resolve(root, '../swipe-platform');
const distDir = path.resolve(root, 'dist');

const RUNS = Number(process.env.PERF_RUNS || 20);
const PORT = Number(process.env.PERF_PORT || 4319);
const PER_RUN_TIMEOUT_MS = Number(process.env.PERF_RUN_TIMEOUT_MS || 30000);
const DO_BUILD = process.env.PERF_NO_BUILD !== '1';
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Device-representative throttling, applied per cold run via a CDP session
// BEFORE navigation (so it covers the whole cold load).
//   PERF_CPU_THROTTLE — CDP Emulation.setCPUThrottlingRate rate (e.g. 4, 6);
//                       ≤1 or unset ⇒ no CPU throttle.
//   PERF_NET_PROFILE  — 'fast4g' ⇒ CDP Network.emulateNetworkConditions
//                       (latency 60ms, ↓9Mbps, ↑1.5Mbps); 'none'/unset ⇒ off.
const CPU_THROTTLE = Math.max(0, Number(process.env.PERF_CPU_THROTTLE || 0));
const NET_PROFILES = {
  fast4g: {
    label: 'Fast 4G',
    latency: 60,                                 // ms RTT
    downloadThroughput: Math.round((9 * 1000 * 1000) / 8),   // 9 Mbps → B/s
    uploadThroughput: Math.round((1.5 * 1000 * 1000) / 8),   // 1.5 Mbps → B/s
  },
};
const NET_KEY = (process.env.PERF_NET_PROFILE || 'none').toLowerCase();
const NET = NET_PROFILES[NET_KEY] || null;
// Human/file label for this profile.
const PROFILE_LABEL = process.env.PERF_LABEL
  || (CPU_THROTTLE > 1 || NET
    ? [CPU_THROTTLE > 1 ? `cpu${CPU_THROTTLE}x` : null, NET ? NET_KEY : null].filter(Boolean).join('-')
    : 'baseline');

const log = (...args) => console.log('[perf]', ...args);

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status ?? res.signal}`);
  }
}

// 1) Fresh production build of the feed.
if (DO_BUILD) {
  log('building feed (tsc && vite build) …');
  run('npm', ['run', 'build']);
} else {
  log('PERF_NO_BUILD=1 — reusing existing dist/');
}

// 2) Assemble the prod deploy layout: fresh feed index.html + mechanic siblings.
if (!existsSync(path.join(distDir, 'index.html'))) {
  throw new Error(`no dist/index.html — build first (found: ${existsSync(distDir) ? readdirSync(distDir).join(',') : 'no dist/'})`);
}
if (!existsSync(deployDir)) {
  throw new Error(`prod deploy dir not found: ${deployDir}`);
}
log('assembling prod layout into dist/ (mechanic siblings from swipe-platform) …');
for (const name of readdirSync(deployDir)) {
  if (name === 'index.html') continue;          // keep the freshly-built feed
  if (name.startsWith('.git')) continue;
  if (name === '.DS_Store' || name === 'README.md') continue;
  cpSync(path.join(deployDir, name), path.join(distDir, name), { recursive: true });
}

// 3) Start `vite preview` on a fixed port, serving the assembled dist/.
log(`starting vite preview on ${ORIGIN} …`);
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SWIPE_GENERATOR_AUTOSTART: '0' },
});
preview.stdout.on('data', (b) => process.stdout.write(`[preview] ${b}`));
preview.stderr.on('data', (b) => process.stderr.write(`[preview] ${b}`));

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ORIGIN}/index.html`, { cache: 'no-store' });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('vite preview did not become reachable');
}

const pct = (sorted, q) => {
  // Nearest-rank on ascending-sorted values (see PERF-BASELINE.md).
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[idx];
};
const summarize = (values) => {
  const ok = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (ok.length === 0) return { n: 0 };
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  return {
    n: ok.length,
    min: Math.round(ok[0]),
    p50: Math.round(pct(ok, 50)),
    p95: Math.round(pct(ok, 95)),
    max: Math.round(ok[ok.length - 1]),
    mean: Math.round(mean),
  };
};

let browser;
let exitCode = 0;
try {
  await waitForServer();
  log(`profile: ${PROFILE_LABEL}  (CPU ${CPU_THROTTLE > 1 ? `${CPU_THROTTLE}×` : 'off'}, net ${NET ? NET.label : 'unthrottled'})`);
  browser = await chromium.launch();          // headless desktop Chromium
  const rows = [];
  for (let i = 1; i <= RUNS; i += 1) {
    // Fresh context ⇒ isolated, empty HTTP cache ⇒ genuine cold start.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // Keep the number about OUR assets: block every non-localhost origin
    // (telegram.org SDK, fonts, any backend). Documented as a method caveat.
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === '127.0.0.1' || host === 'localhost') return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    // Apply CPU/network throttling BEFORE navigation so it covers the whole
    // cold load (incl. loopback transfer of our own mechanic payloads).
    if (CPU_THROTTLE > 1 || NET) {
      const cdp = await context.newCDPSession(page);
      if (NET) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: NET.latency,
          downloadThroughput: NET.downloadThroughput,
          uploadThroughput: NET.uploadThroughput,
        });
      }
      if (CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    }
    let measured = null;
    try {
      await page.goto(`${ORIGIN}/?perf=1`, { waitUntil: 'commit', timeout: PER_RUN_TIMEOUT_MS });
      await page.waitForFunction(
        () => performance.getEntriesByName('perf:first-card-autoplay').length > 0,
        null,
        { timeout: PER_RUN_TIMEOUT_MS, polling: 50 },
      );
      measured = await page.evaluate(() => {
        const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
        const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
        const nav = performance.getEntriesByType('navigation')[0];
        return {
          fcp: paint ? paint.startTime : null,
          firstRenderMark: mark('perf:feed-first-render'),
          firstCardAutoplay: mark('perf:first-card-autoplay'),
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
          load: nav ? nav.loadEventEnd : null,
        };
      });
    } catch (err) {
      log(`run ${i}: FAILED — ${err.message.split('\n')[0]}`);
    } finally {
      await context.close();
    }
    if (measured) {
      rows.push(measured);
      log(
        `run ${String(i).padStart(2)}/${RUNS}  fcp=${measured.fcp?.toFixed(0)}ms  `
        + `firstRender=${measured.firstRenderMark?.toFixed(0)}ms  autoplay=${measured.firstCardAutoplay?.toFixed(0)}ms`,
      );
    } else {
      rows.push({ fcp: null, firstRenderMark: null, firstCardAutoplay: null, domContentLoaded: null, load: null, failed: true });
    }
  }

  const metrics = {
    fcp: summarize(rows.map((r) => r.fcp)),
    firstRenderMark: summarize(rows.map((r) => r.firstRenderMark)),
    firstCardAutoplay: summarize(rows.map((r) => r.firstCardAutoplay)),
  };
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout?.toString().trim();
  const report = {
    generatedAt: new Date().toISOString(),
    commit,
    runs: RUNS,
    okRuns: rows.filter((r) => !r.failed).length,
    environment: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      node: process.version,
      chromium: chromium.name?.() ?? undefined,
    },
    profile: {
      label: PROFILE_LABEL,
      cpuThrottleRate: CPU_THROTTLE > 1 ? CPU_THROTTLE : 1,
      netProfile: NET ? { key: NET_KEY, ...NET } : null,
    },
    method: {
      server: 'vite preview (prod dist + mechanic siblings from swipe-platform)',
      browser: 'headless desktop Chromium via Playwright',
      viewport: '390x844',
      coldCache: 'fresh browser context per run',
      externalOriginsBlocked: true,
      percentile: 'nearest-rank on ascending values',
    },
    metrics,
    rows,
  };
  const outPath = path.join(
    root,
    PROFILE_LABEL === 'baseline' ? 'perf-cold-start-results.json' : `perf-cold-start-results.${PROFILE_LABEL}.json`,
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `\n=== COLD-START [${PROFILE_LABEL}] (N=${RUNS}, ${report.okRuns} ok`
    + `${CPU_THROTTLE > 1 ? `, CPU ${CPU_THROTTLE}×` : ''}${NET ? `, ${NET.label}` : ''}) ===`,
  );
  const fmt = (m) => `p50=${m.p50}ms  p95=${m.p95}ms  (min ${m.min} / max ${m.max} / mean ${m.mean}, n=${m.n})`;
  console.log('A) first painted feed screen (FCP)       :', fmt(metrics.fcp));
  console.log('   (cross-check mark perf:feed-first-render):', fmt(metrics.firstRenderMark));
  console.log('B) first card w/ autoplay (mark)         :', fmt(metrics.firstCardAutoplay));
  console.log('\nresults →', outPath);
} catch (err) {
  console.error('[perf] FATAL:', err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
}
process.exit(exitCode);
