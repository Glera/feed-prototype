/** Throwaway: screenshot the chest ceremony with the collections button as the
 *  card-drop target — "before" (bar back inside .feed, the old broken layer) and
 *  "after" (bar in the scrim's layer), plus a card in flight.
 *  OUT_DIR=<dir> node this.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const outDir = process.env.OUT_DIR;
const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CATALOG_DOGFOOD_LEVEL_COUNT: '3', CATALOG_DOGFOOD_TIMEOUT_MS: '15000' },
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { stderr += c; });
const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(() => reject(new Error(`startup timeout\n${stderr}`)), 180_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl) { clearTimeout(timeout); resolve(parsed); return; }
      } catch { /* build output */ }
    }
  });
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(endpoints.successUrl, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.panel{display:none!important}' });
  const feedFrame = async () => page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/feed'));

  // 1) the instant the chest scrim is up and the bar has been lifted for cards
  const deadline = Date.now() + 90_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    const frame = await feedFrame();
    if (frame) {
      const state = await frame.evaluate(() => {
        const scrim = document.querySelector('.chest-ov');
        const bar = document.querySelector('.feed-bar');
        return {
          lifted: Boolean(scrim && bar && bar.classList.contains('feed-bar--chest-portal')),
          opaque: Boolean(scrim && scrim.classList.contains('chest-ov--in')),
        };
      }).catch(() => ({ lifted: false, opaque: false }));
      if (state.lifted && state.opaque) {
        await page.screenshot({ path: path.join(outDir, 'chest-bar-after.png') });
        // Same frame, old layer: put the bar back into .feed (what the operator saw).
        await frame.evaluate(() => {
          const bar = document.querySelector('.feed-bar');
          document.querySelector('.feed')?.appendChild(bar);
        });
        await page.waitForTimeout(60);
        await page.screenshot({ path: path.join(outDir, 'chest-bar-before.png') });
        await frame.evaluate(() => {
          const bar = document.querySelector('.feed-bar');
          document.querySelector('.viewport')?.appendChild(bar);
        });
        done = true;
        break;
      }
    }
    await page.waitForTimeout(30);
  }
  console.log(done ? 'chest bar shots written' : 'chest scrim never observed');

  // 2) a card in flight (size check)
  const cardDeadline = Date.now() + 30_000;
  while (Date.now() < cardDeadline) {
    const frame = await feedFrame();
    if (frame) {
      const live = await frame.evaluate(() => Boolean(document.querySelector('.coll-card'))).catch(() => false);
      if (live) {
        await page.screenshot({ path: path.join(outDir, 'chest-card-in-flight.png') });
        console.log('card shot written');
        break;
      }
    }
    await page.waitForTimeout(30);
  }
} finally {
  await browser.close();
  child.kill();
}
