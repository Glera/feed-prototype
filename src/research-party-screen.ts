import { ApiRequestError, apiResearchPartyChoice, apiResearchPartyResult } from './api';
import { getInitData } from './telegram';
import {
  researchCanonicalJson, researchPendingKey, researchSourceUrl,
  validateResearchChoiceCommand, validateResearchChoiceResponse, validateResearchResult,
  type ResearchChoiceCommand, type ResearchResult,
} from './research-party.mjs';

const SOURCE_LABELS: Record<string, string> = {
  'poki-charts': 'Poki', 'crazygames-charts': 'CrazyGames',
  'meta-ad-library': 'Meta Ad Library', 'tiktok-creative-center': 'TikTok Creative Center',
};
const DEFINITE_CHOICE_CONFLICTS = new Set([
  'research_choice_path_mismatch', 'research_result_not_ready', 'research_choice_collision',
  'research_choice_stale', 'research_choice_unknown_candidate', 'research_choice_already_recorded',
]);
// Signed bytes are sent only by api.ts. This local ID check is isolation, not auth.
function currentActor(): string | null {
  try {
    const raw = new URLSearchParams(getInitData() || '').get('user');
    const id: unknown = raw ? JSON.parse(raw).id : null;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  } catch { return null; }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', copy = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = copy;
  return element;
}
function setCopy(element: HTMLElement, copy: string): void {
  if (element.textContent !== copy) element.textContent = copy;
}
function button(copy: string): HTMLButtonElement {
  const element = node('button', 'lab-auth__button lab-auth__button--quiet', copy);
  element.type = 'button';
  return element;
}

