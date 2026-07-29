import {
  ApiRequestError,
  apiCatalogLabDecision,
  apiCatalogLabLookup,
  apiMobileReview,
  apiMobileReviewArtifact,
  apiMobileReviewDecision,
  apiMobileReviewInbox,
  type MobileReviewView,
} from './api';
import { showConfirm } from './telegram';

type MobileRuntime = NonNullable<MobileReviewView['bundle']['runtime']>;
type SortRuntime = Extract<MobileRuntime, { schema: 'operator.mobile-review-runtime.v1' }>;
type HtmlRuntime = Extract<MobileRuntime, { schema: 'operator.mobile-html-runtime.v1' }>;
type SortRuntimePreview = SortRuntime['previews'][number];
type HtmlRuntimePreview = HtmlRuntime['previews'][number];
type ConfiguredPreview = {
  reviewTargetId: string;
  runtimeArtifactDigest: string;
};

const FACTORY_CHECKS = [
  ['reproducibility', 'Повтор даёт те же результаты'],
  ['axisCoverage', 'Варианты действительно различаются'],
  ['yieldHonesty', 'Показаны все результаты без отбора'],
  ['sampleQuality', 'Качество примеров подходит'],
  ['campaignReuse', 'Генератор можно использовать снова'],
] as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(label: string, primary = false): HTMLButtonElement {
  const node = element('button', `mobile-review__button${primary ? ' mobile-review__button--primary' : ''}`, label);
  node.type = 'button';
  return node;
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = element('label', 'mobile-review__field');
  label.append(element('span', 'mobile-review__field-label', labelText), control);
  return label;
}

function select(options: Array<[string, string]>): HTMLSelectElement {
  const node = element('select', 'mobile-review__select');
  for (const [value, label] of options) {
    const option = element('option', '', label);
    option.value = value;
    node.append(option);
  }
  return node;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 0) return 'Нет связи с сервером. Решение не потеряно — попробуйте ещё раз.';
    if (error.status === 409) return 'Этот шаг уже изменился. Обновляю актуальный отсмотр.';
    if (error.status === 404) return 'Этот отсмотр больше не актуален.';
  }
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}

function technicalDetails(view: MobileReviewView): HTMLDetailsElement {
  const details = element('details', 'mobile-review__technical');
  const summary = element('summary', '', 'Технические детали');
  const pre = element('pre');
  pre.textContent = JSON.stringify({
    bundleId: view.bundle.bundleId,
    bundleDigest: view.bundle.bundleDigest,
    orderHash: view.bundle.order.orderHash,
    eventId: view.bundle.order.eventId,
    action: view.bundle.action,
    ...view.bundle.presentation.technicalDetails,
  }, null, 2);
  details.append(summary, pre);
  return details;
}

function draftKey(bundleId: string): string {
  return `mobile-review-draft:${bundleId}`;
}

function readDraft(bundleId: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(draftKey(bundleId)) || '{}');
  } catch {
    return {};
  }
}

function writeDraft(bundleId: string, value: Record<string, unknown>): void {
  try { localStorage.setItem(draftKey(bundleId), JSON.stringify(value)); } catch { /* memoryless fallback */ }
}

function patchDraft(bundleId: string, value: Record<string, unknown>): void {
  writeDraft(bundleId, { ...readDraft(bundleId), ...value });
}

function mutationFor(bundleId: string, decision: Record<string, unknown>): string {
  const key = `mobile-review-mutation:${bundleId}`;
  const bytes = JSON.stringify(decision);
  try {
    const prior = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (prior?.bytes === bytes && typeof prior?.mutationId === 'string') return prior.mutationId;
    const mutationId = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ bytes, mutationId }));
    return mutationId;
  } catch {
    return crypto.randomUUID();
  }
}

