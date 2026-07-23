/**
 * Same-origin serve harness for the *published-path* real-backend feed E2E.
 *
 * Unlike scripts/serve-catalog-feed-real-e2e.mjs (which targets the canary
 * dogfood path and, by design, refuses to serve runtime-releases so production
 * must supply an absolute HTTPS locator), this harness is for a fully-local
 * published-series run:
 *
 *   - it serves the prebuilt Feed (dist/index.html) at `/` and `/feed`,
 *     injecting a Telegram.WebApp bootstrap for the seeded dogfood user;
 *   - it serves the exact content-addressed `/runtime-releases/...` executable
 *     set from the real deploy checkout (../swipe-platform), because the Feed
 *     resolves the server-selected content-addressed locator against
 *     `location.href` (feed.ts: baseUrl: location.href);
 *   - all `/api/*` traffic goes cross-origin to the real uvicorn at
 *     VITE_API_BASE (CORS is enabled on the E2E full app).
 *
 * The Feed dist must have been built with the three gates on and
 * VITE_API_BASE pointing at the running uvicorn:
 *
 *   VITE_API_BASE=http://127.0.0.1:8099 VITE_CONTROL_PLANE_ENABLED=true \
 *   VITE_CATALOG_PLAYER_V2_ENABLED=true VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED=true \
 *   VITE_CATALOG_DOGFOOD_USER_ID=<id> npm run build
 *
 * Env:
 *   SERVE_PORT                 (default 0 = ephemeral)
 *   E2E_DOGFOOD_USER_ID        (required; seeded dogfood user id)
 *   E2E_PLATFORM_ROOT          (default ../swipe-platform)
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformRoot = path.resolve(root, process.env.E2E_PLATFORM_ROOT ?? '../swipe-platform');
const dogfoodUserId = (process.env.E2E_DOGFOOD_USER_ID ?? '').trim();
const port = Number(process.env.SERVE_PORT ?? 0);
// The seeded runtime artifact digest — every real catalog preview manifest on
// disk carries this same runtime, so the synthesized manifest must too.
const runtimeArtifactDigest = process.env.E2E_RUNTIME_ARTIFACT_DIGEST
  ?? 'sha256:d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293';

const fail = (message) => { process.stderr.write(`serve published E2E: ${message}\n`); process.exit(1); };
if (!/^[0-9]+$/.test(dogfoodUserId)) fail('E2E_DOGFOOD_USER_ID must be the seeded numeric dogfood user id');
const distIndex = path.join(root, 'dist/index.html');
if (!existsSync(distIndex)) fail('dist/index.html is missing — build the Feed with the three gates first');

// ---- E2E generated-preview synthesis (cosmetic; default-on for this harness).
// The backend fixtures seed a real, playable sort LevelSpec but no catalog-
// preview cover for its content hash, so the Feed's loadGeneratedPreview() would
// 404 and the generated offer would never become 'ready'. The preview is only
// the feed card thumbnail — it is NOT part of the spec/runtime gameplay closure
// (that comes from the ticket spec bundle). We therefore serve a self-consistent
// preview: a real on-disk cover's JPEG bytes, wrapped in a manifest keyed to the
// requested content hash and the seeded runtime digest. Set E2E_SYNTH_PREVIEW=0
// to disable and require a real on-disk preview instead.
const synthPreviewEnabled = process.env.E2E_SYNTH_PREVIEW !== '0';
const previewsDir = path.join(platformRoot, 'catalog-previews');
const pickSourceCover = (compact) => {
  // Deterministically borrow the bytes of the first real cover of this bucket.
  const suffix = compact ? '.cover.c.jpg' : '.cover.jpg';
  const names = existsSync(previewsDir)
    ? readdirSync(previewsDir).filter((n) => n.endsWith(suffix)).sort()
    : [];
  if (!names.length) return null;
  return readFileSync(path.join(previewsDir, names[0]));
};
const sourceMobile = synthPreviewEnabled ? pickSourceCover(false) : null;
const sourceCompact = synthPreviewEnabled ? pickSourceCover(true) : null;
const sha256Hex = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
const HASH64 = /^[0-9a-f]{64}$/;
const synthesizedManifest = (contentHash) => JSON.stringify({
  schema: 'catalog.generated-preview.v1',
  captureContract: 'sort.generated-preview.v1',
  contentHash,
  runtimeArtifactDigest,
  covers: {
    mobile: { file: `${contentHash}.cover.jpg`, sha256: sha256Hex(sourceMobile), width: 390, height: 600 },
    compact: { file: `${contentHash}.cover.c.jpg`, sha256: sha256Hex(sourceCompact), width: 390, height: 488 },
  },
});

const scriptJson = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll(String.fromCharCode(0x2028), '\\u2028')
  .replaceAll(String.fromCharCode(0x2029), '\\u2029');

// A local run has no Telegram signing oracle. The E2E full app overrides
// require_tma_user to the fixed dogfood user, so any non-empty initData is
// accepted; we still hand the Feed a well-formed unsafe user + a placeholder
// initData string so its own boot guards pass.
const initUser = { id: Number(dogfoodUserId), first_name: 'Effectful catalog E2E player', language_code: 'en' };
const initData = `user=${encodeURIComponent(JSON.stringify(initUser))}&auth_date=0&hash=e2e`;

const telegramBootstrap = () => `<script>
window.Telegram={WebApp:{
  initData:${scriptJson(initData)},
  initDataUnsafe:{user:${scriptJson(initUser)},start_param:null},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},
  setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}
}};
</script>`;

const contentType = (file) => ({
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css; charset=utf-8',
}[path.extname(file).toLowerCase()] ?? 'application/octet-stream');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'GET') { response.statusCode = 405; response.end('method not allowed'); return; }

  if (url.pathname === '/' || url.pathname === '/feed') {
    // The app loads telegram.org/js/telegram-web-app.js, which reassigns
    // window.Telegram.WebApp with an empty initData (platform "unknown") in a
    // plain browser — clobbering our injected bootstrap before the Feed class
    // constructs. getInitData()'s sanctioned `?initData=` dev fallback is read
    // from location.search and is therefore both clobber-proof and available at
    // construction time, so controlPlaneEnabled()/catalogDogfoodEnabled latch
    // true. Redirect the bare Feed URL to carry it.
    if (!url.searchParams.get('initData')) {
      const target = `${url.pathname}?initData=${encodeURIComponent(initData)}`;
      response.statusCode = 302;
      response.setHeader('location', target);
      response.end();
      return;
    }
    const source = readFileSync(distIndex, 'utf8');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(source.replace('<head>', `<head>${telegramBootstrap()}`));
    return;
  }

  // Real content-addressed runtime + any built-in asset comes from the deploy
  // checkout. Guard against path traversal; allow nested runtime-release paths.
  let relative;
  try { relative = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { relative = ''; }
  if (!relative || relative.includes('..')) { response.statusCode = 404; response.end('not found'); return; }
  const onDisk = path.join(platformRoot, relative);
  const realFile = onDisk.startsWith(`${platformRoot}${path.sep}`)
    && existsSync(onDisk) && statSync(onDisk).isFile();

  // Synthesize the generated preview for the seeded content when no real cover
  // exists on disk (see the E2E generated-preview synthesis note above).
  if (!realFile && synthPreviewEnabled && sourceMobile && sourceCompact) {
    const manifestMatch = relative.match(/^catalog-previews\/([0-9a-f]{64})\.preview\.json$/);
    if (manifestMatch) {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(synthesizedManifest(manifestMatch[1]));
      return;
    }
    const coverMatch = relative.match(/^catalog-previews\/([0-9a-f]{64})\.cover(\.c)?\.jpg$/);
    if (coverMatch && HASH64.test(coverMatch[1])) {
      response.setHeader('content-type', 'image/jpeg');
      response.end(coverMatch[2] ? sourceCompact : sourceMobile);
      return;
    }
  }

  if (!realFile) { response.statusCode = 404; response.end('not found'); return; }
  response.setHeader('content-type', contentType(onDisk));
  response.end(readFileSync(onDisk));
});

server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address();
  const origin = `http://127.0.0.1:${bound}`;
  console.log(JSON.stringify({
    schema: 'feed.real-published-e2e-serve.v1',
    feedUrl: `${origin}/feed`,
    origin,
    apiBase: process.env.VITE_API_BASE ?? '(baked into dist)',
    dogfoodUserId,
    platformRoot,
    runtimePolicy: 'same-origin content-addressed runtime-releases from swipe-platform',
  }));
});

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
