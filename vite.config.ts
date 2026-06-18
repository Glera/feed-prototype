import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained HTML output — same approach as the playables creatives,
// so the build drops straight into the playables-export static site on Render
// (one file, no external requests, openable on a phone via the deploy URL).
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2018',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