function sameDigest(left: string, right: string): boolean {
  return left.replace(/^sha256:/, '') === right.replace(/^sha256:/, '');
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hashed)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: {
    results: ArrayLike<{
      isFinal: boolean;
      0: { transcript: string };
    }>;
    resultIndex: number;
  }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function voiceField(
  labelText: string,
  control: HTMLTextAreaElement,
  onValue: () => void,
): HTMLElement {
  const wrapper = element('div', 'mobile-review__voice-field');
  const controls = element('div', 'mobile-review__voice-controls');
  const status = element('span', 'mobile-review__voice-status', 'Текст можно исправить перед отправкой.');
  const dictate = button('🎙 Надиктовать');
  let recognition: SpeechRecognitionLike | null = null;
  let listening = false;

  const Recognition = (
    window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }
  ).SpeechRecognition || (
    window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }
  ).webkitSpeechRecognition;

  dictate.addEventListener('click', () => {
    if (!Recognition) {
      control.focus();
      status.textContent = 'Используйте микрофон клавиатуры Telegram — надиктованный текст останется редактируемым.';
      return;
    }
    if (listening) {
      recognition?.stop();
      return;
    }
    recognition = new Recognition();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let addition = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (event.results[index].isFinal) addition += `${event.results[index][0].transcript} `;
      }
      const clean = addition.trim();
      if (!clean) return;
      const separator = control.value && !/\s$/.test(control.value) ? ' ' : '';
      control.value = `${control.value}${separator}${clean}`.slice(0, control.maxLength || 2000);
      control.dispatchEvent(new Event('input', { bubbles: true }));
      status.textContent = 'Текст распознан. Проверьте его перед отправкой.';
    };
    recognition.onerror = (event) => {
      status.textContent = event.error === 'not-allowed'
        ? 'Telegram не дал доступ к микрофону. Используйте микрофон клавиатуры.'
        : 'Диктовка прервалась. Уже распознанный текст сохранён.';
    };
    recognition.onend = () => {
      listening = false;
      dictate.textContent = '🎙 Надиктовать';
    };
    listening = true;
    dictate.textContent = '■ Остановить';
    status.textContent = 'Слушаю… после остановки текст можно исправить.';
    try {
      recognition.start();
    } catch {
      listening = false;
      dictate.textContent = '🎙 Надиктовать';
      status.textContent = 'Не удалось запустить диктовку. Используйте микрофон клавиатуры.';
    }
  });
  control.addEventListener('input', onValue);
  controls.append(dictate, status);
  wrapper.append(field(labelText, control), controls);
  return wrapper;
}

