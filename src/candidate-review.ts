import {
  apiPlayableReleaseDecision,
  apiPlayableReleaseReview,
  type PlayableReleaseDecisionReceipt,
  type PlayableReleaseSummary,
} from './api';
import { candidateFeedPreviewUrl } from './candidate-feed-preview';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const PLAYABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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

function validTerminalDecision(
  value: unknown,
  summary: PlayableReleaseSummary,
): PlayableReleaseDecisionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as PlayableReleaseDecisionReceipt;
  const review = summary.review;
  if (receipt.schema !== 'feed.playable-release-decision.receipt.v1'
    || receipt.decisionSchema !== 'feed.playable-release-decision.v1'
    || !UUID.test(receipt.decisionId) || !UUID.test(receipt.mutationId)
    || receipt.releaseId.toLowerCase() !== summary.publishId.toLowerCase()
    || !Number.isSafeInteger(receipt.actorUserId) || receipt.actorUserId <= 0
    || !review || receipt.reviewBindingDigest !== review.reviewBindingDigest
    || receipt.candidateArtifactDigest !== review.candidateArtifactDigest
    || receipt.audience !== 'exact-user' || receipt.publicRollout !== false
    || !DIGEST.test(receipt.receiptDigest) || !Number.isFinite(Date.parse(receipt.decidedAt))
    || receipt.authorization?.schema
      !== 'feed.playable-release-authorization-disposition.v1'
    || !Number.isSafeInteger(receipt.authorization.itemCount)
    || receipt.authorization.itemCount < 0
    || !DIGEST.test(receipt.authorization.itemsDigest)
    || !Array.isArray(receipt.authorization.items)
    || receipt.authorization.items.length
      !== Math.min(receipt.authorization.itemCount, 100)) return null;
  if (receipt.decision === 'accept') {
    if (receipt.instruction !== null || receipt.successor !== null
      || !['approved', 'awaiting_exact_authorization'].includes(receipt.authorization.state)) return null;
  } else if (receipt.decision === 'rework') {
    const successor = receipt.successor;
    if (!printable(receipt.instruction) || receipt.authorization.state !== 'fenced'
      || !successor || !UUID.test(successor.requestId)
      || successor.parentReleaseId.toLowerCase() !== summary.publishId.toLowerCase()
      || !(successor.predecessorRequestId === null || UUID.test(successor.predecessorRequestId))
      || !Number.isSafeInteger(successor.cycle) || successor.cycle < 1) return null;
  } else {
    return null;
  }
  return receipt;
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
  const feedPreview = document.createElement('button');
  feedPreview.type = 'button';
  feedPreview.className = 'lab-auth__button lab-auth__button--quiet candidate-review__feed';
  feedPreview.textContent = 'Проверить в реальной ленте';
  feedPreview.disabled = true;
  slot.append(frame, takeover);
  root.append(heading, context, checklistHeading, checklist, slot, status, restart, feedPreview);

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
    feedPreview.disabled = true;
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
  feedPreview.addEventListener('click', () => {
    if (!bindingValid || !review) return;
    location.assign(candidateFeedPreviewUrl({
      releaseId: summary.publishId,
      playableId: summary.playableId,
      candidateArtifactDigest: review.candidateArtifactDigest,
      reviewBindingDigest: review.reviewBindingDigest,
    }).toString());
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
      feedPreview.disabled = false;
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
    const initialDecision = summary.decision == null
      ? null : validTerminalDecision(summary.decision, summary);
    if (summary.decision != null && !initialDecision) {
      throw new Error('release decision mismatch');
    }
    let reviewState: CandidateReviewState = {
      bindingValid: false,
      interactiveReady: false,
      manualTakeover: false,
      approvalReady: false,
      terminal: null,
      error: null,
    };
    let updateControls = (): void => {};
    const mounted = mountPlayableCandidateReview(summary, (next) => {
      reviewState = next;
      updateControls();
    });
    status.remove();
    card.appendChild(mounted.element);

    const decisionPanel = document.createElement('section');
    decisionPanel.className = 'candidate-decision';
    decisionPanel.dataset.testid = 'candidate-decision-loop';
    const decisionHeading = document.createElement('strong');
    decisionHeading.textContent = 'Решение';
    const decisionStatus = document.createElement('p');
    decisionStatus.className = 'candidate-decision__status';
    decisionStatus.dataset.testid = 'candidate-decision-status';
    decisionStatus.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'candidate-decision__actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'lab-auth__button';
    accept.textContent = 'Принять в тестовую ленту';
    const rework = document.createElement('button');
    rework.type = 'button';
    rework.className = 'lab-auth__button lab-auth__button--danger';
    rework.textContent = 'Отправить на доработку';
    actions.append(accept, rework);
    const reworkForm = document.createElement('div');
    reworkForm.className = 'candidate-decision__rework';
    reworkForm.hidden = true;
    const reworkLabel = document.createElement('label');
    reworkLabel.textContent = 'Что именно доработать';
    const instruction = document.createElement('textarea');
    instruction.rows = 4;
    instruction.maxLength = 2_000;
    instruction.placeholder = 'Опишите одно конкретное изменение…';
    instruction.setAttribute('aria-label', 'Что именно доработать');
    reworkLabel.appendChild(instruction);
    const dictation = document.createElement('button');
    dictation.type = 'button';
    dictation.className = 'lab-auth__button lab-auth__button--quiet';
    dictation.textContent = 'Диктовать системной клавиатурой';
    const dictationHint = document.createElement('small');
    dictationHint.textContent = 'Используйте микрофон системной клавиатуры — голосовые файлы не загружаются.';
    const cancelRework = document.createElement('button');
    cancelRework.type = 'button';
    cancelRework.className = 'lab-auth__button lab-auth__button--quiet';
    cancelRework.textContent = 'Отменить ввод';
    reworkForm.append(reworkLabel, dictation, dictationHint, cancelRework);
    decisionPanel.append(decisionHeading, decisionStatus, actions, reworkForm);
    card.appendChild(decisionPanel);

    let terminalDecision = initialDecision;
    let pending = false;
    let formOpen = false;
    const mutationIds: Partial<Record<'accept' | 'rework', string>> = {};
    const cleanInstruction = (): string | null => {
      const value = instruction.value.trim();
      return printable(value) ? value : null;
    };
    const renderTerminal = (receipt: PlayableReleaseDecisionReceipt): void => {
      terminalDecision = receipt;
      decisionPanel.dataset.state = receipt.decision;
      if (receipt.decision === 'accept') {
        decisionStatus.textContent = receipt.authorization.state === 'approved'
          ? 'Кандидат принят в dev-ленту; дополнительный код не требуется. Public rollout не выполнялся.'
          : 'Кандидат принят в dev-ленту; старый одноразовый код остаётся совместимым на время обновления. Public rollout не выполнялся.';
      } else {
        decisionStatus.textContent = `Отправлено на доработку. Successor cycle ${receipt.successor?.cycle} создан; production не изменён.`;
        instruction.value = receipt.instruction ?? '';
        formOpen = true;
        reworkForm.hidden = false;
      }
    };
    updateControls = (): void => {
      const terminal = terminalDecision !== null;
      accept.disabled = pending || terminal || formOpen || !reviewState.approvalReady;
      rework.disabled = pending || terminal || !reviewState.bindingValid
        || Boolean(reviewState.error) || (formOpen && cleanInstruction() === null);
      instruction.disabled = pending || terminal;
      dictation.disabled = pending || terminal;
      cancelRework.disabled = pending || terminal;
      if (!terminal && !pending) {
        decisionStatus.textContent = reviewState.error
          ?? (reviewState.approvalReady
            ? 'Выберите один исход для exact candidate.'
            : 'Сначала откройте ручной режим candidate. Доработку можно описать после проверки binding.');
      }
    };
    const reconcile = async (): Promise<PlayableReleaseDecisionReceipt | null> => {
      try {
        const refreshed = await apiPlayableReleaseReview(releaseId);
        if (refreshed.publishId.toLowerCase() !== releaseId.toLowerCase()
          || refreshed.decision == null) return null;
        return validTerminalDecision(refreshed.decision, summary);
      } catch {
        return null;
      }
    };
    const submitDecision = async (decision: 'accept' | 'rework'): Promise<void> => {
      if (pending || terminalDecision) return;
      const text = decision === 'rework' ? cleanInstruction() : null;
      if (decision === 'rework' && text === null) return;
      mutationIds[decision] ??= crypto.randomUUID();
      pending = true;
      decisionStatus.textContent = decision === 'accept'
        ? 'Фиксируем принятие в dev-ленту…'
        : 'Фиксируем server-owned successor request…';
      updateControls();
      try {
        const receipt = await apiPlayableReleaseDecision(releaseId, {
          schema: 'feed.playable-release-decision.v1',
          mutationId: mutationIds[decision] as string,
          decision,
          ...(text === null ? {} : { instruction: text }),
        });
        const verified = validTerminalDecision(receipt, summary);
        if (!verified) throw new Error('decision receipt mismatch');
        renderTerminal(verified);
      } catch {
        const reconciled = await reconcile();
        if (reconciled) renderTerminal(reconciled);
        else decisionStatus.textContent = 'Решение не подтверждено. Production не изменён; повторите тот же исход.';
      } finally {
        pending = false;
        updateControls();
      }
    };
    accept.addEventListener('click', () => { void submitDecision('accept'); });
    rework.addEventListener('click', () => {
      if (!formOpen) {
        formOpen = true;
        reworkForm.hidden = false;
        instruction.focus();
        updateControls();
        return;
      }
      void submitDecision('rework');
    });
    instruction.addEventListener('input', updateControls);
    dictation.addEventListener('click', () => {
      instruction.focus();
      instruction.setSelectionRange(instruction.value.length, instruction.value.length);
    });
    cancelRework.addEventListener('click', () => {
      if (pending || terminalDecision) return;
      formOpen = false;
      reworkForm.hidden = true;
      updateControls();
      accept.focus();
    });
    if (initialDecision) renderTerminal(initialDecision);
    updateControls();
  } catch {
    status.textContent = 'Исходная задача недоступна или release больше нельзя проверить.';
  }
}
