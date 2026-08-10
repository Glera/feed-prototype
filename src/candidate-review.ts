import {
  apiPlayableReleaseReview,
  type PlayableReleaseSummary,
} from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const PLAYABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_BINDING_BYTES = 32_768;

type CandidateReviewLink = NonNullable<PlayableReleaseSummary['review']>;

interface CandidateReviewBinding {
  schema: 'feed.playable-release-review-binding.v1';
  releaseId: string;
  playableId: string;
  candidatePath: string;
  candidateArtifactDigest: string;
  review: {
    kind: 'rework' | 'source';
    reworkRequestId: string | null;
    sourceId: string | null;
    sourceCommit: string | null;
  };
}

export interface CandidateReviewState {
  bindingValid: boolean;
  interactiveReady: boolean;
  manualTakeover: boolean;
  approvalReady: boolean;
  terminal: 'won' | 'lost' | null;
  error: string | null;
}

export interface MountedCandidateReview {
  element: HTMLElement;
  destroy(): void;
}

const exactKeys = (value: unknown, keys: string[]): boolean => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');

function printable(value: unknown, max = 2_000): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1
    && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function candidateReviewReleaseIdFromParam(value: string | null): string | null {
  if (typeof value !== 'string' || !value.startsWith('pr_')) return null;
  const releaseId = value.slice(3);
  return UUID.test(releaseId) ? releaseId.toLowerCase() : null;
}

function expectedCandidatePath(summary: PlayableReleaseSummary): string | null {
  if (!UUID.test(summary.publishId) || !PLAYABLE_ID.test(summary.playableId)) return null;
  return `/playable-previews/${summary.publishId.toLowerCase()}/${summary.playableId}.html`;
}

function validReviewLink(summary: PlayableReleaseSummary): CandidateReviewLink | null {
  const review = summary.review;
  const expectedPath = expectedCandidatePath(summary);
  if (!review || review.unavailable || !expectedPath
    || review.candidatePath !== expectedPath
    || !DIGEST.test(review.candidateArtifactDigest)
    || !DIGEST.test(review.reviewBindingDigest)
    || !Array.isArray(review.checklist) || review.checklist.length < 1 || review.checklist.length > 12
    || review.checklist.some((item) => !printable(item, 500))) return null;
  if (review.kind === 'rework') {
    if (!review.reworkRequestId || !UUID.test(review.reworkRequestId)
      || review.sourceId !== null || review.sourceCommit !== null
      || !printable(review.originalRequest)
      || review.submittedAt === null || !Number.isFinite(Date.parse(review.submittedAt))
      || !Number.isSafeInteger(review.actorUserId) || Number(review.actorUserId) <= 0) return null;
  } else if (review.kind === 'source') {
    if (review.reworkRequestId !== null || !review.sourceId || !SOURCE_ID.test(review.sourceId)
      || !review.sourceCommit || !SHA.test(review.sourceCommit)
      || review.sourceCommit !== summary.sourceCommit
      || (review.originalRequest !== null && !printable(review.originalRequest))
      || (review.submittedAt !== null && !Number.isFinite(Date.parse(review.submittedAt)))
      || !(review.actorUserId === null
        || (Number.isSafeInteger(review.actorUserId) && Number(review.actorUserId) > 0))) return null;
  } else {
    return null;
  }
  return review;
}

function candidateUrl(review: CandidateReviewLink, auto: boolean): URL | null {
  try {
    const url = new URL(review.candidatePath, location.origin);
    if (url.origin !== location.origin || url.pathname !== review.candidatePath
      || url.username || url.password || url.search || url.hash) return null;
    url.searchParams.set('auto', auto ? '1' : '0');
    url.searchParams.set('hostPaused', '0');
    url.searchParams.set('reviewBinding', review.reviewBindingDigest);
    url.searchParams.set('artifact', review.candidateArtifactDigest);
    return url;
  } catch {
    return null;
  }
}

