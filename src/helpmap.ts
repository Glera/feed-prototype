// Превью «карты помощи» — dogfood-подглядка за секретным параметром.
// Это НЕ замена меты: карта показывает демо-данные (бейдж «прототип ·
// демо-данные» намеренно остаётся на экране) и не ходит ни в один API.
//
// Всё тяжёлое (геометрия Natural Earth и рантайм карты) лежит СОСЕДЯМИ рядом с
// бандлом, в public/helpmap/, и подтягивается только когда карту открыли.
// Внутрь index.html их класть нельзя: vite-plugin-singlefile инлайнит любой
// импорт, так что «ленивый чанк» в этой сборке недостижим, и 280 КБ уехали бы
// в основной бандл. Загрузка соседнего файла — не выдумка, а тот же приём,
// которым island.ts тянет в проде ./island-preview-sort-v2.html.
//
// Карта живёт в Shadow DOM: стили приложения не протекают внутрь, стили карты
// не протекают наружу. Единственное, что мы намеренно пропускаем через
// границу, — кастомные свойства --safe-*, их считает telegram.ts (в Telegram
// fullscreen env(safe-area-inset-*) не заполняется).

type HelpMapCtx = { close: () => void };

type HelpMapRuntime = {
  HELPMAP_THEME: string;
  mountHelpMap: (host: HTMLElement, root: ShadowRoot, map: unknown) => () => void;
};

const ASSETS = 'helpmap/';
const assetUrl = (name: string) => new URL(ASSETS + name, document.baseURI).href;

type TelegramBackButton = {
  show?: () => void;
  hide?: () => void;
  onClick?: (fn: () => void) => void;
  offClick?: (fn: () => void) => void;
};

function backButton(): TelegramBackButton | null {
  try {
    return (window as any).Telegram?.WebApp?.BackButton ?? null;
  } catch {
    return null;
  }
}

export function renderHelpMap(ov: HTMLElement, ctx: HelpMapCtx): void {
  ov.style.cssText = 'position:absolute;inset:0;z-index:3000;overflow:hidden;background:#c0b8a1';
  const root = ov.attachShadow({ mode: 'open' });

  let destroyMap: (() => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    teardown();
    // closeOverlay() гасит слой анимацией и снимает его в конце. Пока она идёт,
    // узел ещё висит поверх ленты — снимаем с него ввод сразу, чтобы он не
    // съедал тапы, даже если анимация почему-то не доиграет.
    ov.style.pointerEvents = 'none';
    ctx.close();
  };

  // BackButton в этом приложении раньше не использовался — заводим его здесь и
  // за собой же прибираем, чтобы кнопка не осталась висеть над лентой.
  const back = backButton();
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const teardown = () => {
    document.removeEventListener('keydown', onEsc);
    try {
      back?.offClick?.(close);
      back?.hide?.();
    } catch {
      /* Telegram может не дать снять кнопку — не повод падать при закрытии */
    }
    watch.disconnect();
    destroyMap?.();
    destroyMap = null;
  };

  // Оверлей могут снять и мимо нас: любой тап по вкладке бара зовёт
  // closeOverlay() напрямую. Ловим исчезновение узла, иначе глобальные
  // подписки и таймер карты пережили бы её саму.
  const watch = new MutationObserver(() => {
    if (!ov.isConnected) {
      closed = true;
      teardown();
    }
  });
  if (ov.parentNode) watch.observe(ov.parentNode, { childList: true });

  document.addEventListener('keydown', onEsc);
  if (back?.show && back.onClick) {
    try {
      back.onClick(close);
      back.show();
    } catch {
      /* нет BackButton — ниже нарисуем свою кнопку */
    }
  }
  if (!back?.show) {
    // Вне Telegram (dev-маршрут ?helpmap=1) выйти иначе нечем.
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Закрыть карту');
    x.style.cssText =
      'position:absolute;z-index:4;left:14px;top:calc(var(--safe-top, 0px) + 52px);' +
      'width:34px;height:34px;border-radius:50%;border:1px solid rgba(118,94,60,.22);' +
      'background:rgba(252,248,238,.95);color:#453829;font-size:19px;line-height:1;cursor:pointer';
    x.addEventListener('click', close);
    root.appendChild(x);
  }

  void Promise.all([
    fetch(assetUrl('data.json')).then((r) => {
      if (!r.ok) throw new Error('helpmap data ' + r.status);
      return r.json();
    }),
    // Спецификатор — переменная, поэтому Vite оставляет импорт рантайму и не
    // втягивает модуль в бандл.
    import(/* @vite-ignore */ assetUrl('runtime.mjs')) as Promise<HelpMapRuntime>,
  ])
    .then(([map, runtime]) => {
      if (!ov.isConnected) return;
      ov.dataset.theme = runtime.HELPMAP_THEME;
      destroyMap = runtime.mountHelpMap(ov, root, map);
    })
    .catch(() => {
      // Превью не должно ронять ленту: показываем словами, что не сложилось.
      if (!ov.isConnected) return;
      const note = document.createElement('div');
      note.textContent = 'Карта не загрузилась';
      note.style.cssText =
        'position:absolute;inset:0;display:grid;place-items:center;' +
        'font:14px/1.4 -apple-system,system-ui,sans-serif;color:#453829';
      root.appendChild(note);
    });
}
