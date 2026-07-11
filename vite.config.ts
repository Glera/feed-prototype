import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { execFile, spawn } from 'child_process';
import { finalizePack, recipe as sortRecipe, renderThemePrompt, resolvePreferences, validatePack, validatePromptAdherence, validateRerollDifference } from '../swipe-ugc/recipes/sort/recipe.mjs';

// Local-only process supervisor. Starting the SWIPE dev platform also starts
// the persistent subscription-backed generator, while an already-running
// standalone instance is reused. Detached job runners outlive either HTTP
// process, so a Vite restart reconnects instead of cancelling generation.
function localGeneratorLifecycle(): Plugin {
  const generatorRoot = path.resolve(__dirname, '../swipe-generator');
  const endpoint = process.env.VITE_LOCAL_GENERATOR_URL || 'http://127.0.0.1:4317';
  const autostart = process.env.SWIPE_GENERATOR_AUTOSTART !== '0';
  let child: ReturnType<typeof spawn> | null = null;
  let monitor: ReturnType<typeof setInterval> | null = null;
  let closing = false;

  const healthy = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const ensureRunning = async (): Promise<void> => {
    if (!autostart || closing || child?.exitCode === null || await healthy()) return;
    let url: URL;
    try { url = new URL(endpoint); } catch {
      console.warn(`[swipe-generator] invalid VITE_LOCAL_GENERATOR_URL: ${endpoint}`);
      return;
    }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      console.warn(`[swipe-generator] autostart skipped for non-local endpoint: ${endpoint}`);
      return;
    }
    const entry = path.join(generatorRoot, 'src', 'server.mjs');
    if (!fs.existsSync(entry)) {
      console.warn(`[swipe-generator] service not found at ${generatorRoot}`);
      return;
    }
    const launched = spawn(process.execPath, [entry], {
      cwd: generatorRoot,
      env: {
        ...process.env,
        SWIPE_GENERATOR_HOST: url.hostname,
        SWIPE_GENERATOR_PORT: url.port || '4317',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = launched;
    launched.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    launched.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    launched.once('exit', (code, signal) => {
      if (child === launched) child = null;
      if (!closing) console.warn(`[swipe-generator] exited (${signal || code}); Vite will restart it`);
    });
  };

  return {
    name: 'local-swipe-generator',
    apply: 'serve',
    configureServer(server) {
      void ensureRunning();
      monitor = setInterval(() => { void ensureRunning(); }, 5000);
      monitor.unref();
      server.httpServer?.once('close', () => {
        closing = true;
        if (monitor) clearInterval(monitor);
        if (child?.exitCode === null) child.kill('SIGTERM');
      });
    },
  };
}

// Dev only: serve each playable's SWIPE build from playables/<id>/dist-swipe/,
// so `npm run dev` mirrors the deployed swipe-platform site (where `./<id>.html`
// are siblings of the feed's index.html). The swipe builds are same-origin here,
// so the off-screen pause (document.hidden override) and the postMessage
// completion bridge both work in dev. Without this, Vite's SPA fallback returns
// the feed's own index.html for `/<id>.html` → recursive feed-in-feed. On the
// deployed static site this plugin is absent; the files are served directly.
function servePlayables(): Plugin {
  const playablesDir = path.resolve(__dirname, '../playables');
  const deployManifest = path.resolve(__dirname, '../swipe-platform/versions.json');
  type SwipeBuild = { dir: string; root: string; html: string; payload: string };
  const resolveBuild = (name: string): SwipeBuild | null => {
    // Deploy artifacts are named `<base>-swipe.html`. The source dir is
    // either that exact name (a dedicated `-swipe` fork dir) or the base
    // dir with the `-swipe` stripped (built with SWIPE=1). Try both.
    const candidates = [name, name.replace(/-swipe$/, '')];
    for (const dir of candidates) {
      const root = path.join(playablesDir, dir, 'dist-swipe');
      const html = path.join(root, 'index.html');
      const payload = path.join(root, 'payload.js');
      if (fs.existsSync(html)) return { dir, root, html, payload };
    }
    return null;
  };
  const deployVersion = (name: string): string => {
    try {
      const manifest = JSON.parse(fs.readFileSync(deployManifest, 'utf8')) as Record<string, string | { version?: string }>;
      const entry = manifest[name];
      return typeof entry === 'string' ? entry : String(entry?.version || 'dev');
    } catch { return 'dev'; }
  };
  const rewriteDeployPaths = (name: string, source: string): string =>
    source
      .replace('src="./payload.js"', `src="./${name}.payload.js?v=${encodeURIComponent(deployVersion(name))}"`)
      .replace(/(["'])\.\/video-/g, `$1./${name}.video-`)
      .replace(/(["'])\.\/asset-/g, `$1./${name}.asset-`);
  const resolveCover = (name: string, suffix: '' | '.c'): string | null => {
    const level = name.match(/^(.*)-l(\d+)-swipe$/);
    if (level) {
      for (const sourceName of [`${level[1]}-swipe`, level[1]]) {
        const build = resolveBuild(sourceName);
        const file = build && path.join(build.root, `cover.l${level[2]}${suffix}.jpg`);
        if (file && fs.existsSync(file)) return file;
      }
    }

    const build = resolveBuild(name);
    const file = build && path.join(build.root, `cover${suffix}.jpg`);
    return file && fs.existsSync(file) ? file : null;
  };

  return {
    name: 'serve-swipe-playables',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (url === '/versions.json' && fs.existsSync(deployManifest)) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(fs.readFileSync(deployManifest, 'utf8'));
          return;
        }
        const htmlMatch = url.match(/^\/([\w.\-]+)\.html$/);
        if (htmlMatch && htmlMatch[1] !== 'index') {
          const name = htmlMatch[1];
          const build = resolveBuild(name);
          if (build) {
            const html = rewriteDeployPaths(name, fs.readFileSync(build.html, 'utf8'));
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          }
        }

        const payloadMatch = url.match(/^\/([\w.\-]+)\.payload\.js$/);
        if (payloadMatch) {
          const name = payloadMatch[1];
          const build = resolveBuild(name);
          if (build && fs.existsSync(build.payload)) {
            const js = rewriteDeployPaths(name, fs.readFileSync(build.payload, 'utf8'));
            res.setHeader('content-type', 'application/javascript; charset=utf-8');
            res.end(js);
            return;
          }
        }

        const coverMatch = url.match(/^\/([\w.\-]+)\.cover(\.c)?\.jpg$/);
        if (coverMatch) {
          const file = resolveCover(coverMatch[1], (coverMatch[2] || '') as '' | '.c');
          if (file) {
            res.setHeader('content-type', 'image/jpeg');
            fs.createReadStream(file).pipe(res);
            return;
          }
        }

        const videoMatch = url.match(/^\/([\w.\-]+)\.video-(.+)$/);
        if (videoMatch) {
          const build = resolveBuild(videoMatch[1]);
          const file = build && path.join(build.root, `video-${videoMatch[2]}`);
          if (file && fs.existsSync(file)) {
            res.setHeader('content-type', file.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
            fs.createReadStream(file).pipe(res);
            return;
          }
        }

        const assetMatch = url.match(/^\/([\w.\-]+)\.asset-(.+)$/);
        if (assetMatch) {
          const build = resolveBuild(assetMatch[1]);
          const file = build && path.join(build.root, `asset-${assetMatch[2]}`);
          if (file && fs.existsSync(file)) {
            const ext = path.extname(file).toLowerCase();
            const contentType: Record<string, string> = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
              '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
              '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
            };
            res.setHeader('content-type', contentType[ext] || 'application/octet-stream');
            fs.createReadStream(file).pipe(res);
            return;
          }
        }

        next();
      });
    },
  };
}

// Dev only: theme-pack generation for the ISLAND meta prototype (src/island.ts,
// triangle icon). POST /island-api/theme {prompt, avoid?} → Claude generates a
// color/style pack that the island's fork recipe applies to the mechanic.
// Credentials: ANTHROPIC_API_KEY env (or an `ant auth login` profile) read at
// request time. The client falls back to keyword presets whenever this endpoint
// is absent (deployed static site) or errors (no key, bad output) — the island
// never breaks because of this. In production this becomes a backend endpoint.
function islandThemeApi(): Plugin {
  const SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short evocative theme name, 2-3 words, in the same language as the prompt' },
      items: { type: 'array', minItems: sortRecipe.pack.itemCount, maxItems: sortRecipe.pack.itemCount, items: { type: 'string', pattern: sortRecipe.pack.hexPattern }, description: 'Gameplay-distinguishable marble colors' },
      ground: { type: 'string', description: 'Island sector ground color, mid-tone saturated, #RRGGBB' },
      edge: { type: 'string', description: 'Darker shade of ground, #RRGGBB' },
      sceneBg: { type: 'string', description: 'Dominant live mechanic background, faithfully follows dark/light prompt, #RRGGBB' },
      boardBg: { type: 'string', description: 'Source-board surface color fitting the theme, #RRGGBB' },
      belt: { type: 'string', description: 'Conveyor surface color, #RRGGBB' },
      outline: { type: 'string', description: 'Readable structural outline color, #RRGGBB' },
      body: { type: 'string', description: 'Building body color, #RRGGBB' },
      roof: { type: 'string', description: 'Building roof color, more saturated, #RRGGBB' },
      prop: { type: 'string', enum: sortRecipe.pack.props, description: 'Decoration shape that best fits the theme' },
      difficulty: { type: 'string', enum: sortRecipe.pack.difficulties },
      motion: { type: 'string', enum: sortRecipe.pack.motions },
      marbleStyle: { type: 'string', enum: sortRecipe.pack.marbleStyles },
      markerStyle: { type: 'string', enum: sortRecipe.pack.markerStyles },
      targetShape: { type: 'string', enum: sortRecipe.pack.targetShapes },
      conveyorPath: { type: 'string', enum: sortRecipe.pack.conveyorPaths },
      sourceShape: { type: 'string', enum: sortRecipe.pack.sourceShapes },
      backgroundPattern: { type: 'string', enum: sortRecipe.pack.backgroundPatterns },
    },
    required: ['name', 'items', 'ground', 'edge', 'sceneBg', 'boardBg', 'belt', 'outline', 'body', 'roof', 'prop',
      'difficulty', 'motion', 'marbleStyle', 'markerStyle', 'targetShape', 'conveyorPath', 'sourceShape', 'backgroundPattern'],
    additionalProperties: false,
  };
  // Subscription path for prototyping: with no API key in the environment we
  // shell out to the locally installed Claude Code CLI (`claude -p`) — those
  // calls are covered by the developer's Claude subscription instead of
  // per-call API billing. Slower (~10-60s) and dev-machine-only; production
  // uses the API (or a backend worker) with a real key.
  const cliTheme = (fullPrompt: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      execFile(
        'claude',
        ['-p', fullPrompt],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) { reject(err); return; }
          try {
            const m = String(stdout).match(/\{[\s\S]*\}/);
            if (!m) throw new Error('no JSON in CLI output');
            resolve(JSON.parse(m[0]) as Record<string, unknown>);
          } catch (e) { reject(e); }
        },
      );
    });
  return {
    name: 'island-theme-api',
    configureServer(server) {
      const ugcRoot = path.resolve(__dirname, '../swipe-ugc');

      // Serve the UGC repo in dev so hosted builds play without Render
      // (production serves the same paths from the swipe-ugc static site).
      server.middlewares.use('/ugc', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = path.join(ugcRoot, rel);
        if (!file.startsWith(ugcRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { next(); return; }
        res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(file));
      });

      // Bake-on-confirm: called when the player BUILDS a mechanic (not per
      // preview/reroll). Runs the swipe-ugc worker synchronously: bake →
      // autoplay test → git publish → per-player bot notification (--chat from
      // the mini-app initData). Returns the hosted URL.
      server.middlewares.use('/island-api/bake', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString(); });
        req.on('end', () => {
          void (async () => {
            res.setHeader('content-type', 'application/json');
            try {
              const { pack, prompt, chat } = JSON.parse(body || '{}') as { pack?: unknown; prompt?: string; chat?: number };
              if (!pack || typeof pack !== 'object') {
                res.statusCode = 422;
                res.end(JSON.stringify({ error: 'pack must be an object' }));
                return;
              }
              const packErr = validatePack(pack as Record<string, unknown>);
              if (packErr) {
                res.statusCode = 422;
                res.end(JSON.stringify({ error: `invalid pack: ${packErr}` }));
                return;
              }
              const worker = path.resolve(ugcRoot, 'worker/bake.mjs');
              if (!fs.existsSync(worker)) throw new Error('bake worker not found');
              const wargs = [worker, '--pack', JSON.stringify(pack), '--prompt', String(prompt ?? ''), '--user', 'dev'];
              if (chat) wargs.push('--chat', String(chat));
              const stdout = await new Promise<string>((resolve, reject) => {
                execFile('node', wargs, { timeout: 300000 }, (werr, out, errOut) => {
                  console.log(`[ugc-worker] ${werr ? `failed: ${String(werr)}` : 'ok'}`);
                  if (out) console.log(out.trim());
                  if (errOut) console.error(errOut.trim());
                  if (werr) reject(new Error(errOut.trim() || String(werr)));
                  else resolve(out);
                });
              });
              const m = stdout.match(/^RESULT (\{.*\})$/m);
              if (!m) throw new Error('no RESULT line from worker');
              const rel = (JSON.parse(m[1]) as { rel: string }).rel;
              const base = process.env.UGC_BASE_URL;
              res.end(JSON.stringify({ rel, url: base ? `${base.replace(/\/$/, '')}/${rel}` : `ugc/${rel}` }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(e) }));
            }
          })();
        });
      });

      server.middlewares.use('/island-api/theme', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString(); });
        req.on('end', () => {
          void (async () => {
            res.setHeader('content-type', 'application/json');
            try {
              const { prompt, avoid, difficulty = 'surprise', motion = 'surprise' } = JSON.parse(body || '{}') as {
                prompt?: string;
                avoid?: string;
                difficulty?: string;
                motion?: string;
              };
              const preferences = { difficulty, motion };
              const seed = Math.floor(Math.random() * 0x100000000);
              const resolvedPreferences = resolvePreferences(seed, preferences);
              const basePrompt = renderThemePrompt(String(prompt ?? ''), avoid ? String(avoid) : undefined, resolvedPreferences);
              const generate = async (fullPrompt: string): Promise<Record<string, unknown>> => {
                if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
                  const client = new Anthropic();
                  const msg = await client.messages.create({
                    model: process.env.ISLAND_THEME_MODEL || 'claude-opus-4-8',
                    max_tokens: 1500,
                    output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' },
                    messages: [{ role: 'user', content: fullPrompt }],
                  });
                  const text = msg.content.find((b) => b.type === 'text');
                  if (!text || text.type !== 'text') throw new Error('no text block in response');
                  return JSON.parse(text.text) as Record<string, unknown>;
                }
                return cliTheme(fullPrompt);   // subscription-covered dev path
              };
              // QA gate with one corrective retry: the validation failure is fed
              // back to the model verbatim (the fork-path pattern — validate
              // after, don't predict before).
              let lastError = '';
              for (let attempt = 0; attempt < 2; attempt++) {
                const generated = await generate(attempt === 0 ? basePrompt : `${basePrompt}\nYour previous attempt was rejected by validation: ${lastError}. Fix exactly that while keeping the theme.`);
                const pack = finalizePack(generated, seed, preferences);
                const err = validatePack(pack)
                  || validatePromptAdherence(pack, String(prompt ?? ''))
                  || validateRerollDifference(pack, avoid ? String(avoid) : undefined);
                if (!err) { res.end(JSON.stringify(pack)); return; }
                lastError = err;
              }
              res.statusCode = 422;
              res.end(JSON.stringify({ error: `pack failed validation twice: ${lastError}` }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(e) }));
            }
          })();
        });
      });
    },
  };
}

// Single self-contained HTML output — same approach as the playables creatives,
// so the build drops straight into the playables-export static site on Render
// (one file, no external requests, openable on a phone via the deploy URL).
export default defineConfig({
  base: './',
  plugins: [localGeneratorLifecycle(), servePlayables(), islandThemeApi(), viteSingleFile()],
  define: {
    // Build stamp shown bottom-left on the feed bar so it's clear which platform
    // build is live. deploy-swipe.sh passes PLATFORM_VERSION="<time> · <commit>" so the
    // badge carries the git short-hash (timestamps collide at minute resolution).
    // Falls back to a bare UTC timestamp for standalone/dev builds.
    __PLATFORM_VERSION__: JSON.stringify(process.env.PLATFORM_VERSION || new Date().toISOString().slice(0, 16).replace('T', ' ')),
    __ISLAND_SORT_RECIPE__: JSON.stringify(sortRecipe),
  },
  build: {
    target: 'es2018',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
