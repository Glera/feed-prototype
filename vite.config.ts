import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';
import path from 'path';

// Dev only: serve each playable's SWIPE build from playables/<id>/dist-swipe/,
// so `npm run dev` mirrors the deployed swipe-platform site (where `./<id>.html`
// are siblings of the feed's index.html). The swipe builds are same-origin here,
// so the off-screen pause (document.hidden override) and the postMessage
// completion bridge both work in dev. Without this, Vite's SPA fallback returns
// the feed's own index.html for `/<id>.html` → recursive feed-in-feed. On the
// deployed static site this plugin is absent; the files are served directly.
function servePlayables(): Plugin {
  const playablesDir = path.resolve(__dirname, '../playables');
  return {
    name: 'serve-swipe-playables',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const m = url.match(/^\/([\w.\-]+)\.html$/);
        if (m && m[1] !== 'index') {
          const file = path.join(playablesDir, m[1], 'dist-swipe', 'index.html');
          if (fs.existsSync(file)) {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            fs.createReadStream(file).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

// Single self-contained HTML output — same approach as the playables creatives,
// so the build drops straight into the playables-export static site on Render
// (one file, no external requests, openable on a phone via the deploy URL).
export default defineConfig({
  base: './',
  plugins: [servePlayables(), viteSingleFile()],
  build: {
    target: 'es2018',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