function bindingUrl(review: CandidateReviewLink): URL | null {
  try {
    const candidate = new URL(review.candidatePath, location.origin);
    const expected = review.candidatePath.replace(/\/[^/]+\.html$/, '/review-binding.json');
    const url = new URL(expected, location.origin);
    return candidate.origin === location.origin && url.origin === location.origin
      && url.pathname === expected && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function parseReviewBinding(value: unknown): CandidateReviewBinding | null {
  if (!exactKeys(value, [
    'schema', 'releaseId', 'playableId', 'candidatePath', 'candidateArtifactDigest', 'review',
  ])) return null;
  const binding = value as CandidateReviewBinding;
  if (binding.schema !== 'feed.playable-release-review-binding.v1'
    || !exactKeys(binding.review, ['kind', 'reworkRequestId', 'sourceId', 'sourceCommit'])) return null;
  return binding;
}

async function loadReviewBinding(
  summary: PlayableReleaseSummary,
  review: CandidateReviewLink,
): Promise<CandidateReviewBinding> {
  const url = bindingUrl(review);
  if (!url) throw new Error('review binding URL is invalid');
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok || response.redirected || new URL(response.url).origin !== location.origin
    || new URL(response.url).pathname !== url.pathname) throw new Error('review binding is unavailable');
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BINDING_BYTES) {
    throw new Error('review binding is too large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_BINDING_BYTES
    || await sha256Hex(bytes) !== review.reviewBindingDigest) {
    throw new Error('review binding digest mismatch');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('review binding is invalid JSON');
  }
  const binding = parseReviewBinding(decoded);
  if (!binding || binding.releaseId.toLowerCase() !== summary.publishId.toLowerCase()
    || binding.playableId !== summary.playableId
    || binding.candidatePath !== review.candidatePath
    || binding.candidateArtifactDigest !== review.candidateArtifactDigest
    || binding.review.kind !== review.kind
    || binding.review.reworkRequestId !== review.reworkRequestId
    || binding.review.sourceId !== review.sourceId
    || binding.review.sourceCommit !== review.sourceCommit) {
    throw new Error('review binding differs from server release summary');
  }
  return binding;
}

function reviewDetail(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'candidate-review__detail';
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('strong');
  content.textContent = value;
  row.append(key, content);
  return row;
}

function outcome(data: unknown): 'won' | 'lost' | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.source !== 'playable') return null;
  const type = String(value.type ?? value.event ?? '').toLowerCase();
  const result = String(value.outcome ?? value.result ?? '').toLowerCase();
  if (['won', 'win', 'victory', 'success'].includes(type)
    || (['complete', 'completed', 'game_completed', 'game-completed'].includes(type)
      && (value.success === true || ['won', 'win', 'success'].includes(result)))) return 'won';
  if (['lost', 'loss', 'failed', 'fail'].includes(type)
    || (['complete', 'completed', 'game_completed', 'game-completed'].includes(type)
      && (value.success === false || ['lost', 'lose', 'loss', 'fail', 'failed'].includes(result)))) return 'lost';
  return null;
}

