# Feed cold-start p95 — baseline

Reproducible measurement of how long a **cold** feed launch takes to reach:

- **A. First painted feed screen** — the first pixels of the feed (branded
  preloader / shell). Reported as the browser's **First Contentful Paint (FCP)**,
  cross-checked against the passive mark `perf:feed-first-render` (a `requestAnimationFrame`
  after the constructor build/render + preloader are committed to the DOM).
- **B. First card with working autoplay** — the mark `perf:first-card-autoplay`,
  emitted by `src/feed.ts` the instant the first **current** card is revealed and
  its autoplay has been kicked off (`tryRevealFrame` → `ensureFrameAutoPlay`).

Both times are relative to navigation start (`performance.timeOrigin` of the fresh
document). This is one of the hard enablement gates for `capabilities.levelSeries=true`.

> **This is a baseline METHOD, not the final gate figure.** Desktop headless
> Chromium over localhost is not a phone inside the Telegram WebView. Read the
> caveats below before quoting any number as "the" cold-start p95.

## How to reproduce

```bash
# from the feed-prototype worktree/checkout
node scripts/perf-cold-start.mjs            # builds, serves, runs N=20, prints p50/p95
# knobs: PERF_RUNS=20  PERF_PORT=4319  PERF_NO_BUILD=1  PERF_RUN_TIMEOUT_MS=30000
```

The harness: `vite build` the feed → assemble the **prod deploy layout** in `dist/`
(the freshly-built single-file `index.html` next to every mechanic
`<id>-swipe.html` + payload + `versions.json`, copied from `../swipe-platform`,
which is exactly how the deployed static site is laid out) → `vite preview` →
open the feed in **N fresh Playwright browser contexts** (each context has an
isolated, empty HTTP cache ⇒ genuine cold start) → read the marks + FCP →
write `perf-cold-start-results.json`.

## Environment

| | |
|---|---|
| Date | 2026-07-23 (run `generatedAt` 2026-07-23T05:40:52Z) |
| Feed commit | `82498a4` (worktree `perf-cold-start`, off `feed-prototype`@`f67fd01`) |
| Machine | Apple M1 Pro, 10 cores, 16 GB, macOS 26.5.1 (25F80) |
| Node | v24.7.0 |
| Browser | headless desktop Chromium 145.0.7632.6 (Playwright 1.58.2) |
| Viewport | 390 × 844 (portrait) |
| Server | `vite preview` over `http://127.0.0.1:4319`, prod dist + mechanic siblings |
| First card in ring | `merge-locked-v1-swipe` (default `PLAYABLES[0]`) |
| Cold cache | fresh browser context per run |
| External origins | **blocked** (telegram.org SDK, backend, fonts) — see caveats |
| Percentile method | nearest-rank on ascending values (`ceil(q/100·n)−1`); p95 of N=20 = 19th value |

## Results — N = 20, 20/20 ok

| run | FCP (A) ms | first-render mark ms | first-card autoplay (B) ms |
|----:|-----------:|---------------------:|---------------------------:|
| 1   | 192 | 173 | 1087 |
| 2   | 112 | 100 | 815 |
| 3   | 104 | 94  | 790 |
| 4   | 104 | 95  | 788 |
| 5   | 104 | 92  | 785 |
| 6   | 104 | 93  | 786 |
| 7   | 104 | 93  | 785 |
| 8   | 104 | 92  | 803 |
| 9   | 112 | 101 | 786 |
| 10  | 108 | 99  | 800 |
| 11  | 104 | 94  | 788 |
| 12  | 104 | 94  | 789 |
| 13  | 104 | 93  | 790 |
| 14  | 104 | 93  | 798 |
| 15  | 108 | 98  | 799 |
| 16  | 104 | 92  | 792 |
| 17  | 108 | 96  | 799 |
| 18  | 108 | 98  | 777 |
| 19  | 104 | 92  | 798 |
| 20  | 108 | 96  | 790 |

| metric | p50 | **p95** | min | max | mean |
|---|---:|---:|---:|---:|---:|
| **A. first painted feed screen (FCP)** | 104 | **112** | 104 | 192 | 110 |
| — cross-check `perf:feed-first-render` | 94 | 101 | 92 | 173 | 99 |
| **B. first card with working autoplay** | 790 | **815** | 777 | 1087 | 807 |

Run 1 is a consistent cold-outlier (V8 JIT + first browser-context warm-up):
it drives both maxima (192 ms / 1087 ms). From run 2 onward the numbers are very
tight (FCP ~104–112 ms, autoplay ~777–815 ms), so p95 here is essentially "the
second-worst-ish run", dominated by that first-run warm-up rather than by feed
variance.

## Caveats — why this is a method, not the gate number

1. **Desktop ≠ phone in Telegram.** Headless Chromium on an M1 Pro has far more
   CPU than a mid-tier Android, and no Telegram WebView shell. The **B** metric
   (mechanic iframe boot + payload parse + autoplay) is CPU-bound and will be
   **materially slower on real devices**. Treat these as a floor.
2. **localhost has no network.** Assets load over loopback: no cellular/Wi-Fi
   RTT, no TLS, no CDN. Real cold starts pay first-byte + transfer latency on
   top of everything here — especially for the mechanic payloads.
3. **External origins are blocked.** The Telegram SDK (`telegram.org`) and any
   backend are aborted so the number reflects **our own asset** cold-start, not
   third-party CDN latency. In a real launch the SDK `<script>` and `/session`
   are on the critical-ish path (though `getInitData()`-gated work is skipped
   outside Telegram, as here).
4. **B is the host-issued `startAutoPlay` moment**, i.e. the host revealed the
   card and called the mechanic's autoplay API — not a verified *first animation
   frame rendered inside the iframe*. The true "user sees it moving" is at or
   slightly after this mark.
5. **Outside Telegram** there is no signed `initData`, so the server-seed wait
   and roster path are skipped; the preloader dismisses on mechanic-ready alone.
   Inside Telegram the preloader also waits on the first `/session` seed (capped),
   which can add to the visible time-to-feed.
6. **Percentiles over N=20** are coarse and warm-up-sensitive; this is a
   regression tripwire and order-of-magnitude baseline, not a statistically
   tight SLA.

## Next step

Re-run this exact harness under Chromium CPU throttling (Playwright/CDP
`Emulation.setCPUThrottlingRate`, e.g. 4–6×) plus a throttled network profile,
to produce a device-representative **B** number before treating any p95 as the
`levelSeries` gate value.
