import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';
import path from 'path';

// Dev only: serve the real playable bundles from the sibling playables-export
// folder, so `npm run dev` mirrors Render (where `./<id>.html` are siblings of
// feed-prototype.html). Without this, Vite's SPA fallback returns the feed's own
// index.html for `/<id>.html`, which loads the feed INSIDE each iframe → infinite
// recursion (nested gutters + endless loaders). On Render this plugin is absent;
// the static site serves the files directly.
function servePlayables(): Plugin {
  const exportDir = path.resolve(__dirname, '../playables-export');
  return {
    name: 'serve-playables',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const m = url.match(/^\/([\w.\-]+\.html)$/);
        if (m && m[1] !== 'index.html' && m[1] !== 'feed-prototype.html') {
          const file = path.join(exportDir, m[1]);
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
