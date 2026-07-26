/**
 * Share / Challenge v1 play overlay (mountLevel DI shim for challenge-play.mjs).
 *
 * Self-contained, like the island world (src/island.ts): it injects its own
 * styles (chpl-* namespace) and mounts its OWN content-addressed iframe in a
 * full-screen overlay inset between the HUD top-zone and the feed bar — entirely
 * outside the feed ring/slot/catalog machinery. It drives the SAME
 * configure_level/catalog_required handshake via ChallengePlayerSession (the
 * sibling player), and resolves with the host-measured solve time on a win.
 *
 * The runtime URL is content-addressed and points at the production
 * swipe-platform origin (runtime-releases/… are hosted there); the postMessage
 * handshake is cross-origin and the session's origin check gates it.
 *
 * Contract: mountChallengeLevel resolves { metricValue } (solve time in ms, the
 * exact /results `metric_value` for metric_key='time_ms') on a win, and REJECTS
 * on close/failure/timeout — so the orchestrator reports nothing on an honest
 * exit (no attempt is recorded for an abandoned or broken play).
 */
import { ChallengePlayerSession } from './challenge-player.mjs';
import type { ChallengeLevelSpecBundleV1 } from './challenge-player.mjs';

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const css = `
.chpl-world{position:fixed;top:var(--top-zone-h,0);left:0;right:0;bottom:var(--bar-reserve,0);
  z-index:4000;display:flex;flex-direction:column;background:var(--platform-bg,#0b0f14);
  opacity:0;transition:opacity .2s ease}
.chpl-world--in{opacity:1}
.chpl-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;
  gap:8px;padding:8px 12px;color:#fff;font:800 13px/1 system-ui,sans-serif}
.chpl-head__title{display:flex;align-items:center;gap:6px}
.chpl-close{width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.08);color:#fff;font:700 15px/1 system-ui,sans-serif;cursor:pointer}
.chpl-stage{flex:1;min-height:0;position:relative;background:var(--platform-bg,#0b0f14)}
.chpl-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}
.chpl-status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  color:rgba(255,255,255,.7);font:600 12px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none}
.chpl-frame--ready+.chpl-status{display:none}
@media (prefers-reduced-motion: reduce){.chpl-world{transition:none}}`;
  const st = document.createElement('style');
  st.setAttribute('data-chpl', '');
  st.textContent = css;
  document.head.appendChild(st);
}

const CONFIGURE_TIMEOUT_MS = 12_000;

/** Parse a playable win/lose signal — the SAME shape the feed accepts from the
 *  built-in mechanics (feed.ts outcomeFromMessage), so the challenge runtime's
 *  completion is recognized identically. */
function outcomeOf(data: unknown): 'won' | 'lost' | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = String(d.type ?? d.event ?? '').toLowerCase();
  const event = String(d.event ?? '').toUpperCase();
  const outcome = String(d.outcome ?? d.result ?? '').toLowerCase();
  const won = d.success === true || outcome === 'won' || outcome === 'win' || outcome === 'success';
  const lost = d.success === false || ['lost', 'lose', 'loss', 'fail', 'failed'].includes(outcome);
  if (['completed', 'complete', 'game_completed', 'game-completed'].includes(type)) {
    if (won) return 'won';
    if (lost) return 'lost';
  }
  if (['won', 'win', 'victory', 'success'].includes(type)) return 'won';
  if (['lost', 'loss', 'failed', 'fail'].includes(type)) return 'lost';
  if (event === 'CHALLENGE_SOLVED') return 'won';
  if (event === 'CHALLENGE_FAILED') return 'lost';
  return null;
}

export interface MountChallengeLevelOptions {
  baseUrl: string;
  /** Optional: title shown in the overlay header. */
  title?: string;
}

export class ChallengeOverlayAbort extends Error {
  constructor(public readonly reason: string) {
    super(`challenge play aborted: ${reason}`);
    this.name = 'ChallengeOverlayAbort';
  }
}

/**
 * Mount the exact challenge level in a self-contained overlay and resolve with
 * the host-measured solve time (ms) on a win. The DI `mountLevel` for
 * playRecipientChallenge / playSourceChallenge.
 */