export function mountPlayableCandidateReview(
  summary: PlayableReleaseSummary,
  onState: (state: CandidateReviewState) => void = () => {},
): MountedCandidateReview {
  const root = document.createElement('section');
  root.className = 'candidate-review';
  root.dataset.testid = 'playable-candidate-review';
  const heading = document.createElement('h3');
  heading.textContent = 'Поиграть candidate';
  const context = document.createElement('div');
  context.className = 'candidate-review__context';
  const checklistHeading = document.createElement('strong');
  checklistHeading.textContent = 'Что проверить';
  const checklist = document.createElement('ol');
  checklist.className = 'candidate-review__checklist';
  const slot = document.createElement('div');
  slot.className = 'candidate-review__slot';
  slot.dataset.testid = 'candidate-game-slot';
  const frame = document.createElement('iframe');
  frame.className = 'candidate-review__frame';
  frame.title = `Candidate ${summary.playableId}`;
  frame.allow = 'autoplay';
  frame.referrerPolicy = 'origin';
  frame.setAttribute('scrolling', 'no');
  const takeover = document.createElement('button');
  takeover.type = 'button';
  takeover.className = 'candidate-review__takeover';
  takeover.textContent = 'Коснитесь, чтобы играть вручную';
  takeover.disabled = true;
  const status = document.createElement('p');
  status.className = 'candidate-review__status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Проверяем immutable candidate…';
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'lab-auth__button lab-auth__button--quiet candidate-review__restart';
  restart.textContent = 'Перезапустить candidate';
  restart.disabled = true;
  slot.append(frame, takeover);
  root.append(heading, context, checklistHeading, checklist, slot, status, restart);

  let destroyed = false;
  let bindingValid = false;
  let interactiveReady = false;
  let manualTakeover = false;
  let manual = false;
  let terminal: 'won' | 'lost' | null = null;
  let error: string | null = null;
  const review = validReviewLink(summary);

  const emit = (): void => onState(Object.freeze({
    bindingValid,
    interactiveReady,
    manualTakeover,
    approvalReady: bindingValid && interactiveReady && manualTakeover && error === null,
    terminal,
    error,
  }));
  const fail = (message: string): void => {
    error = message;
    status.textContent = message;
    takeover.disabled = true;
    restart.disabled = true;
    root.dataset.state = 'invalid';
    emit();
  };
  const post = (type: string, extra: Record<string, unknown> = {}): void => {
    frame.contentWindow?.postMessage(
      { target: 'playable-swipe', type, ...extra },
      location.origin,
    );
  };
  const setFrameSource = (auto: boolean): void => {
    if (!review) return;
    const url = candidateUrl(review, auto);
    if (!url) {
      fail('Candidate review session невалидна. Публикация заблокирована.');
      return;
    }
    interactiveReady = false;
    terminal = null;
    restart.disabled = true;
    frame.src = url.toString();
    status.textContent = auto ? 'Запускаем autoplay/tutorial…' : 'Перезапускаем ручной режим…';
    emit();
  };

  if (review) {
    context.append(
      reviewDetail('Механика', summary.catalogMechanic ?? summary.mechanicFamily ?? summary.playableId),
      reviewDetail('Playable', summary.playableId),
    );
    if (review.kind === 'rework') {
      context.append(
        reviewDetail('Исходная просьба', review.originalRequest ?? 'Исходная задача недоступна'),
        reviewDetail('Отправлено', new Date(review.submittedAt as string).toLocaleString('ru-RU')),
        reviewDetail('Автор', String(review.actorUserId)),
      );
    } else {
      context.append(
        reviewDetail('Исходная задача', review.originalRequest ?? `Source ${review.sourceId}`),
        reviewDetail('Source identity', `${review.sourceId} @ ${review.sourceCommit}`),
      );
      if (review.submittedAt) context.append(reviewDetail('Отправлено', new Date(review.submittedAt).toLocaleString('ru-RU')));
      if (review.actorUserId !== null) context.append(reviewDetail('Автор', String(review.actorUserId)));
    }
    for (const item of review.checklist) {
      const row = document.createElement('li');
      row.textContent = item;
      checklist.appendChild(row);
    }
  } else {
    context.append(
      reviewDetail('Playable', summary.playableId),
      reviewDetail('Исходная задача', 'Исходная задача недоступна'),
    );
    const row = document.createElement('li');
    row.textContent = 'Server-owned review linkage недоступен.';
    checklist.appendChild(row);
  }

  const onMessage = (event: MessageEvent): void => {
    if (destroyed || event.source !== frame.contentWindow || event.origin !== location.origin || !event.data
      || typeof event.data !== 'object' || event.data.source !== 'playable') return;
    const type = String(event.data.type ?? '').toLowerCase();
    if (type === 'static_ready') {
      post('setHostPaused', { paused: false });
      post('prepareInteractive');
      status.textContent = 'Candidate готовит интерактивный режим…';
      return;
    }
    if (type === 'interactive_ready') {
      interactiveReady = true;
      restart.disabled = false;
      if (!manual) {
        post('startAutoPlay');
        takeover.disabled = false;
        status.textContent = 'Autoplay/tutorial запущен. Коснитесь игры для ручной проверки.';
      } else {
        post('stopAutoPlay');
        status.textContent = 'Ручной режим готов. Проверьте механику и завершение.';
      }
      root.dataset.state = manual ? 'manual' : 'autoplay';
      emit();
      return;
    }
    const result = outcome(event.data);
    if (result) {
      terminal = result;
      status.textContent = result === 'won'
        ? 'Candidate завершён: победа. Можно перезапустить.'
        : 'Candidate завершён: поражение. Можно перезапустить.';
      root.dataset.state = 'terminal';
      restart.disabled = false;
      emit();
    }
  };
  window.addEventListener('message', onMessage);

  takeover.addEventListener('click', () => {
    if (!bindingValid || !interactiveReady || manual) return;
    manual = true;
    manualTakeover = true;
    takeover.hidden = true;
    post('stopAutoPlay');
    setFrameSource(false);
  });
  restart.addEventListener('click', () => {
    if (!bindingValid || !manual) return;
    setFrameSource(false);
  });
  const onVisibility = (): void => {
    if (!bindingValid) return;
    post('setHostPaused', { paused: document.hidden });
    if (document.hidden) post('stopAutoPlay');
    else if (!manual && interactiveReady) post('startAutoPlay');
  };
  document.addEventListener('visibilitychange', onVisibility);

  void (async () => {
    if (!review) {
      fail('Исходная задача недоступна. Candidate review и публикация заблокированы.');
      return;
    }
    try {
      await loadReviewBinding(summary, review);
      if (destroyed) return;
      bindingValid = true;
      root.dataset.releaseId = summary.publishId;
      setFrameSource(true);
    } catch {
      if (!destroyed) fail('Candidate review binding недоступен или повреждён. Публикация заблокирована.');
    }
  })();
  emit();

  return {
    element: root,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibility);
      try { post('setHostPaused', { paused: true }); } catch { /* best effort */ }
      try { frame.src = 'about:blank'; } catch { /* best effort */ }
      root.remove();
    },
  };
}