function mountRuntimePreview(
  parent: HTMLElement,
  runtime: MobileRuntime,
  onConfigured: (preview: ConfiguredPreview) => void,
): void {
  if (runtime.schema === 'operator.mobile-html-runtime.v1') {
    mountHtmlRuntimePreview(parent, runtime.previews, onConfigured);
    return;
  }
  const previews = runtime.previews;
  if (!previews.length) return;
  const shell = element('section', 'mobile-review__preview');
  const title = element('h2', '', 'Точный интерактивный preview');
  const status = element('p', 'mobile-review__status', 'Выберите пример для запуска.');
  const selector = element('div', 'mobile-review__preview-tabs');
  const stage = element('div', 'mobile-review__preview-stage');
  const levelNav = element('div', 'mobile-review__preview-levels');
  let frame: HTMLIFrameElement | null = null;
  let activePreview: SortRuntimePreview = previews[0];
  let levelIndex = 0;
  let epoch = 0;
  let cleanupMessage: (() => void) | null = null;
  const configuredLevels = new Set<number>();

  function stopFrame(): void {
    epoch += 1;
    cleanupMessage?.();
    cleanupMessage = null;
    frame?.remove();
    frame = null;
    stage.replaceChildren();
  }

  function renderLevelNav(): void {
    levelNav.replaceChildren();
    if (activePreview.levels.length <= 1) return;
    activePreview.levels.forEach((level, index) => {
      const item = button(`${configuredLevels.has(index) ? '✓ ' : ''}${level.ordinal}`);
      item.classList.toggle('is-active', index === levelIndex);
      item.addEventListener('click', () => {
        levelIndex = index;
        launch();
      });
      levelNav.append(item);
    });
  }

  function launch(): void {
    stopFrame();
    renderLevelNav();
    const currentEpoch = epoch;
    const level = activePreview.levels[levelIndex];
    status.textContent = `Загружаем ${activePreview.label}, уровень ${level.ordinal}…`;
    const next = document.createElement('iframe');
    next.className = 'mobile-review__frame';
    next.title = `${activePreview.label}, уровень ${level.ordinal}`;
    next.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
    next.setAttribute('allow', 'autoplay');
    frame = next;

    const timeout = window.setTimeout(() => {
      if (frame === next) status.textContent = 'Preview отвечает дольше 10 секунд. Можно перезапустить.';
    }, 10_000);
    const onMessage = (event: MessageEvent): void => {
      if (currentEpoch !== epoch || event.source !== next.contentWindow
        || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'configure_ready') {
        if (!sameDigest(String(event.data.runtimeContractDigest || ''), activePreview.runtimeContractDigest)
          || !sameDigest(String(event.data.runtimeArtifactDigest || ''), activePreview.runtimeArtifactDigest)) {
          status.textContent = 'Runtime не совпал с проверяемой версией.';
          return;
        }
        next.contentWindow?.postMessage({
          type: 'configure_level',
          nonce: event.data.nonce,
          spec: level.spec,
          ...(activePreview.skin ? { skin: activePreview.skin } : {}),
        }, location.origin);
      } else if (event.data.type === 'configured') {
        if (event.data.appliedSpecHash !== level.specHash) {
          status.textContent = 'Runtime применил другой LevelSpec.';
          return;
        }
        configuredLevels.add(levelIndex);
        renderLevelNav();
        if (configuredLevels.size === activePreview.levels.length) {
          status.textContent = 'Exact preview подтверждён для всех уровней.';
          onConfigured({
            reviewTargetId: activePreview.reviewTargetId,
            runtimeArtifactDigest: activePreview.runtimeArtifactDigest,
          });
        } else {
          status.textContent = 'Уровень подтверждён. Откройте следующий.';
        }
      } else if (event.data.type === 'configure_failed') {
        status.textContent = `Preview не собран: ${String(event.data.reason || 'unknown')}`;
      }
    };
    window.addEventListener('message', onMessage);
    cleanupMessage = () => window.removeEventListener('message', onMessage);
    next.src = `./marble-sort-swipe.html?hostPaused=0&mobileReview=1&cb=${encodeURIComponent(activePreview.runtimeArtifactDigest)}`;
    stage.append(next);
    next.addEventListener('load', () => {
      window.clearTimeout(timeout);
      status.textContent = 'Проверяем exact-конфигурацию…';
    }, { once: true });
  }

  for (const preview of previews) {
    const item = button(preview.label);
    item.addEventListener('click', () => {
      activePreview = preview;
      levelIndex = 0;
      configuredLevels.clear();
      [...selector.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      launch();
    });
    selector.append(item);
  }
  const first = selector.firstElementChild as HTMLElement | null;
  first?.classList.add('is-active');
  shell.append(title, selector, levelNav, status, stage);
  parent.append(shell);
  launch();
}

function mountHtmlRuntimePreview(
  parent: HTMLElement,
  previews: HtmlRuntimePreview[],
  onConfigured: (preview: ConfiguredPreview) => void,
): void {
  if (!previews.length) return;
  const shell = element('section', 'mobile-review__preview');
  const title = element('h2', '', 'Точный интерактивный preview');
  const status = element('p', 'mobile-review__status', 'Выберите прототип для запуска.');
  const selector = element('div', 'mobile-review__preview-tabs');
  const stage = element('div', 'mobile-review__preview-stage');
  let epoch = 0;
  let artifactUrl: string | null = null;

  const stop = (): void => {
    epoch += 1;
    stage.replaceChildren();
    if (artifactUrl) URL.revokeObjectURL(artifactUrl);
    artifactUrl = null;
  };

  const launch = async (preview: HtmlRuntimePreview): Promise<void> => {
    stop();
    const currentEpoch = epoch;
    status.textContent = `Загружаем ${preview.label}…`;
    try {
      const artifact = await apiMobileReviewArtifact(preview.artifactDigest);
      if (currentEpoch !== epoch) return;
      if (artifact.bytes.byteLength !== preview.byteLength) {
        throw new Error('Размер exact-прототипа не совпал.');
      }
      const actual = `sha256:${await sha256Hex(artifact.bytes)}`;
      if (currentEpoch !== epoch) return;
      if (actual !== preview.artifactDigest || artifact.artifactDigest !== actual) {
        throw new Error('SHA-256 exact-прототипа не совпал.');
      }
      const exactHtml = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
      // Blob responses do not inherit the backend response CSP. Prefix a
      // deterministic policy only after the raw bytes passed SHA-256; this keeps
      // the reviewed artifact identity exact while executing a network-isolated
      // projection of it on the phone.
      const csp = [
        "default-src 'none'",
        "script-src 'unsafe-inline' blob:",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'media-src data: blob:',
        'font-src data:',
        "connect-src 'none'",
        'worker-src blob:',
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      const hardenedHtml = `<meta http-equiv="Content-Security-Policy" content="${csp}">${exactHtml}`;
      artifactUrl = URL.createObjectURL(new Blob([hardenedHtml], { type: 'text/html' }));
      const frame = document.createElement('iframe');
      frame.className = 'mobile-review__frame mobile-review__frame--prototype';
      frame.title = preview.label;
      frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      frame.setAttribute('allow', 'autoplay');
      frame.src = artifactUrl;
      frame.addEventListener('load', () => {
        if (currentEpoch !== epoch) return;
        status.textContent = 'Exact-прототип загружен. Поиграйте и сохраните решение ниже.';
        onConfigured({
          reviewTargetId: preview.reviewTargetId,
          runtimeArtifactDigest: preview.artifactDigest,
        });
      }, { once: true });
      stage.append(frame);
    } catch (error) {
      if (currentEpoch === epoch) status.textContent = errorMessage(error);
    }
  };

  for (const preview of previews) {
    const item = button(preview.label);
    item.addEventListener('click', () => {
      [...selector.children].forEach((child) => child.classList.remove('is-active'));
      item.classList.add('is-active');
      void launch(preview);
    });
    selector.append(item);
  }
  selector.firstElementChild?.classList.add('is-active');
  shell.append(title, selector, status, stage);
  parent.append(shell);
  void launch(previews[0]);
}

export async function mountMobileReview(initialBundleId: string | null): Promise<void> {
  document.body.classList.add('mobile-review-open');
  const root = element('main', 'mobile-review');
  root.setAttribute('aria-label', 'Отсмотр заказа');
  document.body.replaceChildren(root);

  let current: MobileReviewView | null = null;
  let configuredPreview: ConfiguredPreview | null = null;
  let startedAt = Date.now();
  let followEpoch = 0;

  async function submit(decision: Record<string, unknown>): Promise<void> {
    if (!current) return;
    const submitters = [...root.querySelectorAll<HTMLButtonElement>('button')];
    submitters.forEach((node) => { node.disabled = true; });
    const notice = root.querySelector<HTMLElement>('[data-mobile-review-notice]');
    if (notice) notice.textContent = 'Сохраняем решение… повторно нажимать не нужно.';
    try {
      const command = {
        schema: 'operator.mobile-review-decision-command.v1',
        bundleId: current.bundle.bundleId,
        bundleDigest: current.bundle.bundleDigest,
        actionIdentity: current.bundle.action.identity,
        mutationId: mutationFor(current.bundle.bundleId, decision),
        decision,
      };
      current = await apiMobileReviewDecision(current.bundle.bundleId, command);
      try { localStorage.removeItem(draftKey(current.bundle.bundleId)); } catch { /* no-op */ }
      renderDone();
    } catch (error) {
      if (notice) notice.textContent = errorMessage(error);
      submitters.forEach((node) => { node.disabled = false; });
    }
  }

  function heading(view: MobileReviewView): HTMLElement {
    const header = element('header', 'mobile-review__header');
    const brand = element('span', 'mobile-review__brand', 'P4G · REVIEW');
    const progress = element(
      'span',
      'mobile-review__progress',
      view.bundle.action.sequence.total > 1
        ? `${view.bundle.action.sequence.completed + 1}/${view.bundle.action.sequence.total}`
        : 'Нужен ваш выбор',
    );
    const title = element('h1', '', view.bundle.order.title);
    const brief = element('p', 'mobile-review__brief', view.bundle.order.brief || 'Описание заказа не добавлено.');
    const action = element('div', 'mobile-review__action');
    action.append(
      element('span', 'mobile-review__eyebrow', 'Сейчас от вас'),
      element('strong', '', view.bundle.action.label),
      element('p', '', view.bundle.presentation.summary),
    );
    header.append(brand, progress, title, brief, action);
    return header;
  }

  function renderDone(): void {
    if (!current) return;
    const completed = current;
    const epoch = ++followEpoch;
    root.replaceChildren(heading(current));
    const card = element('section', 'mobile-review__card mobile-review__success');
    const status = element(
      'p',
      'mobile-review__status',
      'Система продолжает заказ. Следующий обязательный шаг откроется здесь автоматически.',
    );
    card.append(
      element('h2', '', 'Решение сохранено'),
      status,
    );
    const next = button('Проверить следующие шаги', true);
    next.addEventListener('click', () => {
      followEpoch += 1;
      void loadInbox();
    });
    card.append(next);
    root.append(card, technicalDetails(current));

    void (async () => {
      const deadline = Date.now() + 90_000;
      while (epoch === followEpoch && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        try {
          const reviews = await apiMobileReviewInbox();
          if (epoch !== followEpoch) return;
          const following = reviews.find((item) => (
            item.bundle.order.orderId === completed.bundle.order.orderId
            && item.bundle.bundleId !== completed.bundle.bundleId
          )) || reviews.find((item) => item.bundle.bundleId !== completed.bundle.bundleId);
          if (following) {
            followEpoch += 1;
            renderView(following);
            return;
          }
          status.textContent = 'Технические шаги выполняются. Окно можно закрыть — следующий отсмотр останется во входящих.';
        } catch {
          status.textContent = 'Ждём следующий шаг. Связь временно недоступна; можно закрыть окно и открыть сообщение позже.';
        }
      }
      if (epoch === followEpoch) {
        status.textContent = 'Следующего обязательного шага пока нет. Заказ продолжится в фоне; можно закрыть окно.';
      }
    })();
  }

  function renderFactory(view: MobileReviewView, body: HTMLElement): void {
    const proof = view.bundle.review.proof || {};
    body.append(element('p', '', `Технический yield: ${proof.projection?.metrics?.successes || 0}/${proof.projection?.metrics?.attemptsTotal || 0}`));
    const form = element('div', 'mobile-review__form');
    const draft = readDraft(view.bundle.bundleId);
    for (const [key, labelText] of FACTORY_CHECKS) {
      const label = element('label', 'mobile-review__check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = key;
      input.checked = Boolean((draft.assessment as Record<string, boolean> | undefined)?.[key]);
      label.append(input, document.createTextNode(labelText));
      form.append(label);
    }
    const instruction = element('textarea', 'mobile-review__textarea') as HTMLTextAreaElement;
    instruction.maxLength = 2000;
    instruction.placeholder = 'Что нужно изменить (для доработки или закрытия)';
    instruction.value = String(draft.instruction || '');
    form.append(voiceField('Комментарий', instruction, () => {
      patchDraft(view.bundle.bundleId, { instruction: instruction.value });
    }));
    const actions = element('div', 'mobile-review__actions');
    for (const [verdict, labelText, primary] of [
      ['good', 'Фабрика подходит', true],
      ['rework', 'Вернуть на доработку', false],
      ['retired', 'Закрыть фабрику', false],
    ] as const) {
      const action = button(labelText, primary);
      action.addEventListener('click', () => {
        const assessment = Object.fromEntries(FACTORY_CHECKS.map(([key]) => [
          key,
          (form.querySelector(`[name="${key}"]`) as HTMLInputElement).checked ? 'pass' : 'fail',
        ]));
        const text = instruction.value.trim();
        writeDraft(view.bundle.bundleId, {
          assessment: Object.fromEntries(FACTORY_CHECKS.map(([key]) => [
            key,
            (form.querySelector(`[name="${key}"]`) as HTMLInputElement).checked,
          ])),
          instruction: instruction.value,
        });
        if (verdict === 'good' && Object.values(assessment).some((value) => value !== 'pass')) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Для допуска подтвердите все пять пунктов.';
          return;
        }
        if (verdict !== 'good' && !text) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Опишите причину решения.';
          return;
        }
        void submit({
          schema: 'operator.mobile-factory-review-decision.v1',
          assessment,
          verdict,
          instruction: verdict === 'good' ? null : text,
        });
      });
      actions.append(action);
    }
    form.append(actions);
    body.append(form);
  }

  function renderSettingSelection(view: MobileReviewView, body: HTMLElement): void {
    const form = element('div', 'mobile-review__form');
    const candidates = Array.isArray(view.bundle.review.candidates)
      ? view.bundle.review.candidates : [];
    let selected = String(readDraft(view.bundle.bundleId).reviewTargetId || '');
    for (const candidate of candidates) {
      const card = element('label', 'mobile-review__candidate');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'setting';
      radio.value = candidate.reviewTargetId;
      radio.checked = selected === radio.value;
      radio.addEventListener('change', () => {
        selected = radio.value;
        patchDraft(view.bundle.bundleId, { reviewTargetId: selected });
      });
      card.append(
        radio,
        element('strong', '', candidate.output?.title || candidate.output?.feeling || 'Вариант мира'),
        element('p', '', candidate.output?.brief || candidate.output?.pitch || ''),
      );
      form.append(card);
    }
    const action = button('Выбрать этот мир', true);
    action.addEventListener('click', () => {
      if (!selected) {
        body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Сначала выберите один вариант.';
        return;
      }
      void submit({
        schema: 'operator.mobile-setting-selection-decision.v1',
        reviewTargetId: selected,
      });
    });
    form.append(action);
    body.append(form);
  }

  function renderTaste(view: MobileReviewView, body: HTMLElement): void {
    const form = element('div', 'mobile-review__form');
    const draft = readDraft(view.bundle.bundleId);
    const comment = element('textarea', 'mobile-review__textarea') as HTMLTextAreaElement;
    comment.maxLength = 2000;
    comment.placeholder = 'Что заметили?';
    comment.value = String(draft.comment || '');
    const interesting = select([['unknown', 'Не оценено'], ['yes', 'Интересно'], ['no', 'Неинтересно']]);
    const similar = select([['unknown', 'Не оценено'], ['no', 'Достаточно ново'], ['yes', 'Слишком похоже']]);
    const payoff = select([['unknown', 'Не оценено'], ['good', 'Хороший payoff'], ['weak', 'Слабый payoff']]);
    interesting.value = String((draft.taste as any)?.interesting || 'unknown');
    similar.value = String((draft.taste as any)?.too_similar || 'unknown');
    payoff.value = String((draft.taste as any)?.payoff_quality || 'unknown');
    form.append(
      voiceField('Комментарий', comment, () => {
        patchDraft(view.bundle.bundleId, { comment: comment.value });
      }),
      field('Интерес', interesting),
      field('Новизна', similar),
      field('Payoff', payoff),
    );
    const persistTaste = (): void => {
      patchDraft(view.bundle.bundleId, {
        taste: {
          interesting: interesting.value,
          too_similar: similar.value,
          payoff_quality: payoff.value,
        },
      });
    };
    interesting.addEventListener('change', persistTaste);
    similar.addEventListener('change', persistTaste);
    payoff.addEventListener('change', persistTaste);

    let seriesAssessment: Record<string, HTMLSelectElement> | null = null;
    if (view.bundle.action.kind === 'series_review') {
      const choices: Array<[string, string]> = [
        ['unknown', 'Не оценено'],
        ['strong', 'Сильный'],
        ['acceptable', 'Приемлемый'],
        ['weak', 'Слабый'],
      ];
      seriesAssessment = {
        pacing: select(choices),
        difficulty_progression: select([
          ['unknown', 'Не оценено'], ['smooth', 'Плавная'], ['uneven', 'Неровная'], ['wrong_order', 'Неверный порядок'],
        ]),
        redundancy: select([
          ['unknown', 'Не оценено'], ['low', 'Низкая'], ['moderate', 'Средняя'], ['high', 'Высокая'],
        ]),
        cohesion: select(choices),
      };
      const prior = (draft.seriesAssessment || {}) as Record<string, string>;
      for (const [key, node] of Object.entries(seriesAssessment)) {
        node.value = prior[key] || 'unknown';
        node.addEventListener('change', () => {
          patchDraft(view.bundle.bundleId, {
            seriesAssessment: Object.fromEntries(
              Object.entries(seriesAssessment || {}).map(
                ([assessmentKey, assessmentNode]) => [assessmentKey, assessmentNode.value],
              ),
            ),
          });
        });
      }
      form.append(
        field('Темп серии', seriesAssessment.pacing),
        field('Рост сложности', seriesAssessment.difficulty_progression),
        field('Повторы', seriesAssessment.redundancy),
        field('Цельность', seriesAssessment.cohesion),
      );
    }

    const overrideLabel = element('label', 'mobile-review__check');
    const override = document.createElement('input');
    override.type = 'checkbox';
    override.checked = Boolean(draft.seriesCompletionOverride);
    override.addEventListener('change', () => {
      patchDraft(view.bundle.bundleId, { seriesCompletionOverride: override.checked });
    });
    overrideLabel.append(override, document.createTextNode('Одобрить на свой риск без полного прохождения серии'));
    if (view.bundle.action.kind === 'series_review') form.append(overrideLabel);

    const rework = element('textarea', 'mobile-review__textarea') as HTMLTextAreaElement;
    rework.maxLength = 2000;
    rework.placeholder = 'Что именно доработать';
    rework.value = String(draft.reworkInstruction || '');
    const reworkAvailable = view.bundle.review.rework?.mode === 'server_recommended';
    if (['level_review', 'experiment_review'].includes(view.bundle.action.kind)) {
      form.append(voiceField('Инструкция для доработки', rework, () => {
        patchDraft(view.bundle.bundleId, { reworkInstruction: rework.value });
      }));
    }

    const actions = element('div', 'mobile-review__actions');
    for (const verdict of view.bundle.review.choices || []) {
      const labels: Record<string, string> = {
        good: 'Подходит',
        problem: 'Есть проблема',
        rework: 'В доработку',
        retired: 'Закрыть',
      };
      const action = button(labels[verdict] || verdict, verdict === 'good');
      action.addEventListener('click', () => {
        const assessment = seriesAssessment ? {
          schema: 'lab.series-assessment.v1',
          ...Object.fromEntries(Object.entries(seriesAssessment).map(([key, node]) => [key, node.value])),
        } : undefined;
        const taste = {
          schema: 'lab.taste.v1',
          interesting: interesting.value,
          too_similar: similar.value,
          payoff_quality: payoff.value,
        };
        const saved = {
          comment: comment.value,
          taste,
          seriesAssessment: assessment,
          seriesCompletionOverride: override.checked,
          reworkInstruction: rework.value,
          // The phone records only the taste decision. Generator resolves its
          // current server-owned recommended profile after the verdict, so no
          // provider/model identity is delivered to the author-blind client.
          reworkSelection: null,
        };
        writeDraft(view.bundle.bundleId, saved);
        if (verdict === 'rework' && !rework.value.trim()) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Опишите, что именно нужно доработать.';
          return;
        }
        if (verdict === 'rework' && !reworkAvailable) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Сейчас нет доступного исполнителя доработки.';
          return;
        }
        if (verdict === 'good' && view.bundle.action.kind === 'setting_review'
          && similar.value !== 'no') {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Для подходящего сеттинга подтвердите, что он достаточно новый.';
          return;
        }
        if (verdict === 'good' && seriesAssessment
          && Object.values(seriesAssessment).some((node) => node.value === 'unknown')) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Заполните четыре оценки серии.';
          return;
        }
        if (verdict === 'good' && !configuredPreview
          && !(view.bundle.action.kind === 'series_review' && override.checked)) {
          body.querySelector<HTMLElement>('[data-mobile-review-notice]')!.textContent = 'Сначала дождитесь exact preview или явно примите риск для серии.';
          return;
        }
        void submit({
          schema: 'operator.mobile-taste-review-decision.v1',
          verdict,
          comment: comment.value.trim(),
          tags: [],
          taste,
          seriesAssessment: assessment || null,
          seriesCompletionOverride: view.bundle.action.kind === 'series_review' && override.checked,
          reworkInstruction: verdict === 'rework' ? rework.value.trim() : null,
          reworkSelection: verdict === 'rework' ? saved.reworkSelection : null,
          playedMs: Math.max(0, Date.now() - startedAt),
          preview: configuredPreview ? {
            configured: true,
            reviewTargetId: configuredPreview.reviewTargetId,
            runtimeArtifactDigest: configuredPreview.runtimeArtifactDigest,
          } : { configured: false },
        });
      });
      actions.append(action);
    }
    form.append(actions);
    body.append(form);
  }

  function renderPrototype(view: MobileReviewView, body: HTMLElement): void {
    const form = element('div', 'mobile-review__form');
    const draft = readDraft(view.bundle.bundleId);
    const comment = element('textarea', 'mobile-review__textarea') as HTMLTextAreaElement;
    comment.maxLength = 2000;
    comment.placeholder = 'Какой инсайт дал прототип? Что попробовать дальше?';
    comment.value = String(draft.comment || '');
    form.append(voiceField('Комментарий', comment, () => {
      patchDraft(view.bundle.bundleId, { comment: comment.value });
    }));
    const actions = element('div', 'mobile-review__actions');
    const labels: Record<string, string> = {
      promising: 'Перспективно',
      insight_only: 'Сохранить как инсайт',
      no_signal: 'Нет сигнала',
      retired: 'Закрыть',
    };
    for (const verdict of view.bundle.review.choices || []) {
      const action = button(labels[verdict] || verdict, verdict === 'promising');
      action.addEventListener('click', () => {
        patchDraft(view.bundle.bundleId, { comment: comment.value });
        void submit({
          schema: 'operator.mobile-prototype-review-decision.v1',
          verdict,
          comment: comment.value.trim(),
        });
      });
      actions.append(action);
    }
    form.append(actions);
    body.append(form);
  }

  function renderExpert(view: MobileReviewView, body: HTMLElement): void {
    const choices = Array.isArray(view.bundle.review.choices) ? view.bundle.review.choices : [];
    const actions = element('div', 'mobile-review__actions');
    for (const choice of choices) {
      const action = button(String(choice.label || 'Продолжить'), choice.kind !== 'leave_paused');
      action.addEventListener('click', () => void submit({
        schema: 'operator.mobile-expert-decision.v1',
        choice: choice.kind,
        ...(choice.selectionDigest ? { selectionDigest: choice.selectionDigest } : {}),
      }));
      actions.append(action);
    }
    body.append(actions);
  }

  function renderPublication(view: MobileReviewView, body: HTMLElement): void {
    const flow = view.bundle.review.publication?.flow;
    if (flow?.state === 'published') {
      body.append(element('p', 'mobile-review__success', 'Серия уже опубликована.'));
      return;
    }
    const userCode = String(flow?.auth?.userCode || '');
    if (!userCode) {
      body.append(element('p', '', 'Подготовка публикации ещё идёт. Обновите через несколько секунд.'));
      const retry = button('Обновить', true);
      retry.addEventListener('click', () => void load(view.bundle.bundleId));
      body.append(retry);
      return;
    }
    body.append(
      element('p', '', 'Подтвердите exact-публикацию. Отдельно вводить код не нужно.'),
      element('div', 'mobile-review__code', userCode),
    );
    const action = button('Проверить и опубликовать', true);
    action.addEventListener('click', async () => {
      action.disabled = true;
      const notice = body.querySelector<HTMLElement>('[data-mobile-review-notice]')!;
      notice.textContent = 'Проверяем exact-публикацию…';
      try {
        const authorization = await apiCatalogLabLookup(userCode);
        const approved = await showConfirm(`Опубликовать exact-серию для заказа «${view.bundle.order.title}»?`);
        if (!approved) {
          notice.textContent = 'Публикация не подтверждена.';
          action.disabled = false;
          return;
        }
        await apiCatalogLabDecision({
          authorizationId: authorization.authorizationId,
          userCode,
          expectedDecisionVersion: authorization.decisionVersion,
          decision: 'approve',
        });
        notice.textContent = 'Подтверждено. Сервер публикует серию; повторно нажимать не нужно.';
        window.setTimeout(() => void load(view.bundle.bundleId), 2500);
      } catch (error) {
        notice.textContent = errorMessage(error);
        action.disabled = false;
      }
    });
    body.append(action);
  }

  function renderView(view: MobileReviewView): void {
    followEpoch += 1;
    current = view;
    configuredPreview = null;
    startedAt = Date.now();
    root.replaceChildren(heading(view));
    if (view.state !== 'current') {
      const stale = element('section', 'mobile-review__card');
      stale.append(
        element('h2', '', 'Этот шаг уже обработан'),
        element('p', '', 'Откройте входящие, чтобы увидеть актуальный шаг заказа.'),
      );
      const inbox = button('Открыть входящие', true);
      inbox.addEventListener('click', () => void loadInbox());
      stale.append(inbox);
      root.append(stale, technicalDetails(view));
      return;
    }
    const body = element('section', 'mobile-review__card');
    body.append(element('h2', '', view.bundle.presentation.title));
    const notice = element('p', 'mobile-review__status');
    notice.dataset.mobileReviewNotice = '';
    body.append(notice);
    if (view.bundle.runtime?.previews?.length) {
      mountRuntimePreview(body, view.bundle.runtime, (preview) => {
        configuredPreview = preview;
      });
    }
    switch (view.bundle.action.kind) {
      case 'exact_approval': {
        const action = button('Подтвердить exact шаг', true);
        action.addEventListener('click', () => void submit({
          schema: 'operator.mobile-order-approval-decision.v1',
          choice: 'approve',
        }));
        body.append(action);
        break;
      }
      case 'factory_review': renderFactory(view, body); break;
      case 'setting_selection': renderSettingSelection(view, body); break;
      case 'setting_review':
      case 'level_review':
      case 'series_review':
      case 'experiment_review': renderTaste(view, body); break;
      case 'prototype_review': renderPrototype(view, body); break;
      case 'expert_resolution': renderExpert(view, body); break;
      case 'telegram_approve': renderPublication(view, body); break;
      default: notice.textContent = 'Этот тип шага пока нельзя обработать с телефона.';
    }
    root.append(body, technicalDetails(view));
  }

  async function load(bundleId: string): Promise<void> {
    followEpoch += 1;
    root.replaceChildren(element('p', 'mobile-review__loading', 'Загружаем актуальный отсмотр…'));
    try {
      renderView(await apiMobileReview(bundleId));
    } catch (error) {
      root.replaceChildren(element('p', 'mobile-review__error', errorMessage(error)));
      const inbox = button('Открыть входящие', true);
      inbox.addEventListener('click', () => void loadInbox());
      root.append(inbox);
    }
  }

  async function loadInbox(): Promise<void> {
    followEpoch += 1;
    root.replaceChildren(element('p', 'mobile-review__loading', 'Загружаем входящие отсмотры…'));
    try {
      const reviews = await apiMobileReviewInbox();
      const header = element('header', 'mobile-review__header');
      header.append(
        element('span', 'mobile-review__brand', 'P4G · REVIEW'),
        element('h1', '', 'Нужен ваш отсмотр'),
        element('p', 'mobile-review__brief', reviews.length
          ? `${reviews.length} актуальных шагов`
          : 'Сейчас нет шагов, которые ждут вашего решения.'),
      );
      root.replaceChildren(header);
      for (const review of reviews) {
        const card = element('button', 'mobile-review__inbox-card') as HTMLButtonElement;
        card.type = 'button';
        card.append(
          element('span', 'mobile-review__eyebrow', review.bundle.action.label),
          element('strong', '', review.bundle.order.title),
          element('span', '', review.bundle.order.brief || review.bundle.presentation.summary),
        );
        card.addEventListener('click', () => renderView(review));
        root.append(card);
      }
    } catch (error) {
      root.replaceChildren(element('p', 'mobile-review__error', errorMessage(error)));
    }
  }

  if (initialBundleId) await load(initialBundleId);
  else await loadInbox();
}