export function mountChallengeLevel(
  ctx: { bundle: ChallengeLevelSpecBundleV1; kind: 'recipient' | 'source' },
  options: MountChallengeLevelOptions,
): Promise<{ metricValue: number }> {
  injectStyles();
  const frameEpoch = 1;
  return new Promise<{ metricValue: number }>((resolve, reject) => {
    const world = document.createElement('div');
    world.className = 'chpl-world';
    const title = options.title ?? (ctx.kind === 'source' ? '⚡ Твой вызов' : '⚡ Вызов');
    const stage = document.createElement('div');
    stage.className = 'chpl-stage';
    const frame = document.createElement('iframe');
    frame.className = 'chpl-frame';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'autoplay');
    frame.setAttribute('title', 'challenge');
    const status = document.createElement('div');
    status.className = 'chpl-status';
    status.textContent = 'Загружаю уровень…';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'chpl-close';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.textContent = '✕';
    const head = document.createElement('div');
    head.className = 'chpl-head';
    head.innerHTML = `<div class="chpl-head__title">${title}</div>`;
    head.appendChild(closeBtn);
    stage.append(frame, status);
    world.append(head, stage);

    let session: ChallengePlayerSession | null = null;
    let solveStart = 0;
    let settled = false;
    let timeoutTimer: number | null = null;

    const cleanup = () => {
      if (timeoutTimer !== null) { window.clearTimeout(timeoutTimer); timeoutTimer = null; }
      window.removeEventListener('message', onMessage);
      try { session?.dispose(frameEpoch); } catch { /* noop */ }
      try { frame.src = 'about:blank'; } catch { /* noop */ }
      world.classList.remove('chpl-world--in');
      window.setTimeout(() => world.remove(), 220);
    };
    const finishWin = (metricValue: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ metricValue: Math.max(1, Math.round(metricValue)) });
    };
    const abort = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ChallengeOverlayAbort(reason));
    };

    closeBtn.addEventListener('click', () => abort('closed'));

    const onMessage = (event: MessageEvent) => {
      if (!session || settled) return;
      if (event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      const type = data && typeof data === 'object' ? String(data.type ?? '') : '';
      if (type === 'configure_ready' || type === 'configured' || type === 'configure_failed') {
        const transition = session.handleMessage(
          { source: event.source, origin: event.origin, data: event.data },
          frameEpoch,
        );
        for (const effect of transition.effects) {
          if (effect.type === 'post_configure_level') {
            try { frame.contentWindow?.postMessage(effect.message, effect.targetOrigin); }
            catch { abort('post_failed'); return; }
          } else if (effect.type === 'challenge_configuration_failure') {
            abort(`configuration_${effect.payload.reason}`);
            return;
          } else if (effect.type === 'challenge_reveal_ready') {
            // Configured + visible: the exact level is mounted. Start the solve
            // clock and reveal the stage (host-measured time = /results metric).
            solveStart = performance.now();
            if (timeoutTimer !== null) { window.clearTimeout(timeoutTimer); timeoutTimer = null; }
            frame.classList.add('chpl-frame--ready');
          }
        }
        // Configured → declare the frame visible so the reveal effect can fire.
        if (session.snapshot().phase === 'configured') {
          const revealed = session.setVisible(true, frameEpoch);
          for (const effect of revealed.effects) {
            if (effect.type === 'challenge_reveal_ready' && solveStart === 0) {
              solveStart = performance.now();
              frame.classList.add('chpl-frame--ready');
            }
          }
        }
        return;
      }
      // Gameplay signals are only honored once the exact level is configured.
      if (session.snapshot().phase !== 'configured' || solveStart === 0) return;
      const outcome = outcomeOf(event.data);
      if (outcome === 'won') finishWin(performance.now() - solveStart);
      // 'lost' → let the runtime restart in place; the player retries or closes.
    };
    window.addEventListener('message', onMessage);

    document.body.appendChild(world);
    requestAnimationFrame(() => world.classList.add('chpl-world--in'));

    const frameSource = frame.contentWindow;
    if (!frameSource) { abort('frame_source_missing'); return; }
    try {
      session = new ChallengePlayerSession({ bundle: ctx.bundle, baseUrl: options.baseUrl, frameEpoch, frameSource });
    } catch (e) {
      abort(`bundle_${(e as { code?: string })?.code ?? 'invalid'}`);
      return;
    }
    frame.referrerPolicy = session.navigation.referrerPolicy;
    frame.src = session.navigation.src;
    timeoutTimer = window.setTimeout(() => abort('timeout'), CONFIGURE_TIMEOUT_MS);
  });
}
