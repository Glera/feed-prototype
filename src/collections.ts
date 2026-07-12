// Collections (W-collections prototype): a "collection" is a set of 10 cards. A
// card is a layered visual — a stretchable cream background (bg_cards, 9-sliced
// via border-image so the uniform interior fills any size), the themed picture on
// top, and a ribbon at the bottom carrying the title text. Cards drop from the
// series chest (see feed.ts) and fly down into the collections button on the bar.
//
// Assets are inlined (vite assetsInlineLimit is effectively unlimited → single-file
// build). The 10 source pictures were 660×854 PNGs (~600 KB each); they're shipped
// here as width-400 q80 WebP (~15 KB each) so the whole set adds <200 KB to the
// bundle instead of ~6 MB.
import BG_CARDS from './assets/collections/bg_cards.png';
import RIBBON from './assets/collections/ribbon_title.webp';
import CARD_01 from './assets/collections/collection_1/card_01.webp';
import CARD_02 from './assets/collections/collection_1/card_02.webp';
import CARD_03 from './assets/collections/collection_1/card_03.webp';
import CARD_04 from './assets/collections/collection_1/card_04.webp';
import CARD_05 from './assets/collections/collection_1/card_05.webp';
import CARD_06 from './assets/collections/collection_1/card_06.webp';
import CARD_07 from './assets/collections/collection_1/card_07.webp';
import CARD_08 from './assets/collections/collection_1/card_08.webp';
import CARD_09 from './assets/collections/collection_1/card_09.webp';
import CARD_10 from './assets/collections/collection_1/card_10.webp';

export const CARD_BG = BG_CARDS;
export const CARD_RIBBON = RIBBON;

// border-image slice for bg_cards.png (273×273): captures the ~13 px soft glow
// plus the rounded corner; the interior past this is a uniform cream fill, so the
// centre stretches seamlessly to any card size.
export const CARD_BG_SLICE = 70;

export interface CollectionCard {
  /** stable id within its collection, 1-based */
  index: number;
  img: string;
  /** label rendered on the card ribbon */
  title: string;
}

export interface Collection {
  id: string;
  title: string;
  subtitle: string;
  /** reward granted after every card in the collection is gathered */
  rewardPuzzles: number;
  cards: CollectionCard[];
}

const COLLECTION_1_PICS = [
  CARD_01, CARD_02, CARD_03, CARD_04, CARD_05,
  CARD_06, CARD_07, CARD_08, CARD_09, CARD_10,
];

const COLLECTION_1_TITLES = [
  'Виниловый хит',
  'Кассетный плеер',
  'Радиоволна',
  'Золотой микрофон',
  'Электрогитара',
  'Диско-шар',
  'Бумбокс',
  'Музыкальная награда',
  'Джукбокс',
  'Король сцены',
];

export const COLLECTIONS: Collection[] = [
  {
    id: 'collection_1',
    title: 'Золотые хиты',
    subtitle: 'Музыка сквозь время',
    rewardPuzzles: 150,
    cards: COLLECTION_1_PICS.map((img, i) => ({
      index: i + 1,
      img,
      title: COLLECTION_1_TITLES[i],
    })),
  },
];

// Collection progress is intentionally separate from the chest-drop animation.
// Only compact card indexes are stored: the imported card images are inlined as
// data URLs in production and must never be copied into localStorage.
export interface CollectionProgress {
  collectedCardIndexes: number[];
}

export interface CollectionsProgressState {
  version: 1;
  byCollection: Record<string, CollectionProgress>;
}

const COLLECTIONS_PROGRESS_KEY = 'collections-progress-v1';
const DEMO_COLLECTED: Record<string, number[]> = {
  // A partial state makes both collected and missing treatments visible until
  // real season progress starts arriving from the product/backend.
  collection_1: [1, 2, 4, 7],
};

function defaultProgressFor(collectionId: string): CollectionProgress {
  return { collectedCardIndexes: [...(DEMO_COLLECTED[collectionId] ?? [])] };
}