export async function mountPlayableCandidateReviewSurface(releaseId: string): Promise<void> {
  document.body.classList.add('lab-auth-open');
  const root = document.createElement('main');
  root.className = 'lab-auth';
  root.setAttribute('aria-label', 'Playable candidate review');
  const shell = document.createElement('div');
  shell.className = 'lab-auth__shell';
  const header = document.createElement('header');
  header.className = 'lab-auth__header';
  const heading = document.createElement('strong');
  heading.textContent = 'Готово к проверке';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lab-auth__button lab-auth__button--quiet lab-auth__close';
  close.textContent = 'Закрыть';
  close.addEventListener('click', () => {
    try {
      const telegram = (window as any).Telegram?.WebApp;
      if (typeof telegram?.close === 'function') {
        telegram.close();
        return;
      }
    } catch { /* browser fallback */ }
    location.replace('/');
  });
  header.append(heading, close);
  const card = document.createElement('section');
  card.className = 'lab-auth__card';
  const status = document.createElement('p');
  status.className = 'lab-auth__status';
  status.textContent = 'Загружаем server-owned release binding…';
  card.appendChild(status);
  shell.append(header, card);
  root.appendChild(shell);
  document.body.appendChild(root);
  try {
    const summary = await apiPlayableReleaseReview(releaseId);
    if (summary.schema !== 'feed.playable-release-summary.v1'
      || summary.publishId.toLowerCase() !== releaseId.toLowerCase()) {
      throw new Error('release summary mismatch');
    }
    const mounted = mountPlayableCandidateReview(summary);
    status.remove();
    card.appendChild(mounted.element);
  } catch {
    status.textContent = 'Исходная задача недоступна или release больше нельзя проверить.';
  }
}