export async function mountResearchParty(requestId: string | null): Promise<void> {
  document.body.classList.add('lab-auth-open', 'research-party-open');
  const root = node('main', 'lab-auth research-party');
  root.setAttribute('aria-label', 'Результаты Research');
  const shell = node('div', 'lab-auth__shell');
  const header = node('header', 'lab-auth__header');
  const heading = node('h1', 'research-party__heading', 'Результаты Research');
  const close = button('Закрыть');
  close.addEventListener('click', () => {
    const telegram = (window as any).Telegram?.WebApp;
    if (typeof telegram?.close === 'function') { telegram.close(); return; }
    const url = new URL(location.href);
    if (url.searchParams.has('researchParty')) {
      url.searchParams.delete('researchParty');
      location.replace(url.href);
      return;
    }
    location.replace('/');
  });
  header.append(heading, close);
  const status = node('p', 'research-party__status', 'Загружаем результаты…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const intro = node('p', 'research-party__intro');
  const cards = node('div', 'research-party__cards');
  const refreshButton = button('Обновить');
  refreshButton.dataset.testid = 'research-refresh';
  shell.append(header, status, intro, cards, refreshButton);
  root.append(shell);
  document.body.append(root);
  if (requestId === null) {
    setCopy(status, 'Ссылка на Research недействительна. Откройте ссылку результата из Telegram.');
    refreshButton.hidden = true;
    return;
  }
  const identity = requestId;
  let result: ResearchResult | null = null;
  let pending: ResearchChoiceCommand | null = null;
  let storageBlocked = false;
  let busy = false;
  let reading = false;
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let renderedHash: string | null = null;
  let renderedActor: string | null = null;
  let automaticReads = 0;
  let rejectedCopy = '';
  const controls = new Map<string, { status: HTMLElement; select: HTMLButtonElement; reject: HTMLButtonElement }>();

  function clearPrivate(): void {
    result = null; pending = null; renderedHash = null; renderedActor = null; rejectedCopy = '';
    controls.clear(); cards.replaceChildren(); setCopy(intro, '');
  }
  function removePending(actor: string): void {
    try { sessionStorage.removeItem(researchPendingKey(actor, identity)); }
    catch { /* The durable receipt is authority; stale local bytes will reconcile next time. */ }
    pending = null;
  }
  function restorePending(next: ResearchResult): void {
    pending = null; storageBlocked = false;
    if (!next.shortlist) return;
    let raw: string | null;
    try { raw = sessionStorage.getItem(researchPendingKey(next.actorUserId, identity)); }
    catch { storageBlocked = true; return; }
    if (!raw) return;
    try {
      if (raw.length > 16_384) throw new Error('pending too large');
      const record = JSON.parse(raw);
      if (researchCanonicalJson(Object.keys(record).sort()) !== researchCanonicalJson(['actorUserId', 'command', 'schema'])
        || record.schema !== 'research.party-choice-pending.v1' || record.actorUserId !== next.actorUserId) {
        throw new Error('pending identity mismatch');
      }
      pending = validateResearchChoiceCommand(record.command, next.shortlist);
      // Any verified immutable outcome for this candidate settles the uncertainty,
      // including a competing device's choice. Never resend our old command.
      if (next.choices.some((choice) => choice.command.candidateId === pending?.candidateId)) removePending(next.actorUserId);
    } catch { storageBlocked = true; }
  }
  function render(next: ResearchResult): void {
    const terminal = next.intake.terminal;
    if (!next.shortlist) {
      cards.replaceChildren(); controls.clear(); renderedHash = null; renderedActor = next.actorUserId;
      setCopy(heading, terminal?.status === 'NEEDS_HELP' ? 'Research требует внимания' : 'Результаты Research');
      setCopy(intro, terminal?.status === 'NEEDS_HELP' ? terminal.blocker?.safeSummary || 'Результат пока недоступен.'
        : terminal?.status === 'READY' ? 'Сохранённый результат получен, но списка для выбора в нём нет. Выбор пока недоступен.'
          : 'Партия ещё готовится. Здесь появятся кандидаты, когда результат будет готов.');
      setCopy(status, terminal?.status === 'NEEDS_HELP' ? 'Нужна помощь'
        : terminal?.status === 'READY' ? 'Готово · без доступного списка кандидатов' : 'В работе');
      return;
    }
    const shortlist = next.shortlist;
    setCopy(heading, 'Выберите интересные идеи');
    setCopy(intro, `${shortlist.candidates.length} кандидатов. Выбор сохраняет ваше решение, но не запускает разработку и ничего не публикует.`);
    if (renderedHash !== shortlist.shortlistHash || renderedActor !== next.actorUserId) {
      cards.replaceChildren(); controls.clear();
      renderedHash = shortlist.shortlistHash; renderedActor = next.actorUserId;
      for (const candidate of shortlist.candidates) {
        const card = node('article', 'lab-auth__card research-party__card');
        card.dataset.candidateId = candidate.candidateId;
        const title = node('h2', 'research-party__title', candidate.title);
        const summary = node('p', 'research-party__summary', candidate.summary);
        const observation = candidate.primaryObservation;
        const details = node('p', 'research-party__source',
          `${SOURCE_LABELS[observation.sourceId]} · ${new Date(observation.observedAt).toLocaleString('ru-RU')} · ${observation.region}`);
        const signal = node('p', 'research-party__signal', observation.signal);
        const source = node('a', 'research-party__link', 'Посмотреть источник');
        source.href = researchSourceUrl(observation.sourceId, observation.sourceUrl)!;
        source.target = '_blank'; source.rel = 'noopener noreferrer';
        const choiceStatus = node('p', 'research-party__choice-status', 'Решение не выбрано');
        const actions = node('div', 'research-party__actions');
        const select = button('Выбрать'); select.classList.add('lab-auth__button--approve');
        const reject = button('Отклонить');
        select.addEventListener('click', () => { void choose(candidate.candidateId, 'select'); });
        reject.addEventListener('click', () => { void choose(candidate.candidateId, 'reject'); });
        actions.append(select, reject);
        card.append(title, summary, details, signal, source, choiceStatus, actions);
        cards.append(card); controls.set(candidate.candidateId, { status: choiceStatus, select, reject });
      }
    }
    for (const [candidateId, control] of controls) {
      const choice = next.choices.find((item) => item.command.candidateId === candidateId);
      setCopy(control.status, choice ? choice.command.action === 'select' ? 'Выбрано' : 'Отклонено'
        : pending?.candidateId === candidateId ? 'Сохранение решения не подтверждено' : 'Решение не выбрано');
      control.select.disabled = Boolean(choice) || busy || pending !== null || storageBlocked;
      control.reject.disabled = control.select.disabled;
    }
    setCopy(status, storageBlocked ? 'Не удалось безопасно восстановить выбор. Новые решения не отправляются.'
      : pending ? 'Решение пока не подтверждено. Проверяем сохранённый результат; повторной отправки нет.'
        : busy ? 'Сохраняем решение…' : rejectedCopy || `Решений сохранено: ${next.choices.length} из ${shortlist.candidates.length}`);
  }

  async function refresh(manual = false): Promise<void> {
    if (disposed || reading || busy || document.hidden) return;
    const actor = currentActor();
    if (!actor) { clearPrivate(); setCopy(status, 'Откройте результат внутри Telegram под операторским аккаунтом.'); return; }
    if (result && result.actorUserId !== actor) clearPrivate();
    reading = true;
    const epoch = ++generation;
    controller = new AbortController();
    const readController = controller;
    const timeout = window.setTimeout(() => readController.abort(), 12_000);
    if (manual) { automaticReads = 0; setCopy(status, 'Проверяем сохранённый результат…'); }
    try {
      const next = await validateResearchResult(await apiResearchPartyResult(identity, controller.signal), identity);
      if (disposed || generation !== epoch) return;
      if (currentActor() !== actor || next.actorUserId !== actor) throw new Error('research_actor_changed');
      result = next;
      restorePending(next);
      render(next);
    } catch (error) {
      if (disposed || generation !== epoch) return;
      // No stale private content, pending command or former account's choices is
      // shown after an unconfirmed read, not even a successful-looking old card.
      clearPrivate();
      setCopy(status, error instanceof ApiRequestError && [401, 403, 404].includes(error.status)
        ? 'Результат недоступен этому аккаунту. Откройте ссылку заново в Telegram.'
        : 'Не удалось проверить результат. Обновите экран; решения автоматически не отправляются.');
    } finally {
      window.clearTimeout(timeout);
      if (generation === epoch) reading = false;
    }
  }

  async function choose(candidateId: string, action: 'select' | 'reject'): Promise<void> {
    const snapshot = result;
    if (!snapshot?.shortlist || busy || pending || storageBlocked || disposed
      || snapshot.choices.some((choice) => choice.command.candidateId === candidateId)) return;
    if (currentActor() !== snapshot.actorUserId) { clearPrivate(); await refresh(); return; }
    const command = validateResearchChoiceCommand({
      schema: 'research.party-choice-command.v1', requestId: identity,
      requestHash: snapshot.intake.requestHash, shortlistHash: snapshot.shortlist.shortlistHash,
      mutationId: crypto.randomUUID(), candidateId, action,
    }, snapshot.shortlist);
    const record = JSON.stringify({ schema: 'research.party-choice-pending.v1', actorUserId: snapshot.actorUserId, command });
    try {
      const key = researchPendingKey(snapshot.actorUserId, identity);
      sessionStorage.setItem(key, record);
      if (sessionStorage.getItem(key) !== record) throw new Error('pending not saved');
    } catch {
      storageBlocked = true; render(snapshot);
      setCopy(status, 'Браузер не сохранил выбор для восстановления. Решение не отправлено.');
      return;
    }
    controller?.abort(); reading = false;
    const epoch = ++generation;
    pending = command; busy = true; rejectedCopy = ''; render(snapshot);
    let reconcileRejected = false;
    try {
      const raw = await apiResearchPartyChoice(identity, command);
      const saved = await validateResearchChoiceResponse(raw, snapshot, command);
      if (disposed || epoch !== generation) return;
      if (currentActor() !== snapshot.actorUserId) { clearPrivate(); return; }
      removePending(snapshot.actorUserId);
      result = { ...snapshot, choices: [...snapshot.choices, saved] };
    } catch (error) {
      if (disposed || epoch !== generation) return;
      if (currentActor() !== snapshot.actorUserId
        || error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
        clearPrivate();
        setCopy(status, 'Результат недоступен этому аккаунту. Решение не подтверждено.');
      } else if (error instanceof ApiRequestError
        && (error.status === 422 && error.code === 'invalid_research_choice'
          || error.status === 409 && DEFINITE_CHOICE_CONFLICTS.has(error.code || ''))) {
        // Only an explicit domain refusal proves this POST was not applied.
        // Generic proxy errors still fence the exact command as uncertain.
        removePending(snapshot.actorUserId);
        rejectedCopy = 'Это решение не сохранено: сервер отклонил запрос. Список проверен; можно выбрать доступное действие заново.';
        reconcileRejected = true;
      }
      // A sent but unconfirmed command stays in sessionStorage. GET, not a
      // second POST or a fresh mutation, is the only automatic recovery path.
    } finally {
      busy = false;
      if (!disposed && epoch === generation) {
        if (reconcileRejected) await refresh();
        else {
          if (result) render(result);
          if (pending) await refresh();
        }
      }
    }
  }

  refreshButton.addEventListener('click', () => { void refresh(true); });
  const pause = (): void => {
    ++generation; controller?.abort(); reading = false; clearPrivate();
    setCopy(status, 'Проверяем операторский доступ…');
  };
  const resume = (): void => { automaticReads = 0; void refresh(); };
  const visibility = (): void => { if (document.hidden) pause(); else resume(); };
  const timer = window.setInterval(() => {
    if (!document.hidden && automaticReads < 30) { automaticReads += 1; void refresh(); }
  }, 10_000);
  const cleanup = (): void => {
    disposed = true; ++generation; controller?.abort(); window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pause); window.removeEventListener('pageshow', resume);
    removal.disconnect();
  };
  const removal = new MutationObserver(() => { if (!root.isConnected) cleanup(); });
  removal.observe(document.body, { childList: true });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pause); window.addEventListener('pageshow', resume);
  await refresh();
}