export function defaultCollectionsProgressState(): CollectionsProgressState {
  const byCollection: Record<string, CollectionProgress> = {};
  COLLECTIONS.forEach((collection) => {
    byCollection[collection.id] = defaultProgressFor(collection.id);
  });
  return { version: 1, byCollection };
}

function normaliseProgress(value: unknown): CollectionsProgressState {
  const parsed = value && typeof value === 'object'
    ? value as Partial<CollectionsProgressState>
    : {};
  const source = parsed.byCollection && typeof parsed.byCollection === 'object'
    ? parsed.byCollection
    : {};
  const byCollection: Record<string, CollectionProgress> = {};

  COLLECTIONS.forEach((collection) => {
    const entry = source[collection.id];
    if (!entry || !Array.isArray(entry.collectedCardIndexes)) {
      byCollection[collection.id] = defaultProgressFor(collection.id);
      return;
    }
    const allowed = new Set(collection.cards.map((card) => card.index));
    const indexes = entry.collectedCardIndexes
      .filter((index): index is number => Number.isInteger(index) && allowed.has(index))
      .filter((index, pos, all) => all.indexOf(index) === pos)
      .sort((a, b) => a - b);
    byCollection[collection.id] = { collectedCardIndexes: indexes };
  });

  return { version: 1, byCollection };
}

export function saveCollectionsProgressState(state: CollectionsProgressState): void {
  try {
    localStorage.setItem(COLLECTIONS_PROGRESS_KEY, JSON.stringify(normaliseProgress(state)));
  } catch { /* storage can be blocked in private/embedded contexts */ }
}

export function loadCollectionsProgressState(): CollectionsProgressState {
  try {
    const raw = localStorage.getItem(COLLECTIONS_PROGRESS_KEY);
    const state = raw ? normaliseProgress(JSON.parse(raw) as unknown) : defaultCollectionsProgressState();
    // Re-cache the normalised shape so corrupt/old/future entries cannot leak into
    // the runtime state, and the first-run demo progress survives a reload.
    saveCollectionsProgressState(state);
    return state;
  } catch {
    const state = defaultCollectionsProgressState();
    saveCollectionsProgressState(state);
    return state;
  }
}

export function collectedCardIndexes(
  state: CollectionsProgressState,
  collectionId: string,
): ReadonlySet<number> {
  return new Set(state.byCollection[collectionId]?.collectedCardIndexes ?? []);
}

export function collectionById(id: string): Collection | undefined {
  return COLLECTIONS.find((c) => c.id === id);
}

/** Pick a random card from a collection (default: the only one for now). */
export function randomCard(collectionId = 'collection_1'): CollectionCard {
  const col = collectionById(collectionId) ?? COLLECTIONS[0];
  return col.cards[Math.floor(Math.random() * col.cards.length)];
}

// Build the layered card DOM. `sizePx` is the card WIDTH; height follows the
// 3:4-ish card ratio. Used both for the flying drop and (later) the collection
// screen. The bg is a border-image 9-slice so it stretches without distorting
// the rounded corners.
export function makeCollectionCard(card: CollectionCard, sizePx = 132): HTMLElement {
  const el = document.createElement('div');
  el.className = 'coll-card';
  el.style.width = `${sizePx}px`;
  // The cream frame is a 9-slice of bg_cards (slice/repeat live in CSS; the source
  // is an imported data URL so it must be set here).
  el.style.borderImageSource = `url(${CARD_BG})`;
  el.innerHTML =
    `<div class="coll-card__pic"><img src="${card.img}" alt="" draggable="false"></div>` +
    '<div class="coll-card__ribbon">' +
      `<img class="coll-card__ribbon-bg" src="${CARD_RIBBON}" alt="" draggable="false">` +
      `<span class="coll-card__title">${card.title}</span>` +
    '</div>';
  return el;
}
