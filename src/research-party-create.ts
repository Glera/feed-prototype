import { ApiRequestError, apiResearchPhoneCapability, apiResearchPartyByMutation, apiResearchPartyCreate } from './api';
import { getInitData } from './telegram';
import { researchCanonicalJson, validateResearchIntakeResponse, type ResearchResult } from './research-party.mjs';
import { researchCreatePendingKey, researchCreateUrl, validateResearchIntakeCommand, validateResearchPhoneCapability,
  type ResearchIntakeCommand, type ResearchPhoneCapability } from './research-party-phone.mjs';

const DEFINITE_REFUSALS = new Set(['research_actor_not_initialized', 'research_source_attended_only',
  'research_daily_cap_stale', 'research_daily_cap_exceeded', 'research_mutation_collision']);
const currentActor = (): string | null => {
  try {
    const user = new URLSearchParams(getInitData() || '').get('user');
    const id = user ? JSON.parse(user).id : null;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  } catch { return null; }
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', copy = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = copy; return node;
}
function button(copy: string): HTMLButtonElement {
  const node = element('button', 'lab-auth__button lab-auth__button--quiet', copy); node.type = 'button'; return node;
}
function copy(node: HTMLElement, text: string): void { if (node.textContent !== text) node.textContent = text; }

/** Optional LAB card. Failure never disables or steals focus from device auth. */
export async function mountResearchCreateEntry(host: HTMLElement): Promise<void> {
  host.hidden = true;
  const actor = currentActor(); if (!actor) return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const capability = validateResearchPhoneCapability(await apiResearchPhoneCapability(controller.signal));
    if (!host.isConnected || actor !== currentActor() || actor !== capability.actorUserId || !capability.capability.enabled) return;
    const title = element('h2', 'research-party__title', 'Research');
    const hint = element('p', 'research-party__summary', 'Собрать идеи и сигналы из доступных источников. Без публикации.');
    const open = button('Новая заявка Research');
    open.addEventListener('click', () => {
      if (currentActor() !== actor) { host.hidden = true; return; }
      location.assign(researchCreateUrl(location.href));
    });
    host.append(title, hint, open); host.hidden = false;
  } catch { /* Old/disabled backend or denied actor: no advertised capability. */ }
  finally { window.clearTimeout(timeout); }
}

