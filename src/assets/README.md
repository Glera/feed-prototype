# Feed UI assets

Icons / images for the swipe-platform **feed shell** (gift/chest, stars, badges,
series pills — the platform chrome, NOT individual mechanics).

Drop files here (PNG / WebP / SVG), then import them in `../feed.ts` or reference
from `../styles.css`. The feed builds to a single `index.html` with
`assetsInlineLimit: 100_000_000` + `viteSingleFile`, so every imported asset is
**inlined as a data-URI** — no extra network requests, versioned with each deploy.

Example (swap the `🎁` emoji in `renderSeriesRow`):

```ts
import GIFT_ICON from './assets/gift.png';
// ...
html += `<div class="series-chest…"><img class="series-chest__img" src="${GIFT_ICON}" alt=""></div>`;
```

Keep icons small (they bloat the inlined bundle). For mechanic-specific art use
`playables/<id>/assets/source/` instead; for raw static files served as-is use the
`swipe-platform/` repo root (referenced by URL, e.g. `./gift.png`).