export async function mountResearchPartyCreate(): Promise<void> {
  document.body.classList.add('lab-auth-open', 'research-party-open');
  const root = element('main', 'lab-auth research-party research-create');
  root.setAttribute('aria-label', 'Новая заявка Research');
  const shell = element('div', 'lab-auth__shell');
  const header = element('header', 'lab-auth__header');
  const close = button('Закрыть');
  close.addEventListener('click', () => {
    const telegram = (window as any).Telegram?.WebApp;
    if (typeof telegram?.close === 'function') { telegram.close(); return; }
    const url = new URL(location.href); url.searchParams.delete('researchParty'); location.replace(url.href);
  });
  header.append(element('h1', 'research-party__heading', 'Новая заявка Research'), close);
  const status = element('p', 'research-party__status', 'Проверяем доступ…');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const form = element('form', 'lab-auth__card research-create__form'); form.noValidate = true; form.hidden = true;
  const lens = element('fieldset', 'research-create__fieldset'); lens.append(element('legend', '', 'Что исследовать'));
  for (const [value, title, help] of [['R', 'R — Идеи и тренды', 'Поиск сигналов для радара'],
    ['D', 'D — Площадки для наших игр', 'Изучение возможных каналов распространения; ничего не публикуется']]) {
    const label = element('label', 'research-create__option'); const input = element('input');
    input.type = 'radio'; input.name = 'lens'; input.value = value;
    const body = element('span'); body.append(element('strong', '', title), element('small', '', help));
    label.append(input, body); lens.append(label);
  }
  const sources = element('fieldset', 'research-create__fieldset'); sources.append(element('legend', '', 'Источники'));
  for (const [value, title, available] of [['poki-charts', 'Poki', true], ['crazygames-charts', 'CrazyGames', true],
    ['meta-ad-library', 'Meta Ad Library', false], ['tiktok-creative-center', 'TikTok Creative Center', false]] as const) {
    const label = element('label', 'research-create__option'); const input = element('input');
    input.type = 'checkbox'; input.name = 'source'; input.value = value; input.disabled = !available;
    const body = element('span'); body.append(element('strong', '', title));
    if (!available) body.append(element('small', '', 'Недоступно для автоматической партии — требуется работа с участием человека.'));
    label.append(input, body); sources.append(label);
  }
  const budgetLabel = element('label', 'lab-auth__label', 'Лимит обращений к источникам');
  budgetLabel.htmlFor = 'research-call-budget';
  const budget = element('input', 'lab-auth__input'); budget.id = 'research-call-budget';
  budget.type = 'number'; budget.inputMode = 'numeric'; budget.min = '1'; budget.step = '1';
  const budgetHelp = element('p', 'research-party__source'); budgetHelp.id = 'research-budget-help';
  budget.setAttribute('aria-describedby', budgetHelp.id);
  const submit = button('Создать заявку'); submit.type = 'submit'; submit.disabled = true;
  form.append(lens, sources, budgetLabel, budget, budgetHelp, submit);
  const acceptedView = element('section', 'lab-auth__card'); acceptedView.hidden = true;
  const acceptedCopy = element('p', 'research-party__summary');
  const openResult = button('Открыть результат'); const another = button('Новая заявка');
  acceptedView.append(acceptedCopy, openResult, another);
  const refresh = button('Обновить');
  shell.append(header, status, form, acceptedView, refresh); root.append(shell); document.body.append(root);

  let capability: ResearchPhoneCapability | null = null;
  let pending: ResearchIntakeCommand | null = null;
  let accepted: ResearchResult['intake'] | null = null;
  let reading = false; let posting = false; let storageBlocked = false; let disposed = false;
  let generation = 0; let controller: AbortController | null = null;
  let draftActor: string | null = null;
  let refusal = '';
  const clearPrivate = (): void => {
    capability = null; pending = null; accepted = null; refusal = '';
    form.hidden = true; acceptedView.hidden = true;
  };
  function draft(mutationId: string): ResearchIntakeCommand {
    if (!capability || budget.value.trim() === '' || Number(budget.value) < 1) throw new Error('incomplete');
    return validateResearchIntakeCommand({ schema: 'research.party-intake.v1', mutationId,
      lens: form.querySelector<HTMLInputElement>('input[name="lens"]:checked')?.value,
      sourceIds: [...form.querySelectorAll<HTMLInputElement>('input[name="source"]:checked')].map((item) => item.value).sort(),
      callBudget: Number(budget.value), registryVersion: capability.capability.registryVersion,
      dailyCapIdentity: capability.capability.dailyCapIdentity }, capability);
  }
  function render(): void {
    form.hidden = !capability?.capability.enabled || pending !== null || storageBlocked;
    acceptedView.hidden = accepted === null;
    if (capability) {
      const max = Math.min(50, capability.capability.maxPartyCalls, capability.capability.remainingCalls);
      budget.max = String(max); budget.placeholder = max > 0 ? `1–${max}` : 'Лимит исчерпан';
      copy(budgetHelp, max === 0 ? 'Дневной лимит исчерпан. Сохранённые заявки по-прежнему можно открыть.'
        : `Доступно сегодня: ${capability.capability.remainingCalls} из 50 обращений. Это не число идей или карточек.`);
    }
    let valid = false;
    try { draft('00000000-0000-4000-8000-000000000001'); valid = true; } catch { /* explicit form is incomplete */ }
    submit.disabled = !valid || posting || reading || pending !== null || storageBlocked;
    copy(status, storageBlocked ? 'Браузер не может безопасно восстановить заявку. Новые заявки не отправляются.'
      : accepted ? 'Заявка сохранена'
        : pending ? posting ? 'Сохраняем заявку…' : 'Сохранение заявки пока не подтверждено. Проверка выполняется без повторной отправки.'
          : refusal || (capability?.capability.enabled
            ? capability.capability.remainingCalls === 0 ? 'Дневной лимит исчерпан.' : 'Выберите источники и лимит, затем создайте заявку.'
            : 'Research сейчас недоступен.'));
    if (accepted) copy(acceptedCopy, 'Заявка принята сервером. Это ещё не готовый Research; состояние и идеи доступны на экране результата.');
  }
  function loadPending(actor: string): void {
    pending = null; storageBlocked = false;
    try {
      const raw = sessionStorage.getItem(researchCreatePendingKey(actor)); if (!raw) return;
      if (raw.length > 16_384) throw new Error('record too large');
      const record = JSON.parse(raw);
      if (researchCanonicalJson(Object.keys(record).sort()) !== researchCanonicalJson(['actorUserId', 'command', 'schema'])
        || record.schema !== 'research.party-create-pending.v1' || record.actorUserId !== actor) throw new Error('owner mismatch');
      pending = validateResearchIntakeCommand(record.command);
    } catch { storageBlocked = true; }
  }
  async function readCurrent(): Promise<void> {
    if (disposed || reading || posting || document.hidden) return;
    const actor = currentActor();
    if (!actor) { clearPrivate(); copy(status, 'Откройте Research внутри Telegram под операторским аккаунтом.'); return; }
    if (draftActor !== actor) { form.reset(); draftActor = actor; }
    if (capability?.actorUserId !== actor) clearPrivate();
    reading = true; const epoch = ++generation; controller = new AbortController();
    const active = controller; const timeout = window.setTimeout(() => active.abort(), 12_000);
    submit.disabled = true;
    try {
      const next = validateResearchPhoneCapability(await apiResearchPhoneCapability(active.signal));
      if (disposed || epoch !== generation) return;
      if (actor !== currentActor() || next.actorUserId !== actor) throw new Error('actor changed');
      capability = next; accepted = null;
      if (!next.capability.enabled) { pending = null; render(); return; }
      loadPending(actor);
      if (pending) {
        try {
          const response = await apiResearchPartyByMutation(pending.mutationId, active.signal);
          const found = await validateResearchIntakeResponse(response, pending);
          if (disposed || epoch !== generation) return;
          if (actor !== currentActor()) throw new Error('actor changed');
          accepted = found;
        } catch (error) {
          if (!(error instanceof ApiRequestError && error.status === 404 && error.code === 'research_party_not_found')) throw error;
          // Not-found is not proof of rollback while a sent POST may still commit.
        }
        if (disposed || epoch !== generation) return;
        if (actor !== currentActor()) throw new Error('actor changed');
      }
    } catch (error) {
      if (disposed || epoch !== generation) return;
      clearPrivate();
      copy(status, error instanceof ApiRequestError && error.status === 409 && error.code === 'research_actor_not_initialized'
        ? 'Сначала откройте обычную ленту под этим Telegram-аккаунтом, затем вернитесь в Research.'
        : error instanceof ApiRequestError && [401, 403, 404].includes(error.status)
          ? 'Research недоступен этому аккаунту или ещё не включён.'
          : 'Не удалось проверить доступ или сохранённую заявку. Обновите экран; повторной отправки нет.');
      return;
    } finally {
      window.clearTimeout(timeout);
      if (epoch === generation) reading = false;
    }
    if (!disposed && epoch === generation) render();
  }
  form.addEventListener('input', () => { render(); });
  form.addEventListener('submit', (event) => { event.preventDefault(); void send(); });
  async function send(): Promise<void> {
    if (!capability?.capability.enabled || reading || posting || pending || storageBlocked || disposed) return;
    const actor = capability.actorUserId;
    if (actor !== currentActor()) { clearPrivate(); await readCurrent(); return; }
    let command: ResearchIntakeCommand;
    try { command = draft(crypto.randomUUID()); } catch { render(); return; }
    const record = JSON.stringify({ schema: 'research.party-create-pending.v1', actorUserId: actor, command });
    try {
      sessionStorage.setItem(researchCreatePendingKey(actor), record);
      if (sessionStorage.getItem(researchCreatePendingKey(actor)) !== record) throw new Error('not stored');
    } catch { storageBlocked = true; render(); copy(status, 'Браузер не сохранил заявку для восстановления. Запрос не отправлен.'); return; }
    pending = command; posting = true; refusal = ''; render();
    const epoch = ++generation;
    let recover = true;
    try {
      const saved = await validateResearchIntakeResponse(await apiResearchPartyCreate(command), command);
      if (disposed || epoch !== generation) return;
      if (actor !== currentActor()) { clearPrivate(); return; }
      accepted = saved;
    } catch (error) {
      if (disposed || epoch !== generation) return;
      if (actor !== currentActor() || error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
        recover = false; clearPrivate(); copy(status, 'Сохранение не подтверждено. Откройте Research заново под своим аккаунтом.');
      } else if (error instanceof ApiRequestError && (error.status === 422 && error.code === 'invalid_research_party_intake'
        || error.status === 409 && DEFINITE_REFUSALS.has(error.code || ''))) {
        try { sessionStorage.removeItem(researchCreatePendingKey(actor)); pending = null; }
        catch { storageBlocked = true; }
        refusal = error.code === 'research_actor_not_initialized'
          ? 'Сначала откройте обычную ленту под этим Telegram-аккаунтом, затем вернитесь в Research.'
          : 'Заявка не сохранена: сервер отклонил запрос. Проверьте актуальные источники и лимит перед новой попыткой.';
      }
    } finally {
      posting = false;
      if (!disposed && epoch === generation) {
        if (accepted) render();
        else if (recover) await readCurrent();
      } else if (!disposed && !document.hidden) {
        // BFCache/visibility may have cancelled our view while the POST was
        // still in flight. Restore through an owned GET, never resend it.
        await readCurrent();
      }
    }
  }
  another.addEventListener('click', async () => {
    if (!capability || !accepted || posting || reading || currentActor() !== capability.actorUserId) return;
    try { sessionStorage.removeItem(researchCreatePendingKey(capability.actorUserId)); }
    catch { storageBlocked = true; render(); return; }
    pending = null; accepted = null; refusal = ''; form.reset(); await readCurrent();
  });
  openResult.addEventListener('click', async () => {
    if (!accepted || !capability || currentActor() !== capability.actorUserId) return;
    const requestId = accepted.requestId;
    cleanup(); root.remove();
    const module = await import('./research-party-screen');
    await module.mountResearchParty(requestId);
  });
  refresh.addEventListener('click', () => { void readCurrent(); });
  const pause = (): void => { ++generation; controller?.abort(); reading = false; clearPrivate(); copy(status, 'Проверяем операторский доступ…'); };
  const resume = (): void => { void readCurrent(); };
  const visibility = (): void => { if (document.hidden) pause(); else resume(); };
  function cleanup(): void {
    disposed = true; ++generation; controller?.abort(); removal.disconnect();
    window.removeEventListener('pagehide', pause); window.removeEventListener('pageshow', resume);
    document.removeEventListener('visibilitychange', visibility);
  }
  const removal = new MutationObserver(() => { if (!root.isConnected && !disposed) cleanup(); });
  removal.observe(document.body, { childList: true });
  window.addEventListener('pagehide', pause); window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', visibility);
  await readCurrent();
}
