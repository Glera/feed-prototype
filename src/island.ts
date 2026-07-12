/**
 * Island meta prototype — the PARALLEL experiment to the diamond meta world
 * (feed.ts openMetaWorld). Lives behind the TRIANGLE icon on the feed bar.
 *
 * Concept ("patchwork island"): the player's island is a showcase of their
 * created mechanics. Each mechanic is a building that THEMES its own sector —
 * ground tint + props + palette all come from the theme pack, so the island
 * grows out of what the player makes instead of being decorated from a catalog.
 *
 * Island state is authoritative in swipe-backend and revision-synchronised
 * across Telegram clients; localStorage is only the instant-paint/offline cache.
 * Playing a building launches the hosted UGC artifact when it exists, with a
 * canonical stock build as fallback. Generated code never mutates that build.
 */
import {
  ApiRequestError,
  apiCompleteIslandVisit,
  apiIslandBake,
  apiIslandBakeJob,
  apiIslandTheme,
  apiPublicIsland,
  apiSetIslandLike,
  apiStartIslandVisit,
  type IslandBakeJob,
  type IslandBuildingState,
  type IslandDifficultyPreference,
  type IslandMotionPreference,
  type IslandPersistedState,
  type IslandSocialView,
  type IslandStoredPack,
  type IslandTemplateId,
  type PublicIslandView,
} from './api';
import { IslandStateSync, cacheIslandState, loadIslandState, replaceIslandState } from './island-state';
import { ISLAND_SIM_EVENT, loadIslandSim, saveIslandSim } from './island-sim';
import { coverUrl, playableUrl } from './playables';
import { shareTelegramLink, showConfirm } from './telegram';

declare const __ISLAND_SORT_RECIPE__: {
  baseBuild: string;
};

const SORT_RECIPE = __ISLAND_SORT_RECIPE__;

export interface IslandHostCtx {
  close(): void;
  level?: number;
  puzzles?: () => number;
  publicIsland?: PublicIslandView;
  // Collecting puzzles piled over a mechanic adds them to the ONE shared HUD counter.
  // `from` is the tap point in viewport px so the feed can fly the pucks into it.
  addPuzzles?: (n: number, from?: { x: number; y: number }) => void;
}

type TplId = IslandTemplateId;
type VariantKeys = 'sceneBg' | 'belt' | 'outline' | 'seed' | 'difficulty' | 'motion' | 'marbleStyle'
  | 'markerStyle' | 'targetShape' | 'conveyorPath' | 'sourceShape' | 'backgroundPattern';
type Pack = IslandStoredPack & Required<Pick<IslandStoredPack, VariantKeys>>;
type Building = IslandBuildingState & { autoplayPassed?: boolean };
type IslandState = IslandPersistedState;
type CreationMode = 'safe' | 'guided' | 'wild';
type CreationTier = 'free' | 'cheap' | 'expensive';
type ExperimentProvider = 'claude' | 'codex' | 'auto';
interface ExperimentConcept {
  title: string;
  feeling: string;
  pitch: string;
  mechanic: string;
  risk: 'low' | 'medium' | 'high';
}
interface ExperimentResult {
  id: string;
  parentId: string | null;
  title: string;
  pitch: string;
  mechanic: string;
  feeling: string;
  prompt: string;
  feedback: string | null;
  attempts: number;
  url: string;
  coverUrl?: string;
  agentSummary: string;
  autoplayPassed?: boolean;
  gateError?: string | null;
}
interface GeneratorLiveness {
  state: 'queued' | 'runner' | 'agent' | 'quiet' | 'recovering' | 'finished' | 'failed' | 'cancelled';
  runnerPid?: number;
  agentPid?: number;
  checkedAt?: string;
  lastSignalAt?: string;
  sourceEdited?: boolean;
}
interface ExperimentMessage {
  role: 'player' | 'agent' | 'system';
  text: string;
  at: string;
  experimentId?: string;
}
interface ExperimentJob {
  id: string;
  state: 'queued' | 'starting' | 'running' | 'ready' | 'failed' | 'cancelled';
  phase: string;
  message: string;
  attempt: number;
  logs: Array<{ phase: string; message: string; attempt?: number; at?: string }>;
  result?: ExperimentResult;
  error?: string;
  pid?: number | null;
  liveness?: GeneratorLiveness;
}
interface ExperimentPublishResult {
  id: string;
  rel: string;
  meta: string;
  url: string;
  coverUrl?: string;
  commit: string;
  ready: boolean;
  dryRun: boolean;
}
interface ExperimentPublishJob {
  id: string;
  state: 'queued' | 'starting' | 'running' | 'ready' | 'failed' | 'cancelled';
  phase: string;
  message: string;
  logs: Array<{ phase: string; message: string }>;
  result?: ExperimentPublishResult;
  error?: string;
}
interface CreationDraft {
  slot: number;
  tpl: TplId;
  mode: CreationMode;
  tier: CreationTier;
  provider: ExperimentProvider;
  prompt: string;
  pack: Pack;
  presetId: string;
  rerolls: number;
  difficulty: IslandDifficultyPreference;
  motion: IslandMotionPreference;
  ai?: boolean;
  avoid?: string;
  concepts?: ExperimentConcept[];
  conceptJobId?: string;
  concept?: ExperimentConcept;
  experiment?: ExperimentResult;
  experimentJobId?: string;
  messages?: ExperimentMessage[];
  sourceLocalSlot?: number;
  candidates?: CreationCandidate[];
}
type CandidateState = 'waiting' | 'generating' | 'ready' | 'failed';
interface CreationCandidate {
  mode: CreationMode;
  state: CandidateState;
  pack?: Pack;
  ai: boolean;
  played?: boolean;
  outcome?: 'won' | 'lost';
  startedAt?: number;
  jobId?: string;
  logs?: Array<{ phase: string; message: string; attempt?: number; at?: string }>;
  liveness?: GeneratorLiveness;
  phase?: string;
  error?: string;
  concept?: ExperimentConcept;
  experiment?: ExperimentResult;
  experimentJobId?: string;
}
interface ExperimentBundleSnapshot {
  schemaVersion: 1;
  tier: 'expensive';
  slot: number;
  prompt: string;
  provider: ExperimentProvider;
  difficulty: IslandDifficultyPreference;
  motion: IslandMotionPreference;
  safePack: Pack;
  guidedPack?: Pack;
  guidedError?: string;
  messages?: ExperimentMessage[];
}
interface LocalExperimentThread {
  placedExperimentId: string;
  provider: ExperimentProvider;
  prompt: string;
  concept: ExperimentConcept;
  experiment: ExperimentResult;
  experimentJobId?: string;
  messages: ExperimentMessage[];
  updatedAt: string;
}
interface LocalExperimentState {
  buildings: Building[];
  packs: Record<string, Pack>;
  threads: Record<string, LocalExperimentThread>;
}

const PACKS: Pack[] = [
  { id: 'forest', name: 'Mushroom forest', kw: ['mushroom', 'forest', 'moss', 'гриб', 'лес', 'мох'],
    ground: '#79A155', edge: '#5C7F41', sceneBg: '#152218', boardBg: '#24372A', belt: '#556B50', outline: '#B6C6A8',
    items: ['#D9534F', '#F2E3C6', '#E8A33D', '#8A5A44', '#6FA34B', '#5B8BD8'], prop: 'mushroom', body: '#F2E3C6', roof: '#C94A3D',
    seed: 0xF012E57, difficulty: 'easy', motion: 'calm', marbleStyle: 'matte', markerStyle: 'dots', targetShape: 'bowl', conveyorPath: 'oval', sourceShape: 'flask', backgroundPattern: 'grid' },
  { id: 'neon', name: 'Neon city', kw: ['neon', 'cyber', 'city', 'night', 'неон', 'кибер', 'город', 'ноч'],
    ground: '#3A3357', edge: '#5C51A0', sceneBg: '#050509', boardBg: '#10101A', belt: '#242038', outline: '#59F3E7',
    items: ['#41E0D0', '#FF5FA2', '#FFD84D', '#8F7FFF', '#9BF6FF', '#FF6B3D'], prop: 'crystal', body: '#4A4170', roof: '#41E0D0',
    seed: 0x0E0C17A, difficulty: 'hard', motion: 'chaotic', marbleStyle: 'glass', markerStyle: 'glyphs', targetShape: 'hex', conveyorPath: 'wave', sourceShape: 'silo', backgroundPattern: 'stars' },
  { id: 'sea', name: 'Underwater world', kw: ['water', 'sea', 'ocean', 'fish', 'reef', 'вод', 'мор', 'океан', 'рыб', 'риф'],
    ground: '#4E9DB0', edge: '#38798A', sceneBg: '#071A22', boardBg: '#103441', belt: '#245F70', outline: '#9FE7F1',
    items: ['#FF8B7E', '#FFC85C', '#4FC9AE', '#4E8FD0', '#E858B8', '#8E6FE8'], prop: 'coral', body: '#DFF2EE', roof: '#FF8B7E',
    seed: 0x05EA2026, difficulty: 'easy', motion: 'calm', marbleStyle: 'bubble', markerStyle: 'rings', targetShape: 'bowl', conveyorPath: 'oval', sourceShape: 'flask', backgroundPattern: 'bubbles' },
  { id: 'candy', name: 'Candy kingdom', kw: ['candy', 'sweet', 'caramel', 'cake', 'слад', 'конфет', 'карамел', 'торт'],
    ground: '#DE9FBE', edge: '#B96F92', sceneBg: '#2A1423', boardBg: '#4A203B', belt: '#7B4167', outline: '#FFD9EC',
    items: ['#F26FA8', '#7EC9EE', '#F5D96E', '#A98FEF', '#6FDCA4', '#FF9B54'], prop: 'lollipop', body: '#FBEFF5', roof: '#F26FA8',
    seed: 0xCA0D1202, difficulty: 'medium', motion: 'bouncy', marbleStyle: 'glossy', markerStyle: 'stripes', targetShape: 'jar', conveyorPath: 'racetrack', sourceShape: 'bottle', backgroundPattern: 'solid' },
  { id: 'lava', name: 'Volcano wastes', kw: ['lava', 'volcano', 'fire', 'ash', 'лав', 'вулкан', 'ог', 'пепел'],
    ground: '#5A4A47', edge: '#42332F', sceneBg: '#120A08', boardBg: '#2A1410', belt: '#4C2920', outline: '#FF8A4A',
    items: ['#FF7031', '#FFDD1C', '#9C4433', '#5E4B48', '#FFE08A', '#4EA6D8'], prop: 'rock', body: '#7A625C', roof: '#FF7031',
    seed: 0x1A7A2026, difficulty: 'hard', motion: 'heavy', marbleStyle: 'ember', markerStyle: 'dots', targetShape: 'crystal', conveyorPath: 'compact', sourceShape: 'hopper', backgroundPattern: 'embers' },
];
const TPL: Record<TplId, { label: string; ds: string; playableId: string }> = {
  sort:  { label: 'Sorting', ds: 'sort items into flasks',        playableId: SORT_RECIPE.baseBuild },
  merge: { label: 'Merge',   ds: 'combine and grow the chain',    playableId: 'merge-locked-v1-swipe' },
  pins:  { label: 'Pins',    ds: 'pull the pins, catch it all',   playableId: 'pins-swipe' },
};
const CREATABLE_TPLS: TplId[] = ['sort'];
// Island map: 10 slots scattered over a field LARGER than the viewBox window
// (390×540) so the player pans the map with a finger to reach them. The first
// UNLOCKED_SLOTS are playable; the rest are locked (🔒, decorative for now).
const SLOTS = [
  { x: 130, y: 210 }, { x: 292, y: 176 }, { x: 108, y: 402 }, { x: 300, y: 420 },   // 0–3 unlocked
  { x: 468, y: 300 }, { x: 214, y: 588 }, { x: 430, y: 560 }, { x: 66, y: 592 },     // 4–7 locked
  { x: 352, y: 726 }, { x: 156, y: 760 },                                             // 8–9 locked
];
const HUB = { x: 210, y: 300 };
const UNLOCKED_SLOTS = 4;
// The pannable world extent (max slot reach + margin), and the visible window.
const WORLD_W = 540, WORLD_H = 830, VIEW_W = 390, VIEW_H = 540;

// Local activity simulation is a dev-only feed presentation. Island counters
// always render the backend-owned values from the persisted/public snapshot.
function fmtNum(n: number): string { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
const IS_DEV = Boolean((import.meta as any).env?.DEV);
const UGC_BASE_URL = String((import.meta as any).env?.VITE_UGC_BASE_URL || 'https://swipe-ugc.onrender.com').replace(/\/$/, '');
const LOCAL_GENERATOR_URL = String((import.meta as any).env?.VITE_LOCAL_GENERATOR_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');

function stableSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function normalizePack(raw: IslandStoredPack): Pack {
  const fallback = PACKS.find((pack) => pack.id === raw.id) ?? PACKS[0];
  return {
    ...raw,
    sceneBg: raw.sceneBg ?? fallback.sceneBg,
    belt: raw.belt ?? fallback.belt,
    outline: raw.outline ?? fallback.outline,
    seed: Number.isInteger(raw.seed) ? Number(raw.seed) >>> 0 : stableSeed(`${raw.id}:${raw.name}`),
    difficulty: raw.difficulty ?? fallback.difficulty,
    motion: raw.motion ?? fallback.motion,
    marbleStyle: raw.marbleStyle ?? fallback.marbleStyle,
    markerStyle: raw.markerStyle ?? fallback.markerStyle,
    targetShape: raw.targetShape ?? fallback.targetShape,
    conveyorPath: raw.conveyorPath ?? fallback.conveyorPath,
    sourceShape: raw.sourceShape ?? fallback.sourceShape,
    backgroundPattern: raw.backgroundPattern ?? fallback.backgroundPattern,
  };
}

function variantFingerprint(pack: Pack): string {
  return [pack.name, pack.marbleStyle, pack.markerStyle, pack.targetShape, pack.conveyorPath,
    pack.sourceShape, pack.backgroundPattern, pack.difficulty, pack.motion].join('|').slice(0, 220);
}

function esc(t: string): string {
  return t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
}
function levelOf(b: Building): number { return 1 + Math.floor(Math.log10(1 + b.plays)); }
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
}
function hostedUrl(building: Building): string | null {
  if (building.rel) return IS_DEV ? `/ugc/${building.rel}` : `${UGC_BASE_URL}/${building.rel}`;
  return building.url ?? null;
}
function sortVariant(pack: Pack): Record<string, unknown> {
  return {
    schemaVersion: 2,
    seed: pack.seed,
    items: pack.items,
    sceneBg: pack.sceneBg,
    boardBg: pack.boardBg,
    belt: pack.belt,
    outline: pack.outline,
    difficulty: pack.difficulty,
    motion: pack.motion,
    marbleStyle: pack.marbleStyle,
    markerStyle: pack.markerStyle,
    targetShape: pack.targetShape,
    conveyorPath: pack.conveyorPath,
    sourceShape: pack.sourceShape,
    backgroundPattern: pack.backgroundPattern,
  };
}
function encodePreviewVariant(pack: Pack): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sortVariant(pack)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function candidatePreviewUrl(candidate: CreationCandidate): string | null {
  if (candidate.mode === 'wild') {
    const url = candidate.experiment?.url;
    return url ? `${url}${url.includes('?') ? '&' : '?'}auto=0` : null;
  }
  if (!candidate.pack) return null;
  const shell = IS_DEV ? '/ugc/preview/sort-v2.html' : `${UGC_BASE_URL}/preview/sort-v2.html`;
  return `${shell}?auto=0#${encodePreviewVariant(candidate.pack)}`;
}
function isLocalExperiment(building: Building): boolean {
  return IS_DEV && Boolean(building.url?.startsWith('/ugc/u/local-experiments/'));
}
function localExperimentId(building: Building): string | null {
  if (!isLocalExperiment(building)) return null;
  const match = building.url?.match(/\/([^/?]+)\.html(?:\?|$)/);
  return match && /^[a-z0-9-]{8,80}$/.test(match[1]) ? match[1] : null;
}
function experimentArtifactId(building: Building): string | null {
  const match = building.url?.match(/\/u\/local-experiments\/([a-z0-9-]{8,80})\.html(?:[?#]|$)/);
  return match?.[1] ?? null;
}
function hostedExperimentArtifactId(building: Building): string | null {
  const match = building.url?.match(/\/u\/[^/]+\/([a-z0-9-]{8,80})\.html(?:[?#]|$)/);
  return match?.[1] ?? null;
}
function experimentCoverUrl(result: ExperimentResult): string {
  return result.coverUrl || result.url.replace(/\.html(?=([?#]|$))/, '.cover.png');
}
function buildingExperimentCoverUrl(building: Building, experimentId: string | null): string | null {
  return experimentId && building.url
    ? building.url.replace(/\.html(?=([?#]|$))/, '.cover.png')
    : null;
}
function restoreExperimentConcept(value: unknown): ExperimentConcept | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ExperimentConcept>;
  const title = String(raw.title || '').trim().slice(0, 60);
  const mechanic = String(raw.mechanic || '').trim().slice(0, 500);
  if (!title || !mechanic) return null;
  return {
    title,
    mechanic,
    feeling: String(raw.feeling || '').trim().slice(0, 240),
    pitch: String(raw.pitch || '').trim().slice(0, 500),
    risk: raw.risk === 'low' || raw.risk === 'medium' ? raw.risk : 'high',
  };
}
function restoreExperimentResult(value: unknown): ExperimentResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ExperimentResult>;
  const id = String(raw.id || '').trim();
  const url = String(raw.url || '').trim();
  const rawCoverUrl = String(raw.coverUrl || '').trim();
  const attempts = Number(raw.attempts || 1);
  if (!/^[a-z0-9-]{8,80}$/.test(id)
    || !new RegExp(`^/ugc/u/local-experiments/${id}\\.html(?:[?#]|$)`).test(url)) return null;
  return {
    id,
    parentId: typeof raw.parentId === 'string' ? raw.parentId.slice(0, 80) : null,
    title: String(raw.title || 'Creative experiment').trim().slice(0, 60),
    pitch: String(raw.pitch || '').trim().slice(0, 500),
    mechanic: String(raw.mechanic || '').trim().slice(0, 500),
    feeling: String(raw.feeling || '').trim().slice(0, 240),
    prompt: String(raw.prompt || '').trim().slice(0, 500),
    feedback: typeof raw.feedback === 'string' ? raw.feedback.trim().slice(0, 500) : null,
    attempts: Number.isFinite(attempts) ? Math.max(1, Math.min(3, attempts)) : 1,
    url,
    coverUrl: new RegExp(`^/ugc/u/local-experiments/${id}\\.cover\\.png(?:[?#]|$)`).test(rawCoverUrl)
      ? rawCoverUrl
      : `/ugc/u/local-experiments/${id}.cover.png`,
    agentSummary: String(raw.agentSummary || '').trim().slice(0, 1000),
    ...(typeof raw.autoplayPassed === 'boolean' ? { autoplayPassed: raw.autoplayPassed } : {}),
    gateError: typeof raw.gateError === 'string' ? raw.gateError.trim().slice(0, 1000) : null,
  };
}
function restoreExperimentMessages(value: unknown): ExperimentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ExperimentMessage[] => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Partial<ExperimentMessage>;
    const role = raw.role === 'player' || raw.role === 'system' ? raw.role : 'agent';
    const text = String(raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!text) return [];
    const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
    const experimentId = typeof raw.experimentId === 'string' && /^[a-z0-9-]{8,80}$/.test(raw.experimentId)
      ? raw.experimentId
      : undefined;
    return [{ role, text, at, ...(experimentId ? { experimentId } : {}) }];
  }).slice(-24);
}
function restoreLocalExperimentThread(value: unknown): LocalExperimentThread | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LocalExperimentThread>;
  const concept = restoreExperimentConcept(raw.concept);
  const experiment = restoreExperimentResult(raw.experiment);
  if (!concept || !experiment) return null;
  const provider: ExperimentProvider = raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : 'auto';
  return {
    placedExperimentId: typeof raw.placedExperimentId === 'string' && /^[a-z0-9-]{8,80}$/.test(raw.placedExperimentId)
      ? raw.placedExperimentId
      : experiment.id,
    provider,
    prompt: String(raw.prompt || experiment.prompt || '').trim().slice(0, 500),
    concept,
    experiment,
    experimentJobId: typeof raw.experimentJobId === 'string' ? raw.experimentJobId.slice(0, 80) : undefined,
    messages: restoreExperimentMessages(raw.messages),
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : new Date().toISOString(),
  };
}
function localExperimentStorageKey(): string {
  const userId = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return `island-local-experiments-v1${Number.isSafeInteger(userId) ? `:${userId}` : ''}`;
}
function loadLocalExperiments(): LocalExperimentState {
  if (!IS_DEV) return { buildings: [], packs: {}, threads: {} };
  try {
    const raw = localStorage.getItem(localExperimentStorageKey());
    if (!raw) return { buildings: [], packs: {}, threads: {} };
    const parsed = JSON.parse(raw) as Partial<LocalExperimentState>;
    const threads: Record<string, LocalExperimentThread> = {};
    if (parsed.threads && typeof parsed.threads === 'object') {
      for (const [slot, candidate] of Object.entries(parsed.threads)) {
        if (!/^\d$/.test(slot) || Number(slot) >= SLOTS.length) continue;
        const thread = restoreLocalExperimentThread(candidate);
        if (thread) threads[slot] = thread;
      }
    }
    return {
      buildings: Array.isArray(parsed.buildings)
        ? parsed.buildings.filter((building) => building && isLocalExperiment(building)
          && Number.isInteger(building.slot) && building.slot >= 0 && building.slot < SLOTS.length).slice(0, SLOTS.length)
        : [],
      packs: parsed.packs && typeof parsed.packs === 'object' ? parsed.packs : {},
      threads,
    };
  } catch {
    return { buildings: [], packs: {}, threads: {} };
  }
}
function saveLocalExperiments(state: LocalExperimentState): void {
  if (!IS_DEV) return;
  try { localStorage.setItem(localExperimentStorageKey(), JSON.stringify(state)); } catch { /* private mode */ }
}
function newJobId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Guided generation is always the bounded backend/API path. Subscription
// agents belong exclusively to the local wild experiment service.
async function aiTheme(
  prompt: string,
  avoid?: string,
  difficulty: IslandDifficultyPreference = 'surprise',
  motion: IslandMotionPreference = 'surprise',
): Promise<Pack | null> {
  try {
    const apiPack = await apiIslandTheme({ prompt, avoid, difficulty, motion });
    console.log('[island] backend theme:', apiPack.name, apiPack.items.join(' '));
    return normalizePack({
      id: apiPack.id ?? '', name: apiPack.name.slice(0, 24), kw: apiPack.kw ?? [],
      ground: apiPack.ground, edge: apiPack.edge, boardBg: apiPack.boardBg,
      sceneBg: apiPack.sceneBg, belt: apiPack.belt, outline: apiPack.outline,
      items: apiPack.items, prop: apiPack.prop, body: apiPack.body, roof: apiPack.roof,
      seed: apiPack.seed, difficulty: apiPack.difficulty, motion: apiPack.motion,
      marbleStyle: apiPack.marbleStyle, markerStyle: apiPack.markerStyle,
      targetShape: apiPack.targetShape, conveyorPath: apiPack.conveyorPath,
      sourceShape: apiPack.sourceShape, backgroundPattern: apiPack.backgroundPattern,
    });
  } catch (e) {
    console.log('[island] bounded API theme unavailable:', errorText(e));
    throw e;
  }
}

type LocalGeneratorState = 'queued' | 'starting' | 'running' | 'ready' | 'failed' | 'cancelled';
interface LocalGeneratorJob<T> {
  id: string;
  type?: 'concepts' | 'experiment' | 'publish';
  state: LocalGeneratorState;
  phase: string;
  message: string;
  logs: Array<{ phase: string; message: string; attempt?: number; at?: string }>;
  result?: T;
  error?: string;
  request?: Record<string, unknown>;
  consumedAt?: string | null;
  createdAt?: string;
  provider?: ExperimentProvider | null;
  attempt?: number;
  pid?: number | null;
  liveness?: GeneratorLiveness;
}

function generatorClientId(): string {
  const key = 'swipe-generator-client-v1';
  try {
    const current = localStorage.getItem(key);
    if (current) return current;
    const value = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : newJobId();
    localStorage.setItem(key, value);
    return value;
  } catch {
    return 'local-browser';
  }
}

function telegramChatId(): number | undefined {
  const value = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return Number.isSafeInteger(value) ? value : undefined;
}

async function generatorRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!IS_DEV) throw new Error('The local generator is available only in development');
  try {
    const response = await fetch(`${LOCAL_GENERATOR_URL}${path}`, init);
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || `Generator HTTP ${response.status}`);
    return data;
  } catch (error) {
    const message = errorText(error);
    throw new Error(message.includes('fetch')
      ? `Local generator is offline at ${LOCAL_GENERATOR_URL}; start swipe-generator`
      : message);
  }
}

async function createGeneratorJob<T>(body: Record<string, unknown>): Promise<LocalGeneratorJob<T>> {
  return generatorRequest<LocalGeneratorJob<T>>('/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, clientId: generatorClientId() }),
  });
}

async function generatorJob<T>(jobId: string): Promise<LocalGeneratorJob<T>> {
  return generatorRequest<LocalGeneratorJob<T>>(`/v1/jobs/${encodeURIComponent(jobId)}`);
}

async function generatorJobs<T>(): Promise<Array<LocalGeneratorJob<T>>> {
  const data = await generatorRequest<{ jobs: Array<LocalGeneratorJob<T>> }>(`/v1/jobs?clientId=${encodeURIComponent(generatorClientId())}`);
  return data.jobs;
}

async function consumeGeneratorJob(jobId: string): Promise<void> {
  await generatorRequest(`/v1/jobs/${encodeURIComponent(jobId)}/consume`, { method: 'POST' });
}

function generatorPending(state: LocalGeneratorState): boolean {
  return state === 'queued' || state === 'starting' || state === 'running';
}

function signalAge(at?: string): string {
  const time = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return 'unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1 ? 'less than a minute ago' : `${minutes}m ago`;
}

function generatorHealth(
  liveness: GeneratorLiveness | undefined,
  state: LocalGeneratorState | CandidateState,
  pid?: number | null,
): string {
  if (liveness?.state === 'quiet') {
    return `quiet but alive · agent PID ${liveness.agentPid || '?'} · last output/source edit ${signalAge(liveness.lastSignalAt)}`;
  }
  if (liveness?.state === 'agent') {
    return `agent PID ${liveness.agentPid || '?'} alive · last output/source edit ${signalAge(liveness.lastSignalAt)}`;
  }
  if (liveness?.state === 'runner') return `worker runner PID ${liveness.runnerPid || pid || '?'} alive`;
  if (liveness?.state === 'recovering') return 'runner disappeared · job safely returned to the durable queue';
  if (liveness?.state === 'queued' || state === 'queued' || state === 'waiting') return 'durable queue · safe across page reloads';
  if (liveness?.state === 'finished' || state === 'ready') return 'worker finished normally';
  if (liveness?.state === 'failed' || state === 'failed') return 'worker reached a terminal failure';
  if (liveness?.state === 'cancelled' || state === 'cancelled') return 'job was cancelled';
  if (state === 'running' || state === 'starting' || state === 'generating') return `worker runner PID ${pid || '?'} alive`;
  return `terminal state · ${state}`;
}

async function experimentConcepts(
  prompt: string,
  provider: ExperimentProvider,
  slot: number,
  bundle?: ExperimentBundleSnapshot,
  onProgress?: (job: LocalGeneratorJob<{ concepts: ExperimentConcept[] }>) => void,
): Promise<{ concepts: ExperimentConcept[]; jobId: string }> {
  const created = await createGeneratorJob<{ concepts: ExperimentConcept[] }>({
    type: 'concepts', template: 'sort', prompt, provider, slot, bundle,
  });
  onProgress?.(created);
  for (let poll = 0; poll < 24 * 60 * 60; poll++) {
    const job = await generatorJob<{ concepts: ExperimentConcept[] }>(created.id);
    onProgress?.(job);
    if (job.state === 'ready' && Array.isArray(job.result?.concepts)) {
      return { concepts: job.result.concepts, jobId: job.id };
    }
    if (!generatorPending(job.state)) throw new Error(job.error || job.message || 'Concept generation failed');
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error('Concept generation reached its 24-hour deadline');
}

async function startExperiment(
  prompt: string,
  concept: ExperimentConcept,
  provider: ExperimentProvider,
  slot: number,
  parentId?: string,
  feedback?: string,
  bundle?: ExperimentBundleSnapshot,
): Promise<string> {
  const chat = telegramChatId();
  const job = await createGeneratorJob<ExperimentResult>({
    type: 'experiment', baseline: 'sort-v2', prompt, concept, provider, slot, parentId, feedback, bundle, chat,
  });
  return job.id;
}

async function experimentStatus(jobId: string): Promise<ExperimentJob> {
  return generatorJob<ExperimentResult>(jobId) as Promise<ExperimentJob>;
}

async function startExperimentPublish(experimentId: string): Promise<string> {
  const chat = telegramChatId();
  const job = await createGeneratorJob<ExperimentPublishResult>({
    type: 'publish', experimentId, user: chat ? String(chat) : 'dev', chat,
  });
  return job.id;
}

async function experimentPublishStatus(jobId: string): Promise<ExperimentPublishJob> {
  return generatorJob<ExperimentPublishResult>(jobId) as Promise<ExperimentPublishJob>;
}

function pickPack(txt: string, excl: string | null): Pack {
  const t = txt.toLowerCase();
  let p = t ? PACKS.find((x) => x.kw.some((k) => t.includes(k))) : undefined;
  if (!p || p.id === excl) {
    const pool = PACKS.filter((x) => x.id !== excl);
    p = pool[Math.floor(Math.random() * pool.length)];
  }
  return p;
}

function safeParameterizedPack(draft: CreationDraft): Pack {
  const requested = draft.presetId !== 'surprise'
    ? PACKS.find((pack) => pack.id === draft.presetId)
    : undefined;
  const base = requested ?? pickPack(draft.prompt, null);
  const seed = stableSeed(`${newJobId()}:${draft.slot}:${draft.prompt}:${draft.presetId}`);
  const choose = <T,>(values: readonly T[], shift: number): T => values[(seed >>> shift) % values.length];
  const marbleStyles: Pack['marbleStyle'][] = ['glossy', 'matte', 'glass', 'metal', 'gem', 'bubble', 'ember', 'obsidian'];
  const markerStyles: Pack['markerStyle'][] = ['none', 'rings', 'dots', 'stripes', 'glyphs'];
  const targetShapes: Pack['targetShape'][] = ['capsule', 'hex', 'jar', 'bowl', 'crystal'];
  const conveyorPaths: Pack['conveyorPath'][] = ['racetrack', 'oval', 'compact', 'wave'];
  const sourceShapes: Pack['sourceShape'][] = ['bottle', 'hopper', 'silo', 'flask'];
  const backgroundPatterns: Pack['backgroundPattern'][] = ['solid', 'grid', 'stars', 'bubbles', 'embers'];
  const difficulties: Pack['difficulty'][] = ['easy', 'medium', 'hard', 'expert'];
  const motions: Pack['motion'][] = ['calm', 'heavy', 'bouncy', 'chaotic'];
  const rotate = seed % base.items.length;
  return normalizePack({
    ...base,
    id: `safe-${newJobId()}`,
    name: `${base.name} Mix`.slice(0, 40),
    kw: [],
    items: [...base.items.slice(rotate), ...base.items.slice(0, rotate)],
    seed,
    difficulty: draft.difficulty === 'surprise' ? choose(difficulties, 2) : draft.difficulty,
    motion: draft.motion === 'surprise' ? choose(motions, 5) : draft.motion,
    marbleStyle: choose(marbleStyles, 8),
    markerStyle: choose(markerStyles, 11),
    targetShape: choose(targetShapes, 14),
    conveyorPath: choose(conveyorPaths, 17),
    sourceShape: choose(sourceShapes, 20),
    backgroundPattern: choose(backgroundPatterns, 23),
  });
}

// Same shape the feed's outcomeFromMessage accepts, trimmed to what the swipe
// builds actually send ({source:'playable', type:'completed', success}).
function outcomeOf(data: unknown): 'won' | 'lost' | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = String(d.type ?? d.event ?? '').toLowerCase();
  const outcome = String(d.outcome ?? d.result ?? '').toLowerCase();
  const won = d.success === true || outcome === 'won' || outcome === 'win' || outcome === 'success';
  const lost = d.success === false || ['lost', 'lose', 'loss', 'fail', 'failed'].includes(outcome);
  if (['completed', 'complete', 'game_completed', 'game-completed'].includes(type)) {
    if (won) return 'won';
    if (lost) return 'lost';
  }
  if (['won', 'win', 'victory', 'success'].includes(type)) return 'won';
  if (['lost', 'loss', 'failed', 'fail'].includes(type)) return 'lost';
  return null;
}

// ── tiny SVG art ─────────────────────────────────────────────────────────────

// Perceived luminance 0..1 — picks a readable letter color on a theme fill.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Compact preview driven by the same persisted variant config as the live fork.
function board(tpl: TplId, pk: Pack): string {
  const dark = parseInt(pk.boardBg.slice(1, 3), 16) < 100;
  const cell = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.09)';
  let s = `<svg viewBox="0 0 300 170" style="display:block;width:100%"><rect width="300" height="170" fill="${pk.sceneBg}"/>`;
  if (tpl === 'sort') {
    if (pk.backgroundPattern === 'grid') {
      for (let x = 0; x < 300; x += 22) s += `<line x1="${x}" y1="0" x2="${x}" y2="170" stroke="${pk.outline}" opacity=".12"/>`;
      for (let y = 0; y < 170; y += 22) s += `<line x1="0" y1="${y}" x2="300" y2="${y}" stroke="${pk.outline}" opacity=".12"/>`;
    }
    s += `<rect x="12" y="8" width="276" height="99" rx="14" fill="${pk.boardBg}" stroke="${pk.outline}" opacity=".96"/>`;
    const source = pk.sourceShape === 'hopper'
      ? 'M55 16 L72 91 L131 104 M245 16 L228 91 L169 104 M55 16 H245'
      : pk.sourceShape === 'flask'
        ? 'M105 16 V30 L55 48 V91 L131 104 M195 16 V30 L245 48 V91 L169 104 M105 16 H195'
        : pk.sourceShape === 'silo'
          ? 'M55 29 Q150 2 245 29 V91 L169 104 M55 29 V91 L131 104'
          : 'M55 16 V91 L131 104 M245 16 V91 L169 104 M55 16 H245';
    s += `<path d="${source}" fill="none" stroke="${pk.outline}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
      const color = pk.items[(c + r) % pk.items.length], x = 78 + c * 29, y = 30 + r * 24;
      if (pk.marbleStyle === 'gem') s += `<polygon points="${x},${y - 7} ${x + 6},${y - 3} ${x + 6},${y + 4} ${x},${y + 7} ${x - 6},${y + 4} ${x - 6},${y - 3}" fill="${color}"/>`;
      else s += `<circle cx="${x}" cy="${y}" r="7" fill="${pk.marbleStyle === 'obsidian' ? '#090B0F' : color}" stroke="${pk.marbleStyle === 'obsidian' ? color : pk.outline}" stroke-width="1.3"/>`;
      if (pk.markerStyle !== 'none') s += `<circle cx="${x}" cy="${y}" r="2" fill="${pk.marbleStyle === 'obsidian' ? color : '#fff'}" opacity=".8"/>`;
    }
    const conveyor = pk.conveyorPath === 'oval'
      ? `<ellipse cx="150" cy="119" rx="103" ry="13"/>`
      : pk.conveyorPath === 'compact'
        ? `<rect x="45" y="107" width="210" height="24" rx="5"/>`
        : pk.conveyorPath === 'wave'
          ? `<path d="M45 119 C78 96 112 140 150 119 S222 96 255 119 C222 142 188 98 150 119 S78 142 45 119 Z"/>`
          : `<rect x="45" y="107" width="210" height="24" rx="12"/>`;
    s += `<g fill="${pk.belt}" stroke="${pk.outline}" stroke-width="2">${conveyor}</g>`;
    const columns = pk.difficulty === 'easy' ? 3 : pk.difficulty === 'expert' ? 5 : 4;
    const tw = columns === 5 ? 40 : 48, gap = 7, total = columns * tw + (columns - 1) * gap, start = (300 - total) / 2;
    for (let i = 0; i < columns; i++) {
      const x = start + i * (tw + gap), color = pk.items[i % pk.items.length];
      if (pk.targetShape === 'hex') s += `<polygon points="${x + 6},140 ${x + tw - 6},140 ${x + tw},150 ${x + tw - 6},160 ${x + 6},160 ${x},150" fill="${color}40" stroke="${color}"/>`;
      else if (pk.targetShape === 'bowl') s += `<path d="M${x} 142 Q${x + tw / 2} 168 ${x + tw} 142 V140 H${x}Z" fill="${color}40" stroke="${color}"/>`;
      else if (pk.targetShape === 'crystal') s += `<polygon points="${x},150 ${x + 8},140 ${x + tw - 8},140 ${x + tw},150 ${x + tw - 12},160 ${x + 12},160" fill="${color}40" stroke="${color}"/>`;
      else s += `<rect x="${x}" y="140" width="${tw}" height="20" rx="${pk.targetShape === 'jar' ? 5 : 10}" fill="${color}40" stroke="${color}"/>`;
    }
  } else if (tpl === 'merge') {
    const grid = [[1, 0, 2, -1, 0], [0, 3, -1, 1, 2], [2, -1, 4, 0, 1]];
    grid.forEach((row, r) => row.forEach((v, c) => {
      const x = 32 + c * 48, y = 38 + r * 48;
      s += `<rect x="${x - 20}" y="${y - 20}" width="40" height="40" rx="9" fill="${cell}"/>`;
      if (v >= 0) s += `<circle cx="${x}" cy="${y}" r="${9 + v * 2.4}" fill="${pk.items[v]}"/><circle cx="${x - 3}" cy="${y - 3}" r="${(9 + v * 2.4) * 0.3}" fill="#fff" opacity=".35"/>`;
    }));
  } else {
    s += `<line x1="95" y1="20" x2="95" y2="112" stroke="${pk.edge}" stroke-width="4"/>
          <line x1="205" y1="20" x2="205" y2="112" stroke="${pk.edge}" stroke-width="4"/>`;
    ([[130, 34, 0], [158, 32, 1], [144, 56, 2], [170, 58, 3], [122, 60, 4], [150, 82, 0], [132, 104, 1], [164, 104, 2]] as const)
      .forEach((b) => { s += `<circle cx="${b[0]}" cy="${b[1]}" r="12" fill="${pk.items[b[2]]}"/>`; });
    s += `<rect x="88" y="112" width="124" height="9" rx="4.5" fill="#AEB4BE" stroke="#7E848E" stroke-width="1.5"/>
          <circle cx="222" cy="116.5" r="7" fill="#7E848E"/>
          <path d="M110 138 L190 138 L182 164 L118 164 Z" fill="${cell}" stroke="${pk.edge}" stroke-width="1.6"/>`;
  }
  return s + '</svg>';
}

// ── styles (self-injected, namespaced .isl-*) ───────────────────────────────

const CSS = `
.island-world{position:absolute;top:var(--top-zone-h);left:0;right:0;bottom:var(--bar-reserve);z-index:3000;display:flex;flex-direction:column;overflow:hidden;
  background:linear-gradient(180deg,#122231 0%,#0d1118 46%,#07090f 100%);color:#fff}
.isl-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(var(--safe-top) + 12px) 14px 8px}
.isl-namebar{position:relative;flex:0 0 auto;display:flex;justify-content:center;padding:9px 54px 3px}
.isl-namebar__pill{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:5px 15px;font-size:12.5px;font-weight:700;color:rgba(255,255,255,.84)}
.isl-share{position:absolute;right:14px;top:6px;width:32px;height:32px;border:1px solid rgba(255,255,255,.14);border-radius:50%;background:rgba(0,0,0,.32);color:#fff;font:700 18px/1 system-ui;display:grid;place-items:center}
.isl-share:disabled{opacity:.45}
.isl-ava{width:38px;height:38px;border-radius:50%;background:#2E6E86;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;flex:0 0 38px}
.isl-who{flex:1;min-width:0}
.isl-eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.isl-title{font-size:16px;font-weight:800;line-height:1.25}
.isl-stat{font-size:11.5px;color:rgba(255,255,255,.6)}
.isl-wallet{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:700;color:#FFD98A;flex:0 0 auto}
.isl-level{display:flex;align-items:center;gap:4px;background:rgba(110,168,255,.14);border:1px solid rgba(110,168,255,.34);border-radius:999px;padding:6px 11px;font-size:13px;font-weight:800;color:#BBD3FF;flex:0 0 auto}
.isl-close{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:15px;flex:0 0 34px}
.isl-modes{flex:0 0 auto;display:flex;gap:8px;padding:4px 14px 10px}
.isl-mode{flex:1;font:inherit;font-size:12.5px;padding:8px 0;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.7)}
.isl-mode--on{background:rgba(255,255,255,.18);color:#fff;font-weight:700}
.isl-worldbox{flex:1;min-height:0;position:relative}
.isl-worldbox svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
.isl-worldbox svg:active{cursor:grabbing}
.isl-legend{position:absolute;left:14px;bottom:10px;display:flex;gap:12px;pointer-events:none}
.isl-legend span{display:flex;align-items:center;gap:5px;font-size:10.5px;color:rgba(255,255,255,.55)}
.isl-legend b{width:8px;height:8px;border-radius:50%;display:inline-block}
.isl-sector{cursor:pointer}
.isl-sector--new{transform-box:fill-box;transform-origin:center;animation:isl-pop .55s cubic-bezier(.2,1.4,.4,1)}
@keyframes isl-pop{from{opacity:0;transform:scale(.65)}}
.isl-plus{animation:isl-puls 2.4s ease-in-out infinite}
@keyframes isl-puls{0%,100%{opacity:.95}50%{opacity:.55}}
/* Collectible puzzle over a mechanic: a slow, smooth vertical bob. Each puck gets a
   per-slot negative animation-delay (inline) so they don't bob in unison. */
.isl-puz{transform-box:fill-box;transform-origin:center;animation:isl-wobble 2.4s ease-in-out infinite;cursor:pointer}
@keyframes isl-wobble{0%,100%{transform:translateY(-3px)}50%{transform:translateY(3px)}}
.isl-cta{position:absolute;left:14px;right:14px;bottom:calc(var(--safe-bottom) + 14px);border:none;border-radius:14px;
  padding:14px;font:inherit;font-size:15px;font-weight:800;color:#112011;background:linear-gradient(180deg,#8ff0a3,#3ccc78);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.36)}
.isl-scrim{position:absolute;inset:0;background:rgba(4,8,12,.6);opacity:0;pointer-events:none;transition:opacity .25s;z-index:5}
.isl-scrim--show{opacity:1;pointer-events:auto}
.isl-sheet{position:absolute;left:0;right:0;bottom:0;background:#141d28;border-top:1px solid rgba(255,255,255,.1);color:#fff;
  border-radius:20px 20px 0 0;padding:14px 16px calc(var(--safe-bottom) + 18px);transform:translateY(105%);
  transition:transform .32s cubic-bezier(.2,.9,.3,1);max-height:86%;overflow-y:auto;overflow-anchor:none;z-index:6}
.isl-sheet--show{transform:translateY(0)}
.isl-grab{width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:0 auto 12px}
.isl-sheet h3{margin:0 0 3px;font-size:16px;font-weight:800}
.isl-sub{font-size:12.5px;color:rgba(255,255,255,.55);margin-bottom:13px}
.isl-tcards{display:flex;flex-direction:column;gap:9px}
.isl-tcard{display:flex;gap:12px;align-items:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
  border-radius:13px;padding:9px;font:inherit;color:#fff;text-align:left}
.isl-tcard:active{transform:scale(.985)}
.isl-tcard__pv{width:92px;height:58px;border-radius:8px;overflow:hidden;flex:0 0 92px;background:rgba(255,255,255,.08)}
.isl-tcard__pv img{width:100%;height:100%;object-fit:cover;display:block}
.isl-tcard__nm{font-size:14px;font-weight:800}
.isl-tcard__ds{font-size:12px;color:rgba(255,255,255,.55);line-height:1.35}
.isl-tiers{display:grid;gap:8px}.isl-tier{display:grid;grid-template-columns:1fr auto;gap:4px 10px;text-align:left;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:11px 12px;background:rgba(255,255,255,.045);color:#fff;font:inherit}
.isl-tier b{font-size:14px}.isl-tier>span:last-child{grid-column:1/-1;font-size:11px;line-height:1.35;color:rgba(255,255,255,.58)}.isl-tier__price{grid-column:2;grid-row:1;font-size:9px;font-weight:900;color:#8FD8C2}.isl-tier:disabled{opacity:.42}
.isl-status{display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:2.5px 9px;border-radius:999px;
  border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);font-size:11px;color:rgba(255,255,255,.8);vertical-align:1px}
.isl-status b{width:7px;height:7px;border-radius:50%;display:inline-block}
.isl-status[data-pulse] b{animation:isl-puls 2.4s ease-in-out infinite}
.isl-chips{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 13px}
.isl-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);border-radius:999px;padding:7px 12px;font:inherit;font-size:12px;color:#fff}.isl-chip.on{border-color:#8FD8C2;background:rgba(76,195,138,.14)}.isl-chip i{width:9px;height:9px;border-radius:3px;display:inline-block}
.isl-in{width:100%;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 13px;font:inherit;font-size:14px;background:rgba(255,255,255,.08);color:#fff}
.isl-in--prompt{min-height:76px;line-height:1.35;resize:none}
.isl-choice{margin-top:12px}.isl-choice__label{font-size:11px;font-weight:800;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px}
.isl-seg{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
.isl-seg button{min-width:0;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.055);color:rgba(255,255,255,.65);padding:8px 2px;font:700 10.5px/1 system-ui,sans-serif}
.isl-seg button:first-child{border-radius:8px 0 0 8px}.isl-seg button:last-child{border-radius:0 8px 8px 0}
.isl-seg button.on{background:#fff;color:#101720;border-color:#fff}
.isl-seg--three{grid-template-columns:repeat(3,minmax(0,1fr))}
.isl-traits{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.isl-traits span{border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:4px 7px;font-size:10px;color:rgba(255,255,255,.72);text-transform:capitalize}
.isl-create-mode{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0 12px}
.isl-create-mode button{min-height:64px;text-align:left;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:9px 10px;background:rgba(255,255,255,.045);color:#fff;font:inherit}
.isl-create-mode button.on{border-color:#4CC38A;background:rgba(76,195,138,.12)}
.isl-create-mode b{display:block;font-size:12.5px;margin-bottom:4px}.isl-create-mode span{display:block;font-size:10.5px;line-height:1.3;color:rgba(255,255,255,.55)}
.isl-labnote{border-left:3px solid #EF9F27;background:rgba(239,159,39,.08);padding:9px 11px;margin:8px 0 11px;font-size:11.5px;line-height:1.4;color:rgba(255,255,255,.74)}
.isl-concepts{display:grid;gap:7px;margin:10px 0}.isl-concept{width:100%;text-align:left;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:10px 11px;background:rgba(255,255,255,.045);color:#fff;font:inherit}
.isl-concept:active{transform:scale(.992)}.isl-concept__head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:800}.isl-concept__risk{font-size:9px;text-transform:uppercase;color:#F2B33D}
.isl-concept__feeling{font-size:11px;color:#8FD8C2;margin-top:4px}.isl-concept__pitch{font-size:11.5px;line-height:1.38;color:rgba(255,255,255,.66);margin-top:5px}
.isl-candidates{display:grid;gap:8px}.isl-candidate{width:100%;display:block;text-align:left;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:0 0 10px;overflow:hidden;background:rgba(255,255,255,.045);color:#fff}.isl-candidate--ready{border-color:rgba(143,216,194,.48)}.isl-candidate[role=button]{cursor:pointer}.isl-candidate[role=button]:focus-visible{outline:2px solid #8FD8C2;outline-offset:2px}.isl-candidate__media{position:relative;height:112px;overflow:hidden;background:#090d12}.isl-candidate__media--capture{height:168px}.isl-candidate__media svg{width:100%;height:100%;object-fit:cover}.isl-candidate__media--pending{display:flex;align-items:center;justify-content:center;gap:7px}.isl-candidate__media--pending b{width:7px;height:7px;border-radius:50%;background:#EF9F27;animation:isl-puls 1.2s ease-in-out infinite}.isl-candidate__media--pending b:nth-child(2){animation-delay:.18s}.isl-candidate__media--pending b:nth-child(3){animation-delay:.36s}.isl-candidate__media [data-real-cover],.isl-board [data-real-cover]{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover;background:#090d12}.isl-candidate__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px 0}.isl-candidate__head>span{display:flex;align-items:center;gap:7px}.isl-candidate__head em{font-style:normal;font-size:8px;font-weight:900;color:#8FD8C2;border:1px solid rgba(143,216,194,.35);padding:3px 5px;border-radius:4px}.isl-candidate__head b{font-size:12.5px}.isl-candidate__head>i{font-style:normal;font-size:8px;font-weight:900;color:#F2B33D;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.isl-candidate__detail{display:block;padding:6px 11px 0;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.58)}.isl-candidate__actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:9px 11px 0}.isl-candidate__actions--three{grid-template-columns:repeat(3,minmax(0,1fr))}.isl-candidate__actions button{min-width:0;min-height:34px;border:1px solid rgba(255,255,255,.16);border-radius:7px;background:rgba(255,255,255,.07);color:#fff;font:800 11px/1 system-ui,sans-serif}.isl-candidate__actions button[data-keep]{background:#fff;color:#101720;border-color:#fff}.isl-candidate__result{color:#8FD8C2}.isl-progressmeta{display:flex;justify-content:space-between;gap:12px;margin:10px 0;font-size:11px;color:rgba(255,255,255,.62)}.isl-progressmeta b{color:#fff}.isl-progresslog{max-height:148px;overflow:auto;border-top:1px solid rgba(255,255,255,.1);padding-top:8px;margin-top:10px}.isl-progresslog div{font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.56);margin-bottom:5px}.isl-progresslog b{color:#8FD8C2;font-weight:800}
.isl-thread{display:flex;flex-direction:column;gap:7px;max-height:112px;overflow:auto;margin:10px 0 4px;padding:9px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(7,9,15,.34)}.isl-msg{max-width:88%;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.08);font-size:11.5px;line-height:1.38;color:rgba(255,255,255,.78)}.isl-msg--player{align-self:flex-end;background:rgba(76,195,138,.18);color:#fff}.isl-msg--system{align-self:center;max-width:96%;background:rgba(239,159,39,.1);color:#F4C36E}.isl-msg b{display:block;margin-bottom:2px;font-size:9px;text-transform:uppercase;color:#8FD8C2}.isl-msg--player b{color:#A9E8C8}.isl-msg--system b{color:#F4C36E}
.isl-lablog{list-style:none;margin:12px 0 6px;padding:0;display:flex;flex-direction:column;gap:7px;min-height:112px}.isl-lablog li{display:flex;gap:8px;font-size:11.5px;line-height:1.35;color:rgba(255,255,255,.55)}.isl-lablog li:last-child{color:#fff}.isl-lablog b{width:7px;height:7px;margin-top:4px;border-radius:50%;background:#EF9F27;flex:0 0 7px}.isl-lablog li.ok b{background:#4CC38A}.isl-lablog li.fail b{background:#E24B4A}
.isl-labframe{display:block;width:100%;height:min(46vh,360px);border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#000;margin:7px 0 9px}
.isl-in::placeholder{color:rgba(255,255,255,.35)}
.isl-btn{width:100%;border:none;border-radius:13px;padding:13px;font:inherit;font-size:14.5px;font-weight:800;margin-top:8px}
.isl-btn--pri{background:linear-gradient(180deg,#8ff0a3,#3ccc78);color:#112011;box-shadow:inset 0 1px 0 rgba(255,255,255,.36)}
.isl-btn--ghost{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);color:#fff}
.isl-btn:disabled{opacity:.4}
.isl-gensteps{list-style:none;margin:14px 0 8px;padding:0;display:flex;flex-direction:column;gap:10px;min-height:108px}
.isl-gensteps li{font-size:13px;color:rgba(255,255,255,.45);opacity:0;transition:opacity .4s;display:flex;gap:9px;align-items:center}
.isl-gensteps li.done{opacity:1;color:#fff}
.isl-gensteps .d{width:8px;height:8px;border-radius:50%;background:#3ccc78;flex:0 0 8px}
.isl-swrow{display:flex;gap:8px;margin:8px 0 4px;min-height:28px}
.isl-sw{width:26px;height:26px;border-radius:8px;opacity:0;transform:scale(.5);transition:all .35s}
.isl-sw--in{opacity:1;transform:scale(1)}
.isl-board{position:relative;border-radius:13px;overflow:hidden;border:1px solid rgba(255,255,255,.14);margin:4px 0 9px}.isl-board--capture{height:168px;background:#090d12}.isl-board--capture svg{width:100%;height:100%;object-fit:cover}
.isl-pk{font-size:12.5px;color:rgba(255,255,255,.55)}
.isl-pk b{color:#fff}
.isl-play{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:var(--platform-bg)}
.isl-play__head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(var(--safe-top) + 10px) 14px 8px}
.isl-play__nm{flex:1;font-size:14px;font-weight:800}
.isl-dbg{flex:0 0 auto;font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);
  border:1px solid rgba(255,255,255,.16);color:#9DC3CE;border-radius:8px;padding:5px 8px;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isl-dbglog{position:absolute;left:10px;right:10px;bottom:calc(var(--safe-bottom) + 12px);max-height:46%;overflow-y:auto;
  background:rgba(7,12,18,.94);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;
  font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#B8D2DC;white-space:pre-wrap;z-index:10}
.isl-play iframe{flex:1;min-height:0;width:100%;border:0;background:#000}
.isl-win{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  background:rgba(7,9,15,.88);text-align:center;padding:24px}
.isl-win__t{font-size:20px;font-weight:800}
.isl-win__m{font-size:13px;color:rgba(255,255,255,.6)}
.isl-like{border:2px solid #E8603C;background:transparent;color:#fff;border-radius:999px;padding:11px 22px;font:inherit;font-size:14.5px}
.isl-like--on{background:#E8603C;font-weight:800}
.isl-win__home{background:#fff;color:#10222C;border:none;border-radius:13px;padding:12px 30px;font:inherit;font-size:14.5px;font-weight:800}
/* "someone played my mechanic" — pinned to the TOP of the view (just under the feed
   HUD), sliding down from above; never blocks the mechanic/map below. */
.isl-toast{position:absolute;top:44px;left:50%;transform:translate(-50%,-24px);opacity:0;
  background:rgba(255,255,255,.95);color:#10222C;border-radius:12px;padding:9px 16px;font-size:12.5px;font-weight:600;
  transition:transform .3s,opacity .3s;max-width:86%;text-align:center;z-index:10;pointer-events:none;
  box-shadow:0 8px 22px rgba(0,0,0,.32)}
.isl-toast--show{transform:translate(-50%,0);opacity:1}
@media (prefers-reduced-motion: reduce){.island-world *{animation:none!important;transition:none!important}}
`;

function ensureStyles(): void {
  if (document.querySelector('style[data-island-proto]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-island-proto', '');
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ── overlay ──────────────────────────────────────────────────────────────────

export function renderIslandWorld(ov: HTMLElement, ctx: IslandHostCtx): void {
  ensureStyles();
  const publicIsland = ctx.publicIsland;
  const guest = Boolean(publicIsland);
  const S: IslandState = publicIsland
    ? {
        tokens: 0,
        buildings: publicIsland.buildings.map((building) => ({ ...building })),
        ...(publicIsland.aiPacks
          ? { aiPacks: Object.fromEntries(Object.entries(publicIsland.aiPacks).map(([id, pack]) => [id, { ...pack }])) }
          : {}),
      }
    : loadIslandState();
  if (!guest && ctx.puzzles) S.tokens = Math.max(0, ctx.puzzles());
  // Local presentation sim (owner island only): puzzles pile up over the player's
  // own mechanics from simulated plays. The FEED drives the loop; here we just read
  // it to render + collect, and refresh when it fires. Guest/public islands ignore it.
  let sim = loadIslandSim();
  const onSimTick = () => {
    if (!ov.isConnected) { window.removeEventListener(ISLAND_SIM_EVENT, onSimTick); return; }
    if (!guest) refreshIsland();
  };
  if (!guest) window.addEventListener(ISLAND_SIM_EVENT, onSimTick);
  const localExperiments: LocalExperimentState = guest
    ? { buildings: [], packs: {}, threads: {} }
    : loadLocalExperiments();
  // One-time migration from the first lab prototype, which stored local-only
  // buildings in the shared island cache. Pull them into the isolated overlay
  // before IslandStateSync can observe or upload that cache.
  const legacyLocalBuildings = guest ? [] : S.buildings.filter(isLocalExperiment);
  if (legacyLocalBuildings.length) {
    const bySlot = new Map(localExperiments.buildings.map((building) => [building.slot, building]));
    legacyLocalBuildings.forEach((building) => {
      bySlot.set(building.slot, building);
      const pack = S.aiPacks?.[building.pack];
      if (pack) localExperiments.packs[building.pack] = normalizePack(pack);
    });
    localExperiments.buildings = [...bySlot.values()];
    S.buildings = S.buildings.filter((building) => !isLocalExperiment(building));
    if (S.aiPacks) {
      for (const building of legacyLocalBuildings) {
        if (!S.buildings.some((candidate) => candidate.pack === building.pack)) delete S.aiPacks[building.pack];
      }
      if (!Object.keys(S.aiPacks).length) delete S.aiPacks;
    }
    saveLocalExperiments(localExperiments);
    cacheIslandState(S);
  }
  let cur: CreationDraft | null = null;
  let toastTimer = 0;
  let progressTimer = 0;
  let generationSeq = 0;
  const generationBySlot = new Map<number, number>();
  const readyDrafts = new Map<number, CreationDraft>();
  const pollingSlots = new Set<number>();
  const pendingPhaseBySlot = new Map<number, string>();
  let stateSync: IslandStateSync | null = null;

  const visibleBuildings = (): Building[] => {
    const bySlot = new Map<number, Building>(S.buildings.map((building) => [building.slot, building]));
    localExperiments.buildings.forEach((building) => bySlot.set(building.slot, building));
    return [...bySlot.values()]
      .filter((building) => !guest || !isLocalExperiment(building) || building.autoplayPassed === true)
      .sort((a, b) => a.slot - b.slot);
  };
  const editableExperimentId = (building: Building): string | null => {
    const localId = experimentArtifactId(building);
    if (localId) return localId;
    const hostedId = hostedExperimentArtifactId(building);
    return hostedId && localExperiments.threads[String(building.slot)]?.placedExperimentId === hostedId
      ? hostedId
      : null;
  };
  const bindRealCoverFallback = (): void => {
    sheet.querySelectorAll<HTMLImageElement>('[data-real-cover]').forEach((image) => {
      image.addEventListener('error', () => image.remove(), { once: true });
    });
  };
  const persistLocalExperiments = () => saveLocalExperiments(localExperiments);
  const pendingPhase = (value: string): string => {
    const phase = value.toLowerCase();
    if (/queue|wait|start|reconnect/.test(phase)) return 'queued';
    if (/concept/.test(phase)) return 'concepts';
    if (/agent|repair|fork|mutat|heartbeat/.test(phase)) return 'coding';
    if (/safety|typecheck|build|allowlist/.test(phase)) return 'checking';
    if (/conformance|test|autoplay/.test(phase)) return 'playtesting';
    if (/publish|save|ready/.test(phase)) return 'finalizing';
    if (/api|theme|guided/.test(phase)) return 'theme AI';
    return 'generating';
  };
  const setPendingPhase = (slot: number, value: string): void => {
    const next = pendingPhase(value);
    if (pendingPhaseBySlot.get(slot) === next) return;
    pendingPhaseBySlot.set(slot, next);
    if (ov.isConnected) refreshIsland(false);
  };
  const removeLocalExperiment = (slot: number) => {
    const removed = localExperiments.buildings.find((building) => building.slot === slot);
    if (!removed) return;
    localExperiments.buildings = localExperiments.buildings.filter((building) => building.slot !== slot);
    if (!localExperiments.buildings.some((building) => building.pack === removed.pack)) delete localExperiments.packs[removed.pack];
    delete localExperiments.threads[String(slot)];
    persistLocalExperiments();
  };
  const resolvePack = (id: string): Pack => normalizePack(
    PACKS.find((x) => x.id === id) ?? localExperiments.packs[id] ?? S.aiPacks?.[id] ?? PACKS[0],
  );
  const addExperimentMessage = (
    req: CreationDraft,
    role: ExperimentMessage['role'],
    text: string,
    experimentId?: string,
  ): void => {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!clean) return;
    req.messages = [...(req.messages ?? []), {
      role,
      text: clean,
      at: new Date().toISOString(),
      ...(experimentId ? { experimentId } : {}),
    }].slice(-24);
  };
  const recordAgentResult = (req: CreationDraft, result: ExperimentResult): void => {
    if (req.messages?.some((message) => message.role === 'agent' && message.experimentId === result.id)) return;
    addExperimentMessage(req, 'agent', result.agentSummary || result.pitch || `Version “${result.title}” is ready.`, result.id);
  };
  const persistDraftThread = (req: CreationDraft, explicitPlacedExperimentId?: string): void => {
    if (!req.concept || !req.experiment) return;
    const placedBuilding = localExperiments.buildings.find((building) => building.slot === req.slot);
    const placedLocalExperimentId = placedBuilding ? localExperimentId(placedBuilding) : null;
    localExperiments.threads[String(req.slot)] = {
      placedExperimentId: explicitPlacedExperimentId || placedLocalExperimentId
        || localExperiments.threads[String(req.slot)]?.placedExperimentId || req.experiment.id,
      provider: req.provider,
      prompt: req.prompt,
      concept: req.concept,
      experiment: req.experiment,
      experimentJobId: req.experimentJobId,
      messages: restoreExperimentMessages(req.messages),
      updatedAt: new Date().toISOString(),
    };
    persistLocalExperiments();
  };
  const draftFromLocalThread = (building: Building, thread: LocalExperimentThread): CreationDraft => {
    const pack = resolvePack(building.pack);
    return {
      slot: building.slot,
      tpl: building.tpl,
      mode: 'wild',
      tier: 'expensive',
      provider: thread.provider,
      prompt: thread.prompt,
      pack,
      presetId: 'surprise',
      rerolls: 1,
      difficulty: pack.difficulty,
      motion: pack.motion,
      ai: true,
      concept: thread.concept,
      experiment: thread.experiment,
      experimentJobId: thread.experimentJobId,
      messages: [...thread.messages],
      sourceLocalSlot: building.slot,
    };
  };
  const openLocalExperimentEditor = async (building: Building): Promise<void> => {
    const id = editableExperimentId(building);
    if (!id) { toast('Local experiment lineage is missing'); return; }
    let thread = localExperiments.threads[String(building.slot)];
    if (!thread || thread.placedExperimentId !== id) {
      try {
        const jobs = await generatorJobs<ExperimentResult>();
        const job = jobs.find((candidate) => candidate.type === 'experiment' && candidate.result?.id === id);
        const concept = restoreExperimentConcept(job?.request?.concept);
        const experiment = restoreExperimentResult(job?.result);
        if (!job || !concept || !experiment) throw new Error('The original local job is no longer in generator history');
        const requestedProvider = job.request?.provider;
        thread = {
          placedExperimentId: id,
          provider: requestedProvider === 'claude' || requestedProvider === 'codex' ? requestedProvider : 'auto',
          prompt: String(job.request?.prompt || experiment.prompt || '').slice(0, 500),
          concept,
          experiment,
          experimentJobId: job.id,
          messages: [],
          updatedAt: new Date().toISOString(),
        };
        localExperiments.threads[String(building.slot)] = thread;
      } catch (error) {
        openSheet(`<h3>Lineage unavailable</h3><div class="isl-sub">${esc(errorText(error))}</div>
          <button class="isl-btn isl-btn--ghost" type="button" data-back-building>Back to mechanic</button>`);
        sheet.querySelector('[data-back-building]')?.addEventListener('click', () => openBuilding(building.slot, true));
        return;
      }
    }
    const req = draftFromLocalThread(building, thread);
    recordAgentResult(req, req.experiment!);
    cur = req;
    persistDraftThread(req);
    stepExperimentPreview();
  };

  // Slots with a generation job in flight. Generation never auto-builds: the
  // player returns, plays the candidates, and explicitly keeps one. Wild jobs
  // are durable in swipe-generator and reconnect after page/Vite restarts.
  const pendingSlots = new Set<number>();

  // Bake-on-confirm: after a mechanic is BUILT, ship it through the production
  // pipeline (bake → autoplay test → publish to swipe-ugc → per-player bot
  // message; the player's chat id comes from the mini-app initData). On success
  // the building switches from the canonical stock fallback to the hosted build.
  async function bakeAndHost(slot: number, prompt: string): Promise<void> {
    const b = S.buildings.find((x) => x.slot === slot);
    if (!b || b.tpl !== 'sort' || hostedUrl(b) || pollingSlots.has(slot)) return;
    pollingSlots.add(slot);
    const packRef = b.pack;
    b.prompt = prompt;
    b.publishing = true;
    b.publishError = undefined;
    save();
    refreshIsland();
    const chat = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } } })
      .Telegram?.WebApp?.initDataUnsafe?.user?.id;
    let terminalFailure = false;
    try {
      let job: IslandBakeJob;
      try {
        if (!b.jobId) {
          b.jobId = newJobId();
          save();
          job = await apiIslandBake({ request_id: b.jobId, pack: resolvePack(packRef), prompt, tpl: 'sort' });
        } else {
          try {
            job = await apiIslandBakeJob(b.jobId);
          } catch (error) {
            // A local snapshot may outlive a bake request that never reached the
            // backend (WebView closed mid-flight). Replace only a missing job;
            // all real job failures keep their idempotent request id.
            if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
            b.jobId = newJobId();
            save();
            job = await apiIslandBake({ request_id: b.jobId, pack: resolvePack(packRef), prompt, tpl: 'sort' });
          }
        }
      } catch (e) {
        if (!IS_DEV) throw e;
        console.log('[island] backend bake unavailable in dev:', errorText(e), '→ Vite worker fallback');
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 300000);
        const res = await fetch('/island-api/bake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pack: resolvePack(packRef), prompt, chat }),
          signal: ctrl.signal,
        });
        window.clearTimeout(timer);
        const data = (await res.json()) as { rel?: string; url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(String(data.error ?? `HTTP ${res.status}`));
        job = { job_id: b.jobId ?? '', status: 'ready', rel: data.rel ?? '', url: data.url, error: '', ready: true };
      }

      let pollErrors = 0;
      for (let attempt = 0; !['ready', 'published', 'failed'].includes(job.status); attempt++) {
        if (attempt >= 180) {
          if (ov.isConnected) toast('Publishing continues in background');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const current = S.buildings.find((x) => x.slot === slot);
        if (!current || current.pack !== packRef || !current.jobId) return;
        try {
          job = await apiIslandBakeJob(current.jobId);
          pollErrors = 0;
        } catch (e) {
          if (++pollErrors < 4) continue;
          throw e;
        }
      }
      if (job.status === 'failed') {
        terminalFailure = true;
        throw new Error(job.error || 'Bake job failed');
      }
      if (!job.url || !job.rel) throw new Error('Backend published no hosted URL; check UGC_BASE_URL');
      const now = S.buildings.find((x) => x.slot === slot);
      if (!now || now.pack !== packRef) return;   // slot was rebuilt meanwhile
      now.rel = job.rel;
      now.url = undefined;
      now.publishing = false;
      now.publishError = undefined;
      save();
      refreshIsland();
      console.log('[island] hosted:', job.url, job.ready ? '(ready)' : '(deploy pending)');
      if (ov.isConnected) toast(job.ready ? 'Published to hosting ✅' : 'Published; hosting is warming up');
    } catch (e) {
      const message = errorText(e);
      const now = S.buildings.find((x) => x.slot === slot);
      if (now && now.pack === packRef) {
        now.publishing = false;
        now.publishError = message;
        if (terminalFailure) now.jobId = undefined;
        save();
        refreshIsland();
      }
      console.error('[island] publish failed:', message);
      if (ov.isConnected) toast(`Publish failed · ${message}`);
    } finally {
      pollingSlots.delete(slot);
    }
  }

  const save = () => {
    if (guest) return;
    if (stateSync) stateSync.changed();
    else cacheIslandState(S);
  };

  function resumePendingBakes(): void {
    S.buildings
      .filter((building) => building.tpl === 'sort' && Boolean(building.jobId) && !hostedUrl(building))
      .forEach((building) => { void bakeAndHost(building.slot, building.prompt ?? ''); });
  }

  if (!guest) {
    stateSync = new IslandStateSync({
      read: () => S,
      apply: (state) => {
        replaceIslandState(S, state);
        refreshIsland(false);
        cacheIslandState(S);
      },
      onHydrated: resumePendingBakes,
    });
  }

  const islandLabel = publicIsland
    ? `${publicIsland.owner.first_name || (publicIsland.owner.username ? `@${publicIsland.owner.username}` : 'Player')}'s Island`
    : 'My Island';

  ov.innerHTML =
    // The top HUD (level + puzzle counter) and the bottom nav bar are the feed's —
    // they stay put across views. The island only labels itself on a small backing.
    `<div class="isl-namebar"><span class="isl-namebar__pill">🏝️ ${esc(islandLabel)}</span>${guest ? '' : '<button class="isl-share" type="button" data-share-island aria-label="Share island" title="Share island">↗</button>'}</div>` +
    '<div class="isl-worldbox"><svg viewBox="0 0 390 540" preserveAspectRatio="xMidYMid slice"></svg><div class="isl-legend" data-legend></div></div>' +
    `<button class="isl-cta" type="button" data-guest-cta${guest ? '' : ' hidden'}>Play a series here</button>` +
    '<div class="isl-scrim" data-scrim></div>' +
    '<div class="isl-sheet" data-sheet></div>' +
    '<div class="isl-toast" data-toast></div>';

  const svg = ov.querySelector('svg') as unknown as SVGSVGElement;
  const sheet = ov.querySelector('[data-sheet]') as HTMLElement;
  const scrim = ov.querySelector('[data-scrim]') as HTMLElement;

  // ── Finger-pan + pinch-zoom the map (with a little pan inertia) ──────────
  // All world content lives in a `[data-pan]` group transformed by
  // `scale(zoom) translate(-panX,-panY)`. One finger pans (momentum on release);
  // two fingers pinch-zoom around their midpoint. panMoved guards tap-through.
  let panX = 0, panY = 0, zoom = 1, panMoved = false;
  const Z_MIN = 0.62, Z_MAX = 2.2;
  {
    const pts = new Map<number, { x: number; y: number }>();
    let mode: 'idle' | 'pan' | 'pinch' = 'idle';
    let sx = 0, sy = 0, px0 = 0, py0 = 0;                       // pan baseline
    let pinchD0 = 1, pinchZ0 = 1, pinchWX = 0, pinchWY = 0;     // pinch baseline
    let vX = 0, vY = 0, lastT = 0, raf = 0;                     // inertia

    const disp = () => { const r = svg.getBoundingClientRect(); return { r, s: Math.max(r.width / VIEW_W, r.height / VIEW_H) || 1 }; };
    const clientToView = (cx: number, cy: number) => {
      const { r, s } = disp();
      return { vx: (cx - r.left - (r.width - VIEW_W * s) / 2) / s, vy: (cy - r.top - (r.height - VIEW_H * s) / 2) / s };
    };
    const clamp = () => {
      const maxX = WORLD_W - VIEW_W / zoom, maxY = WORLD_H - VIEW_H / zoom;
      panX = maxX <= 0 ? maxX / 2 : Math.max(0, Math.min(maxX, panX));
      panY = maxY <= 0 ? maxY / 2 : Math.max(0, Math.min(maxY, panY));
    };
    const apply = () => {
      const g = svg.querySelector('[data-pan]');
      if (g) g.setAttribute('transform', `scale(${zoom.toFixed(3)}) translate(${(-panX).toFixed(1)},${(-panY).toFixed(1)})`);
    };
    const mid = () => { const a = [...pts.values()]; return a.length >= 2 ? { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 } : { x: a[0]?.x || 0, y: a[0]?.y || 0 }; };
    const spread = () => { const a = [...pts.values()]; return a.length >= 2 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0; };
    const stopInertia = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

    const startPan = () => { mode = 'pan'; const m = mid(); sx = m.x; sy = m.y; px0 = panX; py0 = panY; vX = 0; vY = 0; lastT = performance.now(); };
    const startPinch = () => {
      mode = 'pinch'; pinchD0 = spread() || 1; pinchZ0 = zoom;
      const v = clientToView(mid().x, mid().y);
      pinchWX = v.vx / zoom + panX; pinchWY = v.vy / zoom + panY;   // world point under the midpoint
    };

    svg.addEventListener('pointerdown', (e) => {
      stopInertia();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture(e.pointerId); } catch { /* noop */ }
      panMoved = false;
      if (pts.size === 1) startPan();
      else if (pts.size === 2) startPinch();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        zoom = Math.max(Z_MIN, Math.min(Z_MAX, pinchZ0 * (spread() / pinchD0)));
        const v = clientToView(mid().x, mid().y);
        panX = pinchWX - v.vx / zoom; panY = pinchWY - v.vy / zoom;   // keep the pinch point put
        clamp(); apply(); panMoved = true;
      } else if (mode === 'pan') {
        const m = mid(), { s } = disp(), now = performance.now(), dt = Math.max(1, now - lastT);
        const nx = px0 - (m.x - sx) / (s * zoom), ny = py0 - (m.y - sy) / (s * zoom);
        vX = (nx - panX) / dt; vY = (ny - panY) / dt;
        panX = nx; panY = ny; clamp(); apply(); lastT = now;
        if (Math.abs(m.x - sx) + Math.abs(m.y - sy) > 6) panMoved = true;
      }
    });
    const onUp = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const wasPan = mode === 'pan';
      pts.delete(e.pointerId);
      try { svg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      if (pts.size === 1) { startPan(); return; }   // dropped a pinch finger → keep panning with the other
      if (pts.size === 0) {
        mode = 'idle';
        if (wasPan && (Math.abs(vX) > 0.02 || Math.abs(vY) > 0.02)) {
          let last = performance.now();
          const step = () => {
            const now = performance.now(), dt = now - last; last = now;
            panX += vX * dt; panY += vY * dt;
            const f = Math.pow(0.93, dt / 16); vX *= f; vY *= f;      // friction → small glide
            const bx = panX, by = panY; clamp();
            if (panX !== bx) vX = 0; if (panY !== by) vY = 0;         // hit an edge → stop that axis
            apply();
            raf = (Math.abs(vX) > 0.004 || Math.abs(vY) > 0.004) ? requestAnimationFrame(step) : 0;
          };
          raf = requestAnimationFrame(step);
        }
      }
    };
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
  }

  // Toasts sit at the BOTTOM (the top slides under the phone notch) and fade
  // in place instead of flying off-screen. Long error details are truncated —
  // the full text lives on the building card (publishError) and in the console —
  // and the display time scales with length so it's actually readable.
  const toast = (t: string) => {
    const el = ov.querySelector('[data-toast]') as HTMLElement;
    el.textContent = t.length > 140 ? `${t.slice(0, 140)}…` : t;
    el.classList.add('isl-toast--show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('isl-toast--show'), Math.min(8000, Math.max(2400, t.length * 45)));
  };

  const openSheet = (html: string) => {
    window.clearInterval(progressTimer);
    progressTimer = 0;
    delete sheet.dataset.publishRun;
    sheet.innerHTML = '<div class="isl-grab"></div>' + html;
    sheet.classList.add('isl-sheet--show');
    sheet.scrollTop = 0;
    window.requestAnimationFrame(() => {
      if (sheet.classList.contains('isl-sheet--show')) sheet.scrollTop = 0;
    });
    scrim.classList.add('isl-scrim--show');
  };
  const closeSheet = () => {
    window.clearInterval(progressTimer);
    progressTimer = 0;
    sheet.classList.remove('isl-sheet--show');
    scrim.classList.remove('isl-scrim--show');
  };
  scrim.addEventListener('click', closeSheet);

  function refreshIsland(persist = false): void {
    if (!guest) sim = loadIslandSim();   // the feed loop may have accrued new puzzle pucks since last render
    // Blueprint scheme (design variant B): dot grid, thin island outline,
    // central hub with connectors, slots as theme-filled circles with the
    // template initial. Status lives in rim DOTS (legend at the bottom);
    // detailed status chips stay on the building card. Future art reskins
    // these exact coordinates.
    let s =
      '<defs><pattern id="isl-dots" width="20" height="20" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.5" cy="1.5" r="1.1" fill="rgba(255,255,255,.10)"/></pattern></defs>' +
      // All world content lives in this pan group (pan/zoom driven by the drag handler).
      `<g data-pan transform="scale(${zoom.toFixed(3)}) translate(${(-panX).toFixed(1)},${(-panY).toFixed(1)})">` +
      `<rect width="${WORLD_W}" height="${WORLD_H}" fill="url(#isl-dots)"/>`;
    // Connectors from the hub to the UNLOCKED slots only.
    for (let i = 0; i < UNLOCKED_SLOTS; i++) {
      const p = SLOTS[i];
      const dx = p.x - HUB.x, dy = p.y - HUB.y, len = Math.hypot(dx, dy) || 1;
      const x1 = HUB.x + (dx / len) * 24, y1 = HUB.y + (dy / len) * 24;
      const x2 = p.x - (dx / len) * 42, y2 = p.y - (dy / len) * 42;
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,.14)" stroke-width="1"/>`;
    }
    s += `<circle cx="${HUB.x}" cy="${HUB.y}" r="22" fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.30)" stroke-width="1.2"/>
      <text x="${HUB.x}" y="${HUB.y + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="rgba(255,255,255,.85)">G</text>`;
    const buildings = visibleBuildings();
    let localFreshChanged = false;
    SLOTS.forEach((p, i) => {
      if (i >= UNLOCKED_SLOTS) {
        // Locked slot — decorative for now (tap → toast).
        s += `<g class="isl-lock" data-lock="${i}">` +
          `<circle cx="${p.x}" cy="${p.y}" r="40" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.16)" stroke-width="1.4" stroke-dasharray="3 5"/>` +
          `<text x="${p.x}" y="${p.y + 11}" text-anchor="middle" font-size="30" fill="rgba(255,255,255,.4)">🔒</text></g>`;
        return;
      }
      const b = buildings.find((x) => x.slot === i);
      if (!b) {
        if (pendingSlots.has(i)) {
          const phase = pendingPhaseBySlot.get(i) || pendingPhase(readyDrafts.get(i)?.candidates?.find((candidate) => candidate.state === 'generating')?.phase || 'generating');
          const color = phase === 'playtesting' ? '#4CC38A' : phase === 'coding' ? '#58A6FF' : phase === 'checking' ? '#C4A7E7' : '#EF9F27';
          s += `<g class="isl-sector" data-slot="${i}"><circle cx="${p.x}" cy="${p.y}" r="40" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-width="1.4" stroke-dasharray="5 5" class="isl-plus"/>
            <text x="${p.x}" y="${p.y + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="${color}">…</text>
            <text x="${p.x}" y="${p.y + 58}" text-anchor="middle" font-size="10.5" fill="${color}">${phase}</text></g>`;
        } else if (readyDrafts.has(i) && !guest) {
          const draft = readyDrafts.get(i)!;
          s += `<g class="isl-sector" data-slot="${i}">
            <circle cx="${p.x}" cy="${p.y}" r="40" fill="${draft.pack.ground}" fill-opacity=".5" stroke="${draft.pack.edge}" stroke-width="1.5" stroke-dasharray="4 4"/>
            <text x="${p.x}" y="${p.y + 7}" text-anchor="middle" font-size="18" font-weight="700" fill="rgba(255,255,255,.9)">${TPL[draft.tpl].label.charAt(0)}</text>
            <text x="${p.x}" y="${p.y + 58}" text-anchor="middle" font-size="10.5" fill="rgba(255,255,255,.75)">theme ready</text></g>`;
        } else if (!guest) {
          s += `<g class="isl-sector" data-slot="${i}">
            <circle cx="${p.x}" cy="${p.y}" r="40" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.35)" stroke-width="1.4" stroke-dasharray="6 6"/>
            <text x="${p.x}" y="${p.y + 9}" text-anchor="middle" font-size="26" font-weight="600" fill="rgba(255,255,255,.7)" class="isl-plus">+</text>
            <text x="${p.x}" y="${p.y + 58}" text-anchor="middle" font-size="10.5" fill="rgba(255,255,255,.45)">build</text></g>`;
        } else {
          s += `<circle cx="${p.x}" cy="${p.y}" r="40" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.2" stroke-dasharray="6 6"/>`;
        }
        return;
      }
      const pk = resolvePack(b.pack);
      // The publish chain keeps running after the building appears — the slot
      // reads as busy (dashed rim + pulsing amber dot); rebuild/delete stay
      // blocked in the building card until it finishes.
      const busy = Boolean(b.publishing) || pollingSlots.has(i) || pendingSlots.has(i);
      const letterFill = luminance(pk.ground) > 0.55 ? '#1F1E1B' : '#FFFFFF';
      s += `<g class="isl-sector${b.fresh ? ' isl-sector--new' : ''}" data-b="${i}">
        <circle cx="${p.x}" cy="${p.y}" r="40" fill="${pk.ground}" stroke="${pk.edge}" stroke-width="1.6"${busy ? ' stroke-dasharray="5 5"' : ''}/>
        <text x="${p.x}" y="${p.y + 7}" text-anchor="middle" font-size="19" font-weight="700" fill="${letterFill}">${TPL[b.tpl].label.charAt(0)}</text>`;
      const dot = busy ? '#EF9F27' : b.publishError ? '#E24B4A' : isLocalExperiment(b) ? '#58A6FF' : hostedUrl(b) ? '#4CC38A' : null;
      if (dot) {
        s += `<circle cx="${p.x + 29}" cy="${p.y - 29}" r="6.5" fill="${dot}" stroke="rgba(13,17,24,.9)" stroke-width="2"${busy ? ' class="isl-plus"' : ''}/>`;
      }
      s += `<rect x="${p.x - 56}" y="${p.y + 48}" width="112" height="18" rx="9" fill="rgba(255,255,255,.92)"/>
        <text x="${p.x}" y="${p.y + 61}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#26241F">${esc(b.name)}</text>
        <text x="${p.x}" y="${p.y + 82}" text-anchor="middle" font-size="10" font-weight="600" fill="rgba(255,255,255,.64)">▶ ${fmtNum(b.plays)}   ♥ ${fmtNum(b.likes)}</text></g>`;
      // Uncollected puzzles earned from simulated plays — a gently bobbing token over
      // the mechanic; tap to collect (scatter → fly into the counter). Owner only.
      // A per-slot negative animation-delay desyncs the bob so they don't move in unison.
      const rew = guest ? 0 : (sim.reward[i] || 0);
      if (rew > 0) {
        const px = p.x, py = p.y - 52;
        const delay = -((i * 0.67) % 2.4).toFixed(2);   // desync the bob per slot (period = 2.4s, see .isl-puz)
        s += `<g class="isl-puz" data-collect="${i}" style="animation-delay:${delay}s">` +
          `<circle cx="${px}" cy="${py}" r="15.5" fill="rgba(58,42,102,.97)" stroke="#fff" stroke-width="1.6"/>` +
          `<text x="${px}" y="${py + 5.5}" text-anchor="middle" font-size="16">🧩</text>` +
          `<circle cx="${px + 13}" cy="${py - 11}" r="8" fill="#4CC38A" stroke="rgba(13,17,24,.9)" stroke-width="1.5"/>` +
          `<text x="${px + 13}" y="${py - 7.6}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#08210F">${rew}</text>` +
          '</g>';
      }
      if (b.fresh) {
        b.fresh = false;
        if (isLocalExperiment(b)) localFreshChanged = true;
      }
    });
    s += '</g>';   // close the pan group
    svg.innerHTML = s;
    // Status legend — owner mode only (the guest CTA occupies the bottom edge).
    const legend = ov.querySelector('[data-legend]') as HTMLElement;
    legend.innerHTML = guest ? '' :
      '<span><b style="background:#4CC38A"></b>hosted</span>' +
      (IS_DEV ? '<span><b style="background:#58A6FF"></b>local lab</span>' : '') +
      '<span><b style="background:#EF9F27"></b>publishing</span>' +
      '<span><b style="background:#E24B4A"></b>error</span>';
    // A drag pans the map — suppress the tap-through on slots/locks/buildings.
    svg.querySelectorAll<SVGElement>('[data-slot]').forEach((g) =>
      g.addEventListener('click', () => { if (!panMoved) openCreate(Number(g.dataset.slot)); }));
    svg.querySelectorAll<SVGElement>('[data-b]').forEach((g) =>
      g.addEventListener('click', () => { if (!panMoved) openBuilding(Number(g.dataset.b)); }));
    svg.querySelectorAll<SVGElement>('[data-lock]').forEach((g) =>
      g.addEventListener('click', () => { if (!panMoved) toast('Слот откроется позже'); }));
    svg.querySelectorAll<SVGElement>('[data-collect]').forEach((g) =>
      g.addEventListener('click', (e) => { e.stopPropagation(); if (!panMoved) collectReward(Number(g.dataset.collect), g); }));
    const likes = buildings.reduce((a, b) => a + b.likes, 0);
    const statEl = ov.querySelector('[data-stat]');
    if (statEl) statEl.textContent = `♥ ${likes} · ${buildings.length}/${SLOTS.length} mechanics`;
    const tokEl = ov.querySelector('[data-tok]');
    if (tokEl) tokEl.textContent = String(ctx.puzzles?.() ?? S.tokens);
    if (localFreshChanged) persistLocalExperiments();
    if (persist) save();
  }

  // Collect the puzzles bobbing over a mechanic: clear the local reward, then hand
  // the amount + tap point to the feed, which flies the pucks into the ONE shared
  // HUD counter (scatter → arc into it).
  function collectReward(slot: number, el: SVGElement): void {
    if (guest) return;
    const amount = sim.reward[slot] || 0;
    if (amount <= 0) return;
    sim.reward[slot] = 0;
    saveIslandSim(sim);
    const r = el.getBoundingClientRect();
    ctx.addPuzzles?.(amount, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    refreshIsland();
  }

  // ── creation flow ──────────────────────────────────────────────────────────

  function openCreate(slot: number, replacing?: string): void {
    const ready = readyDrafts.get(slot);
    if (ready) {
      cur = ready;
      if (ready.candidates?.length) stepCandidates(ready);
      else if (pendingSlots.has(slot)) stepPendingSlot(slot, ready);
      else if (ready.mode === 'wild' && ready.experiment) stepExperimentPreview();
      else if (ready.mode === 'wild' && ready.concepts?.length) stepExperimentChoice();
      else if (ready.mode === 'wild') stepPrompt();
      else stepPreview();
      return;
    }
    if (pendingSlots.has(slot)) {
      stepPendingSlot(slot);
      return;
    }
    cur = {
      slot, tpl: 'sort', mode: 'safe', tier: 'free', provider: 'auto', prompt: '', pack: PACKS[0],
      presetId: 'surprise', rerolls: 1, difficulty: 'surprise', motion: 'surprise',
    };
    const cards = CREATABLE_TPLS.map((id) =>
      `<button class="isl-tcard" type="button" data-t="${id}">
        <span class="isl-tcard__pv"><img src="${coverUrl(TPL[id].playableId)}" alt="" onerror="this.style.display='none'"></span>
        <span><span class="isl-tcard__nm">${TPL[id].label}</span><br><span class="isl-tcard__ds">${TPL[id].ds}</span></span>
      </button>`).join('');
    const sub = replacing
      ? `This REPLACES “${esc(replacing)}” — its plays and likes are lost`
      : 'Pick the mechanic, then choose how widely it may vary';
    openSheet(`<h3>${replacing ? 'Rebuild slot' : 'New mechanic'}</h3><div class="isl-sub">${sub}</div>
      <div class="isl-tcards">${cards}</div>`);
    sheet.querySelectorAll<HTMLElement>('[data-t]').forEach((c) =>
      c.addEventListener('click', () => { if (cur) { cur.tpl = c.dataset.t as TplId; stepTier(); } }));
  }

  function stepPendingSlot(slot: number, draft?: CreationDraft): void {
    if (draft) cur = draft;
    openSheet(`<h3>Generation in progress</h3><div class="isl-sub">Live state from the persistent local worker</div>
      <div data-pending-live><ul class="isl-lablog"><li><b></b><span>Reading current worker state…</span></li></ul></div>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing</button>`);
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', closeSheet);
    const live = sheet.querySelector('[data-pending-live]') as HTMLElement;
    const stages = [
      'Generate and validate a creative concept',
      'Create a disposable fork at the pinned commit/tree',
      'Claude/Codex reads and edits only SWIPE TypeScript',
      'Check path allowlist, patch budget, and forbidden capabilities',
      'Run tsc and reject new diagnostics in changed files',
      'Build a self-contained SWIPE artifact',
      'Inject network-deny CSP; test lifecycle, pause, manual input, and idle',
      'Run fixed-seed autoplay; retry the same build once on a flaky result',
      'Save the candidate and its lineage locally',
    ];
    let reading = false;
    const paint = async () => {
      if (reading) return;
      reading = true;
      const recovered = readyDrafts.get(slot);
      if (recovered?.candidates?.length) {
        window.clearInterval(progressTimer);
        progressTimer = 0;
        stepCandidates(recovered);
        reading = false;
        return;
      }
      try {
        const jobs = await generatorJobs<unknown>();
        const matching = jobs.filter((job) => Number(job.request?.slot) === slot
          && (job.type === 'concepts' || job.type === 'experiment') && !job.consumedAt);
        const job = matching.find((candidate) => generatorPending(candidate.state)) ?? matching[0];
        if (!job) {
          if (recovered && !pendingSlots.has(slot)) { openCreate(slot); reading = false; return; }
          live.innerHTML = '<div class="isl-labnote"><b>No active job found</b><br>The worker has no unconsumed generation for this slot. Close this sheet and retry.</div>';
          reading = false;
          return;
        }
        setPendingPhase(slot, job.phase || job.message);
        const phaseText = `${job.phase} ${job.logs.map((entry) => entry.phase).join(' ')}`.toLowerCase();
        let current = 0;
        if (job.state === 'ready') current = 8;
        else if (/publish|soft-gate/.test(phaseText)) current = 8;
        else if (/test|test-retry|autoplay/.test(job.phase)) current = 7;
        else if (/conformance/.test(job.phase)) current = 6;
        else if (/build/.test(job.phase)) current = 5;
        else if (/typecheck/.test(job.phase)) current = 4;
        else if (/safety/.test(job.phase)) current = 3;
        else if (/agent|repair/.test(job.phase)) current = 2;
        else if (/fork/.test(job.phase)) current = 1;
        const failedAttempts = job.logs.filter((entry) => entry.phase === 'failed-attempt').length;
        const attempt = Math.max(Number(job.attempt || 0), failedAttempts + 1);
        const created = job.createdAt ? Date.parse(job.createdAt) : Date.now();
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - (Number.isFinite(created) ? created : Date.now())) / 1000));
        const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
        const runningAhead = jobs.filter((candidate) => candidate.id !== job.id && (candidate.state === 'running' || candidate.state === 'starting')).length;
        const health = generatorHealth(job.liveness, job.state, job.pid);
        const eta = job.state === 'queued'
          ? `${runningAhead || 1} job ahead · outcome no later than 24h after start`
          : job.state === 'ready' ? 'ready; UI is reconnecting'
          : job.state === 'failed' ? 'stopped after its repair budget'
          : current <= 2 ? 'agent may use the remaining 24h job budget'
          : current <= 5 ? 'roughly 2–5 min'
          : 'roughly 1–4 min if autoplay passes';
        const rows = stages.map((stage, index) => {
          const done = index < current || job.state === 'ready';
          const failed = job.state === 'failed' && index === current;
          return `<li class="${done ? 'ok' : failed ? 'fail' : ''}"><b></b><span>${stage}${index === current && generatorPending(job.state) ? ' · now' : ''}</span></li>`;
        }).join('');
        const logs = job.logs.slice(-12).map((entry) => `<div><b>${esc(entry.phase.toUpperCase())}</b> ${esc(entry.message)}</div>`).join('');
        const provider = String(job.provider || job.request?.provider || 'resolving').toUpperCase();
        live.innerHTML = `<div class="isl-progressmeta"><span>Elapsed <b>${elapsed}</b></span><span>ETA <b>${esc(eta)}</b></span></div>
          <div class="isl-pk"><b>${provider}</b> · ${job.state.toUpperCase()} · ${job.type === 'experiment' ? `repair attempt ${Math.min(attempt, 3)}/3` : 'concept pass'}<br>${esc(health)}</div>
          <ul class="isl-lablog">${rows}</ul>
          ${job.error ? `<div class="isl-labnote"><b>Worker stopped</b><br>${esc(job.error)}</div>` : ''}
          <div class="isl-progresslog"><div class="isl-choice__label">Actual worker log</div>${logs || '<div>Waiting for the first worker event…</div>'}</div>`;
      } catch (error) {
        live.innerHTML = `<div class="isl-labnote"><b>Worker connection interrupted</b><br>${esc(errorText(error))}. The detached job keeps running; this screen will retry.</div>`;
      } finally {
        reading = false;
      }
    };
    void paint();
    progressTimer = window.setInterval(() => { void paint(); }, 1000);
  }

  function stepTier(): void {
    if (!cur) return;
    const expensiveDisabled = !IS_DEV;
    openSheet(`<h3>Choose a generation pack</h3><div class="isl-sub">You only build the result you keep</div>
      <div class="isl-tiers">
        <button type="button" data-tier="free" class="isl-tier">
          <span class="isl-tier__price">FREE</span><b>Safe roll</b><span>1 option · parameters only · no model</span>
        </button>
        <button type="button" data-tier="cheap" class="isl-tier">
          <span class="isl-tier__price">LOW COST</span><b>Guided pair</b><span>2 options · safe + bounded API model</span>
        </button>
        <button type="button" data-tier="expensive" class="isl-tier"${expensiveDisabled ? ' disabled' : ''}>
          <span class="isl-tier__price">HIGH COST${expensiveDisabled ? ' · LOCAL LAB' : ''}</span><b>Creative trio</b><span>3 options · safe + guided now · code experiment may work until tomorrow</span>
        </button>
      </div>`);
    sheet.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur || button.disabled) return;
        cur.tier = button.dataset.tier as CreationTier;
        cur.mode = 'safe';
        cur.candidates = undefined;
        cur.concepts = undefined;
        cur.concept = undefined;
        cur.experiment = undefined;
        stepPrompt();
      }));
  }

  function stepPrompt(): void {
    if (!cur) return;
    const free = cur.tier === 'free';
    const chips = PACKS.map((pack) => `<button class="isl-chip${cur!.presetId === pack.id ? ' on' : ''}" type="button" data-preset="${pack.id}">
      <i style="background:${pack.items[0]}"></i>${esc(pack.name)}</button>`).join('');
    const difficultyOptions: Array<[IslandDifficultyPreference, string]> = [
      ['surprise', 'Surprise'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert'],
    ];
    const motionOptions: Array<[IslandMotionPreference, string]> = [
      ['surprise', 'Surprise'], ['calm', 'Calm'], ['heavy', 'Heavy'], ['bouncy', 'Bouncy'], ['chaotic', 'Chaotic'],
    ];
    const controls = `<div class="isl-choice"><div class="isl-choice__label">Theme direction</div>
      <div class="isl-chips"><button class="isl-chip${cur.presetId === 'surprise' ? ' on' : ''}" type="button" data-preset="surprise">Surprise</button>${chips}</div></div>
      <div class="isl-choice"><div class="isl-choice__label">Difficulty</div><div class="isl-seg" data-diff-group>
        ${difficultyOptions.map(([value, label]) => `<button type="button" data-diff="${value}" class="${cur!.difficulty === value ? 'on' : ''}">${label}</button>`).join('')}
      </div></div>
      <div class="isl-choice"><div class="isl-choice__label">Motion</div><div class="isl-seg" data-motion-group>
        ${motionOptions.map(([value, label]) => `<button type="button" data-motion="${value}" class="${cur!.motion === value ? 'on' : ''}">${label}</button>`).join('')}
      </div></div>`;
    const providerControls = cur.tier === 'expensive' ? `<div class="isl-choice"><div class="isl-choice__label">Creative model</div><div class="isl-seg isl-seg--three" data-provider-group>
        ${([['auto', 'Auto'], ['claude', 'Claude'], ['codex', 'Codex']] as Array<[ExperimentProvider, string]>).map(([value, label]) => `<button type="button" data-provider="${value}" class="${cur!.provider === value ? 'on' : ''}">${label}</button>`).join('')}
      </div></div>` : '';
    const promptInput = free ? '' : `<textarea class="isl-in isl-in--prompt" data-prm placeholder="e.g. black industrial night, restrained red accents" maxlength="500" rows="3">${esc(cur.prompt)}</textarea>`;
    const count = cur.tier === 'free' ? 1 : cur.tier === 'cheap' ? 2 : 3;
    openSheet(`<h3>${TPL[cur.tpl].label} · ${cur.tier}</h3><div class="isl-sub">Prepare ${count} ${count === 1 ? 'option' : 'options'}</div>
      ${promptInput}${controls}${providerControls}
      <button class="isl-btn isl-btn--pri" type="button" data-gen>${free ? 'Create safe option' : `Generate ${count} options`}</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-back-tier>Change pack</button>`);
    const inp = sheet.querySelector('[data-prm]') as HTMLTextAreaElement | null;
    sheet.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur) return;
        cur.presetId = button.dataset.preset || 'surprise';
        sheet.querySelectorAll('[data-preset]').forEach((item) => item.classList.toggle('on', item === button));
        if (inp && cur.presetId !== 'surprise') inp.value = PACKS.find((pack) => pack.id === cur!.presetId)?.name ?? inp.value;
      }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur) return;
        cur.difficulty = button.dataset.diff as IslandDifficultyPreference;
        sheet.querySelectorAll('[data-diff]').forEach((item) => item.classList.toggle('on', item === button));
      }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-motion]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur) return;
        cur.motion = button.dataset.motion as IslandMotionPreference;
        sheet.querySelectorAll('[data-motion]').forEach((item) => item.classList.toggle('on', item === button));
      }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur) return;
        cur.provider = button.dataset.provider as ExperimentProvider;
        sheet.querySelectorAll('[data-provider]').forEach((item) => item.classList.toggle('on', item === button));
      }));
    (sheet.querySelector('[data-gen]') as HTMLElement).addEventListener('click', () => {
      if (!cur) return;
      cur.prompt = inp?.value.trim() || PACKS.find((pack) => pack.id === cur!.presetId)?.name || '';
      void generatePackage();
    });
    sheet.querySelector('[data-back-tier]')?.addEventListener('click', stepTier);
  }

  function stepExperimentConcepts(): void {
    if (!cur || cur.mode !== 'wild') return;
    const req = cur;
    if (req.conceptJobId) void consumeGeneratorJob(req.conceptJobId).catch(() => undefined);
    req.conceptJobId = undefined;
    req.concepts = undefined;
    req.concept = undefined;
    readyDrafts.delete(req.slot);
    const generationId = ++generationSeq;
    generationBySlot.set(req.slot, generationId);
    pendingSlots.add(req.slot);
    setPendingPhase(req.slot, 'concepts');
    refreshIsland(false);
    openSheet(`<h3>Rolling concepts…</h3><div class="isl-sub">${esc(req.prompt || 'surprise me')}</div>
      <ul class="isl-lablog"><li><b></b><span>Looking for three different feelings, not three skins</span></li></ul>
      <div class="isl-pk">This uses the selected local subscription runner. No release code is changed.</div>`);
    void experimentConcepts(req.prompt, req.provider, req.slot).then(({ concepts, jobId }) => {
      if (generationBySlot.get(req.slot) !== generationId) return;
      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      pendingPhaseBySlot.delete(req.slot);
      req.concepts = concepts;
      req.conceptJobId = jobId;
      readyDrafts.set(req.slot, req);
      const interactive = ov.isConnected && sheet.classList.contains('isl-sheet--show') && cur === req;
      if (interactive) stepExperimentChoice();
      else if (ov.isConnected) {
        refreshIsland(false);
        toast('Three experiment concepts are ready · tap the slot');
      }
    }).catch((error) => {
      if (generationBySlot.get(req.slot) !== generationId) return;
      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      pendingPhaseBySlot.delete(req.slot);
      refreshIsland(false);
      if (cur !== req || !sheet.classList.contains('isl-sheet--show')) {
        if (ov.isConnected) toast(`Concept roll failed · ${errorText(error)}`);
        return;
      }
      openSheet(`<h3>Concept roll failed</h3><div class="isl-sub">${esc(errorText(error))}</div>
        <button class="isl-btn isl-btn--pri" type="button" data-retry>Retry</button>
        <button class="isl-btn isl-btn--ghost" type="button" data-back>Back to prompt</button>`);
      sheet.querySelector('[data-retry]')?.addEventListener('click', stepExperimentConcepts);
      sheet.querySelector('[data-back]')?.addEventListener('click', stepPrompt);
    });
  }

  function stepExperimentChoice(): void {
    if (!cur || cur.mode !== 'wild' || !cur.concepts?.length) return;
    openSheet(`<h3>Choose your throw</h3><div class="isl-sub">Each concept becomes a different code fork</div>
      <div class="isl-concepts">${cur.concepts.map((concept, index) => `<button type="button" class="isl-concept" data-concept="${index}">
        <span class="isl-concept__head"><span>${esc(concept.title)}</span><span class="isl-concept__risk">${esc(concept.risk)} risk</span></span>
        <span class="isl-concept__feeling">${esc(concept.feeling)}</span>
        <span class="isl-concept__pitch">${esc(concept.pitch)}</span>
      </button>`).join('')}</div>
      <button class="isl-btn isl-btn--ghost" type="button" data-reroll-concepts>Roll three more</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-back>Change the brief</button>`);
    sheet.querySelectorAll<HTMLButtonElement>('[data-concept]').forEach((button) =>
      button.addEventListener('click', () => {
        if (!cur?.concepts) return;
        const concept = cur.concepts[Number(button.dataset.concept)];
        if (!concept) return;
        cur.concept = concept;
        if (cur.conceptJobId) void consumeGeneratorJob(cur.conceptJobId).catch(() => undefined);
        cur.conceptJobId = undefined;
        void runExperiment();
      }));
    sheet.querySelector('[data-reroll-concepts]')?.addEventListener('click', stepExperimentConcepts);
    sheet.querySelector('[data-back]')?.addEventListener('click', stepPrompt);
  }

  const candidateFor = (draft: CreationDraft, mode: CreationMode): CreationCandidate | undefined =>
    draft.candidates?.find((candidate) => candidate.mode === mode);

  function experimentPack(prompt: string, result: ExperimentResult): Pack {
    const base = pickPack(prompt, null);
    return normalizePack({
      ...base,
      id: `exp-${result.id}`,
      name: result.title.slice(0, 40),
      kw: [],
      seed: stableSeed(result.id),
    });
  }

  function chooseCandidate(req: CreationDraft, candidate: CreationCandidate): void {
    if (candidate.state !== 'ready' || !candidate.pack) return;
    cur = req;
    req.mode = candidate.mode;
    req.pack = candidate.pack;
    req.ai = candidate.ai;
    req.concept = candidate.concept;
    req.experiment = candidate.experiment;
    req.experimentJobId = candidate.experimentJobId;
    if (candidate.mode === 'wild' && candidate.experiment) recordAgentResult(req, candidate.experiment);
    readyDrafts.set(req.slot, req);
    if (candidate.mode === 'wild') stepExperimentPreview();
    else stepPreview();
  }

  function playCandidate(req: CreationDraft, candidate: CreationCandidate): void {
    const src = candidatePreviewUrl(candidate);
    if (!src || candidate.state !== 'ready') { toast('This preview is not ready yet'); return; }
    const title = candidate.experiment?.title || candidate.pack?.name || 'Mechanic candidate';
    const play = document.createElement('div');
    play.className = 'isl-play';
    play.innerHTML = `<div class="isl-play__head">
      <div class="isl-play__nm">${esc(title)} <span style="opacity:.55;font-weight:600">· candidate</span></div>
      <button class="isl-dbg" type="button" data-state>${candidate.mode === 'wild' ? 'LOCAL LAB' : 'PREVIEW'}</button>
      <button class="isl-close" type="button" aria-label="Back" data-back>✕</button>
    </div>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'autoplay');
    frame.title = title;
    if (candidate.mode === 'wild') frame.setAttribute('sandbox', 'allow-scripts');
    play.appendChild(frame);
    ov.appendChild(play);
    const chip = play.querySelector('[data-state]') as HTMLElement;
    let bootTimer = 0;

    const prepare = () => {
      frame.contentWindow?.postMessage({ target: 'playable-swipe', type: 'setHostPaused', paused: false }, '*');
      frame.contentWindow?.postMessage({ target: 'playable-swipe', type: 'prepareInteractive' }, '*');
    };
    const cleanup = () => {
      window.clearTimeout(bootTimer);
      window.removeEventListener('message', onMessage);
      try { frame.src = 'about:blank'; } catch { /* noop */ }
      play.remove();
      if (!ov.isConnected) return;
      if (req.candidates?.length) stepCandidates(req);
      else if (req.mode === 'wild') stepExperimentPreview();
      else stepPreview();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (data?.source === 'playable' && data.type === 'swipe-ready') prepare();
      const outcome = outcomeOf(event.data);
      if (!outcome) return;
      candidate.played = true;
      candidate.outcome = outcome;
      chip.textContent = outcome === 'won' ? 'WIN' : 'TRY AGAIN';
      if (outcome === 'won') toast('Candidate completed · you can keep it or try the others');
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      candidate.played = true;
      chip.textContent = candidate.outcome === 'won' ? 'WIN' : candidate.mode === 'wild' ? 'LOCAL LAB' : 'PLAYING';
      prepare();
      bootTimer = window.setTimeout(prepare, 400);
    }, { once: true });
    (play.querySelector('[data-back]') as HTMLElement).addEventListener('click', cleanup);
    frame.src = src;
  }

  function stepCandidateProgress(req: CreationDraft, candidate: CreationCandidate): void {
    cur = req;
    const title = candidate.mode === 'guided' ? 'Guided API variation' : 'Creative code experiment';
    openSheet(`<h3>${title}</h3><div class="isl-sub">Live generation status</div>
      <div data-progress-live></div>
      <button class="isl-btn isl-btn--ghost" type="button" data-back-options>Back to candidates</button>`);
    const live = sheet.querySelector('[data-progress-live]') as HTMLElement;
    const elapsed = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - (candidate.startedAt || Date.now())) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    };
    const paint = () => {
      const phases = candidate.logs?.map((entry) => entry.phase.toLowerCase()) ?? [];
      const phaseText = `${candidate.phase || ''} ${phases.join(' ')}`.toLowerCase();
      const stages = candidate.mode === 'guided'
        ? ['Request accepted', 'Model generates bounded pack', 'Contract validation', 'Ready to compare']
        : [
            'Concept model proposes directions',
            'Create isolated pinned fork',
            'Claude/Codex reads and edits SWIPE source',
            'Patch allowlist + capability scan',
            'Check new TypeScript diagnostics',
            'Build standalone SWIPE artifact',
            'Lifecycle, pause, manual, idle + network conformance',
            'Fixed-seed autoplay with one flake retry',
            'Save candidate locally',
          ];
      let current = 0;
      if (candidate.mode === 'guided') {
        current = candidate.state === 'ready' ? 3 : candidate.state === 'failed' ? 2 : 1;
      } else if (candidate.state === 'ready') current = 8;
      else if (/publish|soft-gate/.test(phaseText)) current = 8;
      else if (/test|test-retry|autoplay/.test(phaseText)) current = 7;
      else if (/conformance/.test(phaseText)) current = 6;
      else if (/build/.test(phaseText)) current = 5;
      else if (/typecheck|typescript/.test(phaseText)) current = 4;
      else if (/safety|capability|allowlist/.test(phaseText)) current = 3;
      else if (/agent|repair|mutat/.test(phaseText)) current = 2;
      else if (/fork/.test(phaseText)) current = 1;
      const eta = candidate.state === 'ready' ? 'ready now'
        : candidate.state === 'failed' ? 'stopped'
        : candidate.mode === 'guided' ? 'usually 20–90 sec'
        : current === 0 ? 'roughly 1–3 min to choose a direction'
        : current <= 2 ? 'agent may work until tomorrow · heartbeat stays visible'
        : current <= 5 ? 'roughly 2–5 min'
        : 'roughly 1–4 min if the playtest passes';
      const rows = stages.map((stage, index) => {
        const done = index < current || candidate.state === 'ready';
        const failed = candidate.state === 'failed' && index === current;
        return `<li class="${done ? 'ok' : failed ? 'fail' : ''}"><b></b><span>${esc(stage)}${index === current && candidate.state === 'generating' ? ' · now' : ''}</span></li>`;
      }).join('');
      const logs = candidate.logs?.slice(-8).map((entry) =>
        `<div><b>${esc(entry.phase.toUpperCase())}</b> ${esc(entry.message)}</div>`).join('') || '';
      const health = generatorHealth(candidate.liveness, candidate.state);
      live.innerHTML = `<div class="isl-progressmeta"><span>Elapsed <b>${elapsed()}</b></span><span>ETA <b>${eta}</b></span></div>
        <ul class="isl-lablog">${rows}</ul>
        <div class="isl-pk">${candidate.state === 'failed' ? esc(candidate.error || 'Generation stopped') : `Current: ${esc(candidate.phase || 'queued')}<br>${esc(health)}`}</div>
        ${logs ? `<div class="isl-progresslog"><div class="isl-choice__label">Worker log</div>${logs}</div>` : ''}`;
    };
    paint();
    progressTimer = window.setInterval(paint, 1000);
    sheet.querySelector('[data-back-options]')?.addEventListener('click', () => stepCandidates(req));
  }

  function stepCandidates(req: CreationDraft): void {
    cur = req;
    const candidates = req.candidates ?? [];
    const ready = candidates.filter((candidate) => candidate.state === 'ready').length;
    const expected = req.tier === 'cheap' ? 2 : 3;
    const labels: Record<CreationMode, { badge: string; title: string }> = {
      safe: { badge: 'SAFE', title: 'Parameter roll' },
      guided: { badge: 'AI', title: 'Guided variation' },
      wild: { badge: 'WILD', title: 'Code experiment' },
    };
    const cards = candidates.map((candidate) => {
      const label = labels[candidate.mode];
      const status = candidate.outcome === 'won' ? 'PLAYED · WIN'
        : candidate.played ? 'PLAYED'
        : candidate.state === 'ready'
          ? candidate.mode === 'wild' && candidate.experiment?.autoplayPassed !== true ? 'UNVERIFIED' : 'READY'
        : candidate.state === 'failed' ? 'FAILED' : candidate.phase || 'GENERATING';
      const realCover = candidate.mode === 'wild' && candidate.experiment
        ? experimentCoverUrl(candidate.experiment)
        : '';
      const media = realCover
        ? `<div class="isl-candidate__media isl-candidate__media--capture">${board(req.tpl, candidate.pack ?? req.pack)}<img data-real-cover src="${esc(realCover)}" alt="Real gameplay preview" decoding="async"></div>`
        : candidate.pack
          ? `<div class="isl-candidate__media">${board(req.tpl, candidate.pack)}</div>`
          : '<div class="isl-candidate__media isl-candidate__media--pending"><b></b><b></b><b></b></div>';
      const detail = candidate.state === 'failed'
        ? candidate.error || 'Generation failed'
        : candidate.mode === 'wild' && candidate.experiment
          ? candidate.experiment.pitch
          : candidate.pack
            ? `${candidate.pack.difficulty} · ${candidate.pack.motion} · ${candidate.pack.conveyorPath}`
            : `${candidate.phase || 'Waiting'} · tap for live progress`;
      const actions = candidate.state === 'ready' ? `<div class="isl-candidate__actions${candidate.mode === 'wild' ? ' isl-candidate__actions--three' : ''}">
        <button type="button" data-play="${candidate.mode}">${candidate.played ? 'Play again' : 'Play'}</button>
        ${candidate.mode === 'wild' ? '<button type="button" data-refine="wild">Refine</button>' : ''}
        <button type="button" data-keep="${candidate.mode}">Keep this</button>
      </div>` : '';
      const progressAttrs = candidate.state !== 'ready'
        ? ` data-progress-card="${candidate.mode}" role="button" tabindex="0" aria-label="Open ${label.title} progress"`
        : '';
      return `<div class="isl-candidate isl-candidate--${candidate.state}"${progressAttrs}>
        ${media}<span class="isl-candidate__head"><span><em>${label.badge}</em><b>${label.title}</b></span><i>${esc(status)}</i></span>
        <span class="isl-candidate__detail${candidate.outcome === 'won' ? ' isl-candidate__result' : ''}">${esc(detail)}</span>${actions}
      </div>`;
    }).join('');
    const backgroundNote = req.tier === 'expensive' && candidates.some((candidate) => candidate.mode === 'wild'
      && (candidate.state === 'waiting' || candidate.state === 'generating'))
      ? ' · creative work continues safely in background for up to 24h'
      : '';
    openSheet(`<h3>Choose a mechanic</h3><div class="isl-sub">${ready}/${expected} options ready · only your choice can be built${backgroundNote}</div>
      <div class="isl-candidates" data-candidates>${cards}</div>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-regenerate>Generate this pack again</button>`);
    bindRealCoverFallback();
    sheet.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((button) =>
      button.addEventListener('click', () => {
        const candidate = candidateFor(req, button.dataset.play as CreationMode);
        if (candidate) playCandidate(req, candidate);
      }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-keep]').forEach((button) =>
      button.addEventListener('click', () => {
        const candidate = candidateFor(req, button.dataset.keep as CreationMode);
        if (candidate) chooseCandidate(req, candidate);
      }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-refine]').forEach((button) =>
      button.addEventListener('click', () => {
        const candidate = candidateFor(req, button.dataset.refine as CreationMode);
        if (candidate) chooseCandidate(req, candidate);
      }));
    sheet.querySelectorAll<HTMLElement>('[data-progress-card]').forEach((card) => {
      const open = () => {
        const candidate = candidateFor(req, card.dataset.progressCard as CreationMode);
        if (candidate) stepCandidateProgress(req, candidate);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    });
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', closeSheet);
    sheet.querySelector('[data-regenerate]')?.addEventListener('click', () => { cur = req; void generatePackage(); });
  }

  function repaintCandidates(req: CreationDraft): void {
    if (ov.isConnected && cur === req && sheet.classList.contains('isl-sheet--show') && sheet.querySelector('[data-candidates]')) {
      stepCandidates(req);
    }
  }

  function experimentBundle(req: CreationDraft): ExperimentBundleSnapshot {
    const safe = candidateFor(req, 'safe');
    const guided = candidateFor(req, 'guided');
    if (!safe?.pack) throw new Error('safe candidate is missing from the experiment bundle');
    return {
      schemaVersion: 1,
      tier: 'expensive',
      slot: req.slot,
      prompt: req.prompt,
      provider: req.provider,
      difficulty: req.difficulty,
      motion: req.motion,
      safePack: safe.pack,
      guidedPack: guided?.pack,
      guidedError: guided?.error,
      messages: restoreExperimentMessages(req.messages),
    };
  }

  async function generatePackage(): Promise<void> {
    if (!cur) return;
    const req = cur;
    const previousWildJobId = candidateFor(req, 'wild')?.experimentJobId;
    if (previousWildJobId) void consumeGeneratorJob(previousWildJobId).catch(() => undefined);
    if (req.experimentJobId) void consumeGeneratorJob(req.experimentJobId).catch(() => undefined);
    req.mode = 'safe';
    req.ai = false;
    req.concepts = undefined;
    req.concept = undefined;
    req.experiment = undefined;
    req.experimentJobId = undefined;
    req.messages = undefined;
    req.sourceLocalSlot = undefined;
    const safePack = safeParameterizedPack(req);

    if (req.tier === 'free') {
      req.pack = safePack;
      req.candidates = undefined;
      readyDrafts.set(req.slot, req);
      stepPreview();
      return;
    }

    req.candidates = [
      { mode: 'safe', state: 'ready', pack: safePack, ai: false },
      { mode: 'guided', state: 'generating', ai: true, phase: 'ASKING API MODEL', startedAt: Date.now() },
      ...(req.tier === 'expensive'
        ? [{ mode: 'wild', state: 'waiting', ai: true, phase: 'STARTING LOCAL JOB', startedAt: Date.now() } as CreationCandidate]
        : []),
    ];
    readyDrafts.set(req.slot, req);
    const generationId = ++generationSeq;
    generationBySlot.set(req.slot, generationId);
    pendingSlots.add(req.slot);
    setPendingPhase(req.slot, req.tier === 'expensive' ? 'concepts' : 'theme AI');
    refreshIsland(false);
    stepCandidates(req);

    const wild = candidateFor(req, 'wild');
    const conceptTask = wild ? (() => {
      wild.state = 'generating';
      wild.phase = 'ROLLING CONCEPT';
      const recoveryBundle = experimentBundle(req);
      return experimentConcepts(req.prompt, req.provider, req.slot, recoveryBundle, (job) => {
        wild.jobId = job.id;
        wild.logs = job.logs;
        wild.liveness = job.liveness;
        wild.phase = (job.message || job.phase || 'ROLLING CONCEPT').toUpperCase().slice(0, 42);
        setPendingPhase(req.slot, wild.phase);
        repaintCandidates(req);
      })
        .then((value) => ({ value, error: null as unknown }))
        .catch((error: unknown) => ({ value: null, error }));
    })() : null;

    const guided = candidateFor(req, 'guided')!;
    try {
      const pack = await aiTheme(req.prompt, req.avoid, req.difficulty, req.motion);
      if (generationBySlot.get(req.slot) !== generationId) return;
      if (!pack) throw new Error('API model is unavailable');
      pack.id = `ai-${newJobId()}`;
      guided.pack = pack;
      guided.state = 'ready';
      guided.phase = 'READY';
    } catch (error) {
      guided.state = 'failed';
      guided.error = errorText(error);
      guided.phase = 'FAILED';
    }
    repaintCandidates(req);

    if (req.tier === 'expensive') {
      const creative = wild!;
      let conceptJobId = '';
      try {
        const rolledTask = await conceptTask!;
        if (rolledTask.error) throw rolledTask.error;
        const rolled = rolledTask.value!;
        conceptJobId = rolled.jobId;
        if (generationBySlot.get(req.slot) !== generationId) return;
        const concept = rolled.concepts.find((candidate) => candidate.risk === 'high') ?? rolled.concepts[0];
        if (!concept) throw new Error('creative model returned no concept');
        creative.concept = concept;
        void consumeGeneratorJob(conceptJobId).catch(() => undefined);
        conceptJobId = '';
        creative.phase = 'MUTATING CODE';
        setPendingPhase(req.slot, creative.phase);
        repaintCandidates(req);
        const bundle = experimentBundle(req);
        const jobId = await startExperiment(req.prompt, concept, req.provider, req.slot, undefined, undefined, bundle);
        creative.experimentJobId = jobId;
        creative.jobId = jobId;
        creative.logs = [];
        let job: ExperimentJob | null = null;
        for (let poll = 0; poll < 24 * 60 * 60; poll++) {
          if (generationBySlot.get(req.slot) !== generationId) return;
          job = await experimentStatus(jobId);
          creative.logs = job.logs;
          creative.liveness = job.liveness;
          creative.phase = (job.message || job.phase || 'GENERATING').toUpperCase().slice(0, 42);
          setPendingPhase(req.slot, creative.phase);
          repaintCandidates(req);
          if (!generatorPending(job.state)) break;
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        if (!job || generatorPending(job.state)) throw new Error('Experiment reached its 24-hour deadline');
        if (job.state !== 'ready' || !job.result) throw new Error(job.error || job.message || 'Experiment failed');
        creative.experiment = job.result;
        recordAgentResult(req, job.result);
        creative.pack = experimentPack(req.prompt, job.result);
        creative.state = 'ready';
        creative.phase = job.result.autoplayPassed === true ? 'READY' : 'UNVERIFIED';
      } catch (error) {
        if (conceptJobId) void consumeGeneratorJob(conceptJobId).catch(() => undefined);
        creative.state = 'failed';
        creative.error = errorText(error);
        creative.phase = 'FAILED';
      }
    }

    if (generationBySlot.get(req.slot) !== generationId) return;
    generationBySlot.delete(req.slot);
    pendingSlots.delete(req.slot);
    pendingPhaseBySlot.delete(req.slot);
    readyDrafts.set(req.slot, req);
    refreshIsland(false);
    if (cur === req && sheet.classList.contains('isl-sheet--show')) stepCandidates(req);
    else if (ov.isConnected) toast(`${req.tier === 'cheap' ? 'Pair' : 'Trio'} ready · tap the slot to choose`);
  }

  function installExperimentResult(req: CreationDraft, result: ExperimentResult, jobId: string): void {
    const localPack = experimentPack(req.prompt, result);
    req.pack = localPack;
    req.ai = true;
    req.experiment = result;
    req.experimentJobId = jobId;
    recordAgentResult(req, result);
    const candidate = candidateFor(req, 'wild');
    if (candidate) {
      candidate.state = 'ready';
      candidate.pack = localPack;
      candidate.experiment = result;
      candidate.experimentJobId = jobId;
      candidate.phase = result.autoplayPassed === true ? 'READY' : 'UNVERIFIED';
      candidate.error = undefined;
      candidate.played = false;
      candidate.outcome = undefined;
    }
    readyDrafts.set(req.slot, req);
    if (req.sourceLocalSlot !== undefined) persistDraftThread(req);
    const interactive = ov.isConnected && sheet.classList.contains('isl-sheet--show') && cur === req;
    if (interactive) stepExperimentPreview();
    else if (ov.isConnected) {
      refreshIsland();
      toast(`Experiment "${result.title.slice(0, 24)}" passed · tap the slot to inspect`);
    }
  }

  async function runExperiment(parentId?: string, feedback?: string): Promise<void> {
    if (!cur || cur.mode !== 'wild' || !cur.concept) return;
    const req = cur;
    const concept = cur.concept;
    readyDrafts.delete(req.slot);
    const generationId = ++generationSeq;
    generationBySlot.set(req.slot, generationId);
    pendingSlots.add(req.slot);
    setPendingPhase(req.slot, parentId ? 'repair' : 'fork');
    refreshIsland();
    openSheet(`<h3 data-lab-title>${parentId ? 'Tuning the experiment…' : 'Mutating the mechanic…'}</h3>
      <div class="isl-sub">${esc(concept.title)} · persistent ${esc(req.provider)} subscription runner</div>
      <ul class="isl-lablog" data-lablog><li><b></b><span>Queueing an isolated code fork</span></li></ul>
      <div class="isl-pk" data-lab-health>Durable queue · safe across page reloads</div>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing</button>
      <div class="isl-pk" style="margin-top:8px">This workshop may continue for up to 24 hours. Hard failures get up to 3 repair passes; safe options remain available while it works.</div>`);
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', closeSheet);

    const paintJob = (job: ExperimentJob) => {
      if (!ov.isConnected || !sheet.classList.contains('isl-sheet--show') || cur !== req) return;
      const titleEl = sheet.querySelector('[data-lab-title]');
      if (titleEl) titleEl.textContent = job.state === 'failed'
        ? 'Experiment failed'
        : job.state === 'ready'
          ? job.result?.autoplayPassed === false ? 'Build ready · win unverified' : 'Autoplay won'
          : parentId ? 'Tuning the experiment…' : 'Mutating the mechanic…';
      const log = sheet.querySelector('[data-lablog]');
      if (!log) return;
      const health = sheet.querySelector('[data-lab-health]');
      if (health) health.textContent = generatorHealth(job.liveness, job.state, job.pid);
      log.innerHTML = job.logs.map((entry) => {
        const cls = entry.phase === 'failed-attempt' ? 'fail' : entry.phase === 'publish' || entry.phase === 'ready' ? 'ok' : '';
        const attempt = entry.attempt ? `Attempt ${entry.attempt} · ` : '';
        return `<li class="${cls}"><b></b><span>${esc(attempt + entry.message)}</span></li>`;
      }).join('') || '<li><b></b><span>Starting the local worker</span></li>';
    };

    let jobId = '';
    let job: ExperimentJob | null = null;
    try {
      jobId = await startExperiment(
        req.prompt,
        concept,
        req.provider,
        req.slot,
        parentId,
        feedback,
        req.candidates?.length ? experimentBundle(req) : undefined,
      );
      req.experimentJobId = jobId;
      if (req.sourceLocalSlot !== undefined) persistDraftThread(req);
      for (let poll = 0; poll < 24 * 60 * 60; poll++) {
        if (generationBySlot.get(req.slot) !== generationId) return;
        job = await experimentStatus(jobId);
        setPendingPhase(req.slot, job.phase || job.message);
        paintJob(job);
        if (!generatorPending(job.state)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!job || generatorPending(job.state)) throw new Error('Experiment reached its 24-hour deadline');
      if (job.state !== 'ready' || !job.result) throw new Error(job.error || job.message || 'Experiment failed');
      if (generationBySlot.get(req.slot) !== generationId) return;

      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      pendingPhaseBySlot.delete(req.slot);
      installExperimentResult(req, job.result, jobId);
    } catch (error) {
      if (generationBySlot.get(req.slot) !== generationId) return;
      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      pendingPhaseBySlot.delete(req.slot);
      refreshIsland();
      const message = errorText(error);
      console.error('[island] local experiment failed:', message);
      if (feedback) {
        const terminal = Boolean(job && !generatorPending(job.state));
        addExperimentMessage(req, 'system', terminal ? `Revision stopped: ${message}` : `Revision status disconnected: ${message}`);
        if (req.sourceLocalSlot !== undefined) persistDraftThread(req);
      }
      if (jobId && job && !generatorPending(job.state)) void consumeGeneratorJob(jobId).catch(() => undefined);
      if (!ov.isConnected || !sheet.classList.contains('isl-sheet--show') || cur !== req) {
        if (ov.isConnected) toast(`Experiment failed · ${message}`);
        return;
      }
      openSheet(`<h3>Experiment exhausted its attempts</h3><div class="isl-sub">${esc(message)}</div>
        <button class="isl-btn isl-btn--pri" type="button" data-retry>Try this concept again</button>
        <button class="isl-btn isl-btn--ghost" type="button" data-concepts>Choose another concept</button>
        <button class="isl-btn isl-btn--ghost" type="button" data-back>Change the brief</button>`);
      sheet.querySelector('[data-retry]')?.addEventListener('click', () => { void runExperiment(parentId, feedback); });
      sheet.querySelector('[data-concepts]')?.addEventListener('click', stepExperimentChoice);
      sheet.querySelector('[data-back]')?.addEventListener('click', stepPrompt);
    }
  }

  function restoreExperimentBundle(value: unknown, slot: number): ExperimentBundleSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<ExperimentBundleSnapshot>;
    if (raw.schemaVersion !== 1 || raw.tier !== 'expensive' || raw.slot !== slot) return null;
    const restorePack = (candidate: unknown): Pack | null => {
      if (!candidate || typeof candidate !== 'object') return null;
      const pack = candidate as Partial<Pack>;
      const colors = ['ground', 'edge', 'sceneBg', 'boardBg', 'belt', 'outline', 'body', 'roof'] as const;
      if (typeof pack.id !== 'string' || typeof pack.name !== 'string'
        || !Array.isArray(pack.items) || pack.items.length !== 6
        || !pack.items.every((color) => typeof color === 'string')
        || !colors.every((field) => typeof pack[field] === 'string')) return null;
      return normalizePack(pack as IslandStoredPack);
    };
    const safePack = restorePack(raw.safePack);
    if (!safePack) return null;
    const guidedPack = restorePack(raw.guidedPack);
    const provider: ExperimentProvider = raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : 'auto';
    const difficulties: IslandDifficultyPreference[] = ['surprise', 'easy', 'medium', 'hard', 'expert'];
    const motions: IslandMotionPreference[] = ['surprise', 'calm', 'heavy', 'bouncy', 'chaotic'];
    return {
      schemaVersion: 1,
      tier: 'expensive',
      slot,
      prompt: String(raw.prompt || '').slice(0, 500),
      provider,
      difficulty: difficulties.includes(raw.difficulty as IslandDifficultyPreference) ? raw.difficulty! : 'surprise',
      motion: motions.includes(raw.motion as IslandMotionPreference) ? raw.motion! : 'surprise',
      safePack,
      guidedPack: guidedPack ?? undefined,
      guidedError: guidedPack ? undefined : String(raw.guidedError || 'Guided API candidate was unavailable').slice(0, 240),
      messages: restoreExperimentMessages(raw.messages),
    };
  }

  function draftFromExperimentBundle(bundle: ExperimentBundleSnapshot): CreationDraft {
    return {
      slot: bundle.slot,
      tpl: 'sort',
      mode: 'safe',
      tier: 'expensive',
      provider: bundle.provider,
      prompt: bundle.prompt,
      pack: bundle.safePack,
      presetId: 'surprise',
      rerolls: 1,
      difficulty: bundle.difficulty,
      motion: bundle.motion,
      ai: false,
      messages: [...(bundle.messages ?? [])],
      candidates: [
        { mode: 'safe', state: 'ready', pack: bundle.safePack, ai: false },
        bundle.guidedPack
          ? { mode: 'guided', state: 'ready', pack: bundle.guidedPack, ai: true }
          : { mode: 'guided', state: 'failed', ai: true, error: bundle.guidedError || 'Guided API candidate was unavailable' },
        { mode: 'wild', state: 'generating', ai: true, phase: 'RECONNECTING', startedAt: Date.now() },
      ],
    };
  }

  async function resumeGeneratorExperiments(): Promise<void> {
    let jobs: Array<LocalGeneratorJob<ExperimentResult>>;
    try {
      jobs = await generatorJobs<ExperimentResult>();
    } catch (error) {
      console.log('[island] local generator reconnect unavailable:', errorText(error));
      return;
    }
    const claimedSlots = new Set<number>();
    for (const job of jobs) {
      if ((job.type !== 'concepts' && job.type !== 'experiment') || job.consumedAt) continue;
      const request = job.request || {};
      const slot = Number(request.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS.length) {
        void consumeGeneratorJob(job.id).catch(() => undefined);
        continue;
      }
      if (claimedSlots.has(slot)) {
        void consumeGeneratorJob(job.id).catch(() => undefined);
        continue;
      }
      claimedSlots.add(slot);
      const bundle = restoreExperimentBundle(request.bundle, slot);
      if (bundle) {
        const req = draftFromExperimentBundle(bundle);
        const wild = candidateFor(req, 'wild')!;
        wild.jobId = job.id;
        wild.logs = job.logs;
        wild.liveness = job.liveness;
        wild.startedAt = job.createdAt ? Date.parse(job.createdAt) : Date.now();
        readyDrafts.set(slot, req);
        const generationId = ++generationSeq;
        generationBySlot.set(slot, generationId);
        pendingSlots.add(slot);
        setPendingPhase(slot, job.phase || job.message);
        refreshIsland(false);

        const finish = (keepDraft = true) => {
          if (generationBySlot.get(slot) === generationId) generationBySlot.delete(slot);
          pendingSlots.delete(slot);
          pendingPhaseBySlot.delete(slot);
          if (keepDraft) readyDrafts.set(slot, req);
          else readyDrafts.delete(slot);
          refreshIsland(false);
        };
        const failBundle = (message: string, terminalJobId?: string) => {
          wild.state = 'failed';
          wild.phase = 'FAILED';
          wild.error = message;
          if (terminalJobId) void consumeGeneratorJob(terminalJobId).catch(() => undefined);
          finish();
          if (ov.isConnected) toast(`Creative candidate failed · safe options recovered`);
        };
        const installBundleResult = (result: ExperimentResult, jobId: string, concept: ExperimentConcept) => {
          if (localExperiments.buildings.some((building) => localExperimentId(building) === result.id)
            || S.buildings.some((building) => building.url?.includes(result.id))) {
            void consumeGeneratorJob(jobId).catch(() => undefined);
            finish(false);
            return;
          }
          const pack = experimentPack(req.prompt, result);
          wild.state = 'ready';
          wild.phase = result.autoplayPassed === true ? 'READY' : 'UNVERIFIED';
          wild.pack = pack;
          wild.concept = concept;
          wild.experiment = result;
          wild.experimentJobId = jobId;
          req.concept = concept;
          req.experiment = result;
          req.experimentJobId = jobId;
          recordAgentResult(req, result);
          finish();
          if (ov.isConnected) toast('Creative trio recovered · tap the slot to compare');
        };
        const pollTerminal = async (initial: LocalGeneratorJob<unknown>): Promise<LocalGeneratorJob<unknown>> => {
          let current = initial;
          for (let poll = 0; poll < 24 * 60 * 60 && generatorPending(current.state); poll++) {
            if (generationBySlot.get(slot) !== generationId) return current;
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            current = await generatorJob<unknown>(current.id);
            wild.jobId = current.id;
            wild.logs = current.logs;
            wild.liveness = current.liveness;
            wild.phase = (current.message || current.phase || 'GENERATING').toUpperCase().slice(0, 42);
            setPendingPhase(slot, wild.phase);
            repaintCandidates(req);
          }
          return current;
        };
        void (async () => {
          try {
            let current = await pollTerminal(job as LocalGeneratorJob<unknown>);
            if (generationBySlot.get(slot) !== generationId) return;
            if (current.state !== 'ready' || !current.result) {
              failBundle(current.error || current.message || 'Persistent generator job failed', current.id);
              return;
            }
            let concept = request.concept as ExperimentConcept | undefined;
            if (current.type === 'concepts') {
              const concepts = (current.result as { concepts?: ExperimentConcept[] }).concepts;
              concept = concepts?.find((candidate) => candidate.risk === 'high') ?? concepts?.[0];
              if (!concept?.title || !concept.mechanic) {
                failBundle('Creative model returned no usable concept', current.id);
                return;
              }
              wild.concept = concept;
              wild.phase = 'MUTATING CODE';
              void consumeGeneratorJob(current.id).catch(() => undefined);
              const experimentJobId = await startExperiment(req.prompt, concept, req.provider, slot, undefined, undefined, bundle);
              wild.experimentJobId = experimentJobId;
              wild.jobId = experimentJobId;
              wild.logs = [];
              current = await pollTerminal(await generatorJob<unknown>(experimentJobId));
              if (generationBySlot.get(slot) !== generationId) return;
              if (current.state !== 'ready' || !current.result) {
                failBundle(current.error || current.message || 'Recovered experiment failed', current.id);
                return;
              }
            }
            const result = current.result as ExperimentResult;
            if (!concept?.title || !concept.mechanic || !result?.id || !result.url) {
              failBundle('Recovered experiment result is incomplete', current.id);
              return;
            }
            installBundleResult(result, current.id, concept);
          } catch (error) {
            wild.phase = 'RECONNECT ON RELOAD';
            if (generationBySlot.get(slot) === generationId) generationBySlot.delete(slot);
            pendingSlots.delete(slot);
            pendingPhaseBySlot.delete(slot);
            readyDrafts.set(slot, req);
            refreshIsland(false);
            console.log('[island] bundle reconnect interrupted:', errorText(error));
          }
        })();
        continue;
      }
      const concept = request.concept as ExperimentConcept | undefined;
      if (job.type === 'experiment' && (!concept?.title || !concept.mechanic)) {
        void consumeGeneratorJob(job.id).catch(() => undefined);
        continue;
      }
      const placedBuilding = visibleBuildings().find((building) => building.slot === slot);
      const placedThread = localExperiments.threads[String(slot)];
      const resumesPlacedRevision = Boolean(job.type === 'experiment' && placedBuilding && placedThread
        && editableExperimentId(placedBuilding) === placedThread.placedExperimentId
        && String(request.parentId || '') === placedThread.experiment.id);
      const req: CreationDraft = resumesPlacedRevision
        ? draftFromLocalThread(placedBuilding!, placedThread!)
        : {
        slot,
        tpl: 'sort',
        mode: 'wild',
        tier: 'expensive',
        provider: request.provider === 'claude' || request.provider === 'codex' ? request.provider : 'auto',
        prompt: String(request.prompt || ''),
        pack: PACKS[0],
        presetId: 'surprise',
        rerolls: 1,
        difficulty: 'surprise',
        motion: 'surprise',
        ai: true,
        concept: job.type === 'experiment' ? concept : undefined,
      };
      if (resumesPlacedRevision) {
        req.concept = concept ?? req.concept;
        req.experimentJobId = job.id;
      }
      const installConcepts = (current: LocalGeneratorJob<ExperimentResult>) => {
        const concepts = (current.result as unknown as { concepts?: ExperimentConcept[] } | undefined)?.concepts;
        if (!Array.isArray(concepts) || concepts.length !== 3) return false;
        req.concepts = concepts;
        req.conceptJobId = current.id;
        readyDrafts.set(slot, req);
        refreshIsland(false);
        if (ov.isConnected) toast('Three experiment concepts are ready · tap the slot');
        return true;
      };
      if (job.state === 'ready' && job.result) {
        if (job.type === 'concepts') {
          if (!installConcepts(job)) void consumeGeneratorJob(job.id).catch(() => undefined);
          continue;
        }
        if (localExperiments.buildings.some((building) => localExperimentId(building) === job.result!.id)
          || S.buildings.some((building) => building.url?.includes(job.result!.id))) {
          void consumeGeneratorJob(job.id).catch(() => undefined);
          continue;
        }
        installExperimentResult(req, job.result, job.id);
        continue;
      }
      if (!generatorPending(job.state)) {
        void consumeGeneratorJob(job.id).catch(() => undefined);
        if (ov.isConnected) toast(`Recovered experiment failed · ${job.error || job.message}`);
        continue;
      }

      const generationId = ++generationSeq;
      generationBySlot.set(slot, generationId);
      pendingSlots.add(slot);
      setPendingPhase(slot, job.phase || job.message);
      refreshIsland(false);
      void (async () => {
        try {
          let current = job;
          for (let poll = 0; poll < 24 * 60 * 60; poll++) {
            if (generationBySlot.get(slot) !== generationId) return;
            current = await generatorJob<ExperimentResult>(job.id);
            setPendingPhase(slot, current.phase || current.message);
            if (!generatorPending(current.state)) break;
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
          if (generationBySlot.get(slot) !== generationId) return;
          generationBySlot.delete(slot);
          pendingSlots.delete(slot);
          pendingPhaseBySlot.delete(slot);
          if (current.state === 'ready' && current.result) {
            if (current.type === 'concepts') {
              if (!installConcepts(current)) void consumeGeneratorJob(current.id).catch(() => undefined);
            } else installExperimentResult(req, current.result, current.id);
          }
          else {
            void consumeGeneratorJob(current.id).catch(() => undefined);
            refreshIsland(false);
            if (ov.isConnected) toast(`Recovered experiment failed · ${current.error || current.message}`);
          }
        } catch (error) {
          // Keep the durable service job unconsumed. A later page reload can
          // reconnect again after the local service comes back.
          generationBySlot.delete(slot);
          pendingSlots.delete(slot);
          pendingPhaseBySlot.delete(slot);
          refreshIsland(false);
          console.log('[island] generator reconnect interrupted:', errorText(error));
        }
      })();
    }
  }

  async function publishExperiment(input: {
    id: string;
    slot: number;
    tpl: TplId;
    pack: Pack;
    name: string;
    prompt: string;
    draft?: CreationDraft;
    source?: Building;
  }): Promise<void> {
    const sourceId = input.source ? localExperimentId(input.source) : input.draft?.experiment?.id ?? null;
    if (!sourceId || sourceId !== input.id) { toast('Local experiment source is no longer available'); return; }
    const publishUiId = newJobId();
    openSheet(`<h3 data-publish-title>Publishing experiment…</h3>
      <div class="isl-sub">${esc(input.name)} · standalone artifact only</div>
      <ul class="isl-lablog" data-publish-log><li><b></b><span>Queueing sandbox recheck</span></li></ul>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing</button>
      <div class="isl-labnote" style="margin-top:8px">The temporary source patch stays local. The commit allowlist contains only the self-contained HTML, its real gameplay cover, and public metadata.</div>`);
    sheet.dataset.publishRun = publishUiId;
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', closeSheet);
    const publishUiOpen = () => sheet.dataset.publishRun === publishUiId && sheet.classList.contains('isl-sheet--show');

    const paint = (job: ExperimentPublishJob) => {
      if (!ov.isConnected || !publishUiOpen()) return;
      const titleEl = sheet.querySelector('[data-publish-title]');
      if (titleEl) titleEl.textContent = job.state === 'failed' ? 'Publish failed' : job.state === 'ready' ? 'Published' : 'Publishing experiment…';
      const log = sheet.querySelector('[data-publish-log]');
      if (!log) return;
      log.innerHTML = job.logs.map((entry) => {
        const cls = entry.phase === 'failed' ? 'fail' : entry.phase === 'deploy' || entry.phase === 'already-published' ? 'ok' : '';
        return `<li class="${cls}"><b></b><span>${esc(entry.message)}</span></li>`;
      }).join('') || '<li><b></b><span>Starting the publish worker</span></li>';
    };

    let jobId = '';
    let job: ExperimentPublishJob | null = null;
    try {
      jobId = await startExperimentPublish(input.id);
      for (let poll = 0; poll < 420; poll++) {
        job = await experimentPublishStatus(jobId);
        paint(job);
        if (!generatorPending(job.state)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!job || generatorPending(job.state)) throw new Error('Publish timed out after 7 minutes');
      if (job.state !== 'ready' || !job.result?.url || !job.result.commit) {
        throw new Error(job.error || job.message || 'Experiment publish failed');
      }
      void consumeGeneratorJob(jobId).catch(() => undefined);

      let source: Building | undefined;
      if (input.source) {
        source = localExperiments.buildings.find((building) => building.slot === input.slot && localExperimentId(building) === input.id);
        if (!source) { toast('Published, but the local slot changed — hosted artifact was not placed'); return; }
      } else if (!input.draft || readyDrafts.get(input.slot) !== input.draft || input.draft.experiment?.id !== input.id) {
        toast('Published, but the draft changed — hosted artifact was not placed');
        return;
      }

      const preservedThread = localExperiments.threads[String(input.slot)];
      const pack = normalizePack(input.pack);
      removeLocalExperiment(input.slot);
      readyDrafts.delete(input.slot);
      S.aiPacks = { ...(S.aiPacks ?? {}), [pack.id]: pack };
      S.buildings = S.buildings.filter((building) => building.slot !== input.slot);
      S.buildings.push({
        buildingId: newJobId(),
        slot: input.slot,
        tpl: input.tpl,
        pack: pack.id,
        name: input.name.slice(0, 16),
        prompt: input.prompt,
        plays: 0,
        likes: 0,
        liked: false,
        fresh: true,
        publishing: false,
        rel: job.result.rel,
      });
      if (input.draft) {
        persistDraftThread(input.draft, input.id);
      } else if (preservedThread) {
        localExperiments.threads[String(input.slot)] = {
          ...preservedThread,
          placedExperimentId: input.id,
          updatedAt: new Date().toISOString(),
        };
        persistLocalExperiments();
      }
      if (input.draft?.experimentJobId) void consumeGeneratorJob(input.draft.experimentJobId).catch(() => undefined);
      if (cur === input.draft) cur = null;
      if (publishUiOpen()) closeSheet();
      refreshIsland(true);
      toast(job.result.ready ? 'Published to hosting ✅' : 'Published; Render is warming up');
    } catch (error) {
      const message = errorText(error);
      console.error('[island] experiment publish failed:', message);
      if (jobId && job && !generatorPending(job.state)) void consumeGeneratorJob(jobId).catch(() => undefined);
      if (!ov.isConnected || !publishUiOpen()) {
        if (ov.isConnected) toast(`Publish failed · ${message}`);
        return;
      }
      openSheet(`<h3>Publish failed</h3><div class="isl-sub">${esc(message)}</div>
        <button class="isl-btn isl-btn--pri" type="button" data-retry-publish>Retry publish</button>
        <button class="isl-btn isl-btn--ghost" type="button" data-back>Back</button>`);
      sheet.querySelector('[data-retry-publish]')?.addEventListener('click', () => { void publishExperiment(input); });
      sheet.querySelector('[data-back]')?.addEventListener('click', () => {
        if (input.draft) { cur = input.draft; stepExperimentPreview(); }
        else openBuilding(input.slot);
      });
    }
  }

  function stepExperimentPreview(): void {
    if (!cur || cur.mode !== 'wild' || !cur.experiment || !cur.concept) return;
    const req = cur;
    const result = cur.experiment;
    recordAgentResult(req, result);
    const verified = result.autoplayPassed === true;
    const publish = verified ? '<button class="isl-btn isl-btn--pri" type="button" data-publish-lab>Publish tested artifact</button>' : '';
    const gate = verified ? '' : `<div class="isl-labnote"><b>Win not proven</b><br>${esc(result.gateError || 'Autoplay could not complete this mechanic. Play it manually or tune it before publishing.')}</div>`;
    const back = req.sourceLocalSlot !== undefined
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-back-building>Back to mechanic</button>'
      : req.candidates?.length
        ? '<button class="isl-btn isl-btn--ghost" type="button" data-back-candidates>Back to all candidates</button>'
        : '<button class="isl-btn isl-btn--ghost" type="button" data-concepts>Try another concept</button>';
    const conversation = (req.messages ?? []).slice(-10).map((message) => {
      const who = message.role === 'player' ? 'You' : message.role === 'system' ? 'Worker' : 'Agent';
      return `<div class="isl-msg isl-msg--${message.role}"><b>${who}</b>${esc(message.text)}</div>`;
    }).join('');
    const playUrl = `${result.url}${result.url.includes('?') ? '&' : '?'}auto=0`;
    openSheet(`<h3>${esc(result.title)}</h3><div class="isl-sub">Local experiment · ${verified ? `autoplay won on attempt ${result.attempts}` : 'runtime passed, passability unverified'}</div>
      <div class="isl-concept__feeling">${esc(result.feeling)}</div>
      <div class="isl-pk" style="margin-top:5px">${esc(result.pitch)}</div>
      ${gate}
      <div class="isl-choice"><div class="isl-choice__label">Refine with agent</div>
        <div class="isl-thread">${conversation}</div>
        <textarea class="isl-in" data-feedback maxlength="500" rows="2" placeholder="e.g. slower, darker, keep the echo visible longer"></textarea>
      </div>
      <button class="isl-btn isl-btn--pri" type="button" data-tune>Send revision</button>
      <iframe class="isl-labframe" sandbox="allow-scripts" src="${esc(playUrl)}" title="${esc(result.title)}"></iframe>
      ${publish}
      <button class="isl-btn isl-btn--ghost" type="button" data-place>Use this version on the island</button>
      ${back}
      <div class="isl-labnote">This artifact and its lineage live only on this dev machine. Placing it creates a local overlay; it never replaces or syncs the hosted building in that slot.</div>`);
    sheet.querySelector('[data-publish-lab]')?.addEventListener('click', () => {
      if (cur !== req || !req.experiment) return;
      void publishExperiment({
        id: req.experiment.id,
        slot: req.slot,
        tpl: req.tpl,
        pack: req.pack,
        name: req.experiment.title,
        prompt: req.prompt,
        draft: req,
      });
    });
    sheet.querySelector('[data-place]')?.addEventListener('click', () => {
      if (cur !== req || !req.experiment) return;
      const { slot, tpl, prompt, pack } = req;
      readyDrafts.delete(slot);
      removeLocalExperiment(slot);
      localExperiments.packs[pack.id] = pack;
      localExperiments.buildings.push({
        slot, tpl, pack: pack.id, name: req.experiment.title.slice(0, 16), prompt,
        plays: 0, likes: 0, liked: false, fresh: true, publishing: false, url: req.experiment.url,
        autoplayPassed: req.experiment.autoplayPassed === true,
      });
      persistDraftThread(req);
      if (req.experimentJobId) void consumeGeneratorJob(req.experimentJobId).catch(() => undefined);
      cur = null;
      closeSheet();
      persistLocalExperiments();
      refreshIsland(false);
      toast('Local experiment placed · not synced or published');
    });
    const feedbackInput = sheet.querySelector('[data-feedback]') as HTMLTextAreaElement | null;
    const sendRevision = () => {
      if (cur !== req || !req.experiment) return;
      const nextFeedback = feedbackInput?.value.trim() || '';
      if (!nextFeedback) { toast('Describe what should change first'); return; }
      addExperimentMessage(req, 'player', nextFeedback, req.experiment.id);
      if (req.sourceLocalSlot !== undefined) persistDraftThread(req);
      if (req.experimentJobId) void consumeGeneratorJob(req.experimentJobId).catch(() => undefined);
      void runExperiment(req.experiment.id, nextFeedback);
    };
    sheet.querySelector('[data-tune]')?.addEventListener('click', sendRevision);
    feedbackInput?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendRevision(); }
    });
    sheet.querySelector('[data-concepts]')?.addEventListener('click', () => {
      if (req.experimentJobId) void consumeGeneratorJob(req.experimentJobId).catch(() => undefined);
      stepExperimentChoice();
    });
    sheet.querySelector('[data-back-candidates]')?.addEventListener('click', () => stepCandidates(req));
    sheet.querySelector('[data-back-building]')?.addEventListener('click', () => openBuilding(req.slot, true));
  }

  async function reviseGuided(req: CreationDraft, feedback: string): Promise<void> {
    const previousPack = req.pack;
    const candidate = candidateFor(req, 'guided');
    const revisedPrompt = `${req.prompt}\nRevision request: ${feedback}`.trim().slice(0, 500);
    openSheet(`<h3>Revising guided option…</h3><div class="isl-sub">${esc(feedback)}</div>
      <ul class="isl-lablog"><li><b></b><span>Sending the bounded brief to the API model</span></li><li><b></b><span>Validating theme and gameplay parameters</span></li></ul>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing</button>`);
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', closeSheet);
    try {
      const pack = await aiTheme(revisedPrompt, variantFingerprint(previousPack), req.difficulty, req.motion);
      if (!pack) throw new Error('API model returned no validated variant');
      pack.id = `ai-${newJobId()}`;
      req.prompt = revisedPrompt;
      req.pack = pack;
      req.ai = true;
      if (candidate) {
        candidate.pack = pack;
        candidate.state = 'ready';
        candidate.phase = 'REVISED';
        candidate.error = undefined;
        candidate.played = false;
        candidate.outcome = undefined;
      }
      readyDrafts.set(req.slot, req);
      if (ov.isConnected) stepPreview();
    } catch (error) {
      const message = errorText(error);
      if (candidate) {
        candidate.pack = previousPack;
        candidate.state = 'ready';
        candidate.error = undefined;
      }
      if (!ov.isConnected) return;
      openSheet(`<h3>Revision failed</h3><div class="isl-sub">${esc(message)}</div>
        <button class="isl-btn isl-btn--pri" type="button" data-retry>Retry revision</button>
        <button class="isl-btn isl-btn--ghost" type="button" data-back>Back to option</button>`);
      sheet.querySelector('[data-retry]')?.addEventListener('click', () => { void reviseGuided(req, feedback); });
      sheet.querySelector('[data-back]')?.addEventListener('click', stepPreview);
    }
  }

  function stepPreview(): void {
    if (!cur) return;
    const req = cur;
    const pk = req.pack;
    const nm = pk.name;
    const modeLabel = req.mode === 'guided' ? 'bounded API variation' : 'safe parameters · no model';
    const selected = candidateFor(req, req.mode) ?? { mode: req.mode, state: 'ready', pack: pk, ai: Boolean(req.ai) };
    const compare = req.candidates?.length
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-back-options>Back to all candidates</button>'
      : '';
    const safeActions = req.mode === 'safe' && !req.candidates?.length
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-roll>Roll another free option</button><button class="isl-btn isl-btn--ghost" type="button" data-adjust>Adjust parameters</button>'
      : '';
    const revision = req.mode === 'guided' ? `<div class="isl-choice"><div class="isl-choice__label">What should the model change?</div>
      <textarea class="isl-in" data-guided-feedback maxlength="300" rows="3" placeholder="e.g. much darker, slower motion, fewer bright accents"></textarea></div>
      <button class="isl-btn isl-btn--ghost" type="button" data-revise>Ask AI to revise</button>` : '';
    openSheet(`<h3>Mechanic preview</h3><div class="isl-sub">Play it now; only Build publishes this choice</div>
      <div class="isl-board">${board(req.tpl, pk)}</div>
      <div class="isl-pk"><b>${esc(nm)}</b> · ${TPL[req.tpl].label} · <span style="opacity:.65">${modeLabel}</span></div>
      <div class="isl-traits"><span>${pk.difficulty}</span><span>${pk.motion}</span><span>${pk.marbleStyle}</span><span>${pk.targetShape}</span><span>${pk.conveyorPath}</span></div>
      <div class="isl-swrow" style="margin-top:8px">${pk.items.map((c) => `<span class="isl-sw isl-sw--in" style="background:${c}"></span>`).join('')}</div>
      <button class="isl-btn isl-btn--ghost" type="button" data-play-selected>▶ Play this option</button>
      <button class="isl-btn isl-btn--pri" type="button" data-build>Build on the island</button>
      ${compare}${safeActions}${revision}`);
    sheet.querySelector('[data-play-selected]')?.addEventListener('click', () => playCandidate(req, selected));
    (sheet.querySelector('[data-build]') as HTMLElement).addEventListener('click', () => {
      if (cur !== req) return;
      const { slot, tpl: tplId, prompt } = req;
      // Slots are the cap: building on an occupied slot replaces its mechanic.
      readyDrafts.delete(slot);
      removeLocalExperiment(slot);
      if (!PACKS.some((pack) => pack.id === pk.id)) S.aiPacks = { ...(S.aiPacks ?? {}), [pk.id]: pk };
      S.buildings = S.buildings.filter((x) => x.slot !== slot);
      S.buildings.push({
        buildingId: newJobId(),
        slot, tpl: tplId, pack: pk.id, name: nm.slice(0, 16), prompt,
        plays: 0, likes: 0, liked: false, fresh: true, publishing: true,
      });
      cur = null;
      closeSheet();
      refreshIsland(true);
      toast('Publishing…');
      void bakeAndHost(slot, prompt);
    });
    sheet.querySelector('[data-back-options]')?.addEventListener('click', () => stepCandidates(req));
    sheet.querySelector('[data-adjust]')?.addEventListener('click', stepPrompt);
    sheet.querySelector('[data-roll]')?.addEventListener('click', () => {
      req.avoid = variantFingerprint(req.pack);
      void generatePackage();
    });
    sheet.querySelector('[data-revise]')?.addEventListener('click', () => {
      const input = sheet.querySelector('[data-guided-feedback]') as HTMLTextAreaElement;
      const feedback = input.value.trim();
      if (!feedback) { toast('Describe what should change first'); return; }
      void reviseGuided(req, feedback);
    });
  }

  // ── building card + play (real mechanic in an iframe) ──────────────────────

  function applySocial(building: Building, social: IslandSocialView): void {
    const current = S.buildings.find((candidate) => candidate.buildingId === social.building_id);
    const targets = current && current !== building ? [building, current] : [building];
    targets.forEach((target) => {
      target.plays = social.plays;
      target.likes = social.likes;
      target.liked = social.liked;
    });
  }

  function openBuilding(slot: number, ignoreReadyDraft = false): void {
    const b = visibleBuildings().find((x) => x.slot === slot);
    if (!b) return;
    if (guest) { playSeries(b); return; }
    const readyRevision = readyDrafts.get(slot);
    if (readyRevision && !ignoreReadyDraft) { openCreate(slot); return; }
    const pk = resolvePack(b.pack);
    // The slot is "busy" for the whole publish chain — block actions that would
    // start a second job (rebuild) or orphan the running one (delete).
    const busy = Boolean(b.publishing) || pollingSlots.has(slot) || pendingSlots.has(slot);
    // Status badge mirrors the map dots (same colors) — one visual language.
    const localLab = isLocalExperiment(b);
    const editableId = editableExperimentId(b);
    const editableExperiment = IS_DEV && Boolean(editableId);
    const realCover = buildingExperimentCoverUrl(b, editableId);
    const buildingPreview = realCover
      ? `<div class="isl-board isl-board--capture">${board(b.tpl, pk)}<img data-real-cover src="${esc(realCover)}" alt="Real gameplay preview" decoding="async"></div>`
      : `<div class="isl-board">${board(b.tpl, pk)}</div>`;
    const st = localLab
      ? { c: '#58A6FF', t: 'local lab' }
      : hostedUrl(b)
        ? { c: '#4CC38A', t: 'hosted' }
      : busy
        ? { c: '#EF9F27', t: 'publishing…' }
        : b.publishError
          ? { c: '#E24B4A', t: `publish failed · ${b.publishError}` }
          : { c: 'rgba(255,255,255,.45)', t: 'local draft' };
    const badge = `<span class="isl-status"${busy ? ' data-pulse' : ''}><b style="background:${st.c}"></b>${esc(st.t)}</span>`;
    const retry = !hostedUrl(b) && !busy
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-publish>Retry publish</button>'
      : '';
    const publishLab = localLab && b.autoplayPassed === true
      ? `<button class="isl-btn isl-btn--pri" type="button" data-publish-lab${busy ? ' disabled' : ''}>Publish tested artifact</button>`
      : '';
    const refineLab = editableExperiment
      ? `<button class="isl-btn isl-btn--ghost" type="button" data-refine-lab${busy ? ' disabled' : ''}>Refine with agent</button>`
      : '';
    const revisionProgress = editableExperiment && pendingSlots.has(slot)
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-revision-progress>View revision progress</button>'
      : '';
    openSheet(`<h3>${esc(b.name)}</h3>
      <div class="isl-sub">${TPL[b.tpl].label} · Lv ${levelOf(b)} · ${b.plays} plays · ♥ ${b.likes} ${badge}</div>
      ${buildingPreview}
      <button class="isl-btn isl-btn--pri" type="button" data-play>▶ Play the series</button>
      ${revisionProgress}
      ${refineLab}
      ${publishLab}
      ${retry}
      <button class="isl-btn isl-btn--ghost" type="button" data-rebuild${busy ? ' disabled' : ''}>Rebuild slot · replace this mechanic</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-delete${busy ? ' disabled' : ''}>Delete mechanic</button>
      <div class="isl-pk" style="margin-top:10px">${busy
        ? 'Work in progress 🏗️ — rebuild and delete unlock when it finishes'
        : 'Guests like it after they beat it — switch to guest mode to feel it'}</div>`);
    bindRealCoverFallback();
    (sheet.querySelector('[data-play]') as HTMLElement).addEventListener('click', () => { closeSheet(); playSeries(b); });
    sheet.querySelector('[data-revision-progress]')?.addEventListener('click', () => stepPendingSlot(slot));
    sheet.querySelector('[data-refine-lab]')?.addEventListener('click', () => {
      if (pendingSlots.has(slot)) { stepPendingSlot(slot); return; }
      void openLocalExperimentEditor(b);
    });
    sheet.querySelector('[data-publish]')?.addEventListener('click', () => {
      closeSheet();
      toast('Publishing…');
      void bakeAndHost(slot, b.prompt ?? '');
    });
    sheet.querySelector('[data-publish-lab]')?.addEventListener('click', () => {
      const experimentId = editableExperimentId(b);
      if (!experimentId) { toast('Local experiment source is missing'); return; }
      void publishExperiment({
        id: experimentId,
        slot: b.slot,
        tpl: b.tpl,
        pack: pk,
        name: b.name,
        prompt: b.prompt ?? '',
        source: b,
      });
    });
    (sheet.querySelector('[data-rebuild]') as HTMLElement).addEventListener('click', () => {
      if (Boolean(b.publishing) || pollingSlots.has(slot)) { toast('Slot is busy — publishing in progress'); return; }
      closeSheet();
      openCreate(slot, b.name);
    });
    (sheet.querySelector('[data-delete]') as HTMLElement).addEventListener('click', async () => {
      if (Boolean(b.publishing) || pollingSlots.has(slot)) { toast('Slot is busy — publishing in progress'); return; }
      if (!await showConfirm(`Delete "${b.name}" from the island?`)) return;
      closeSheet();
      if (localLab) {
        removeLocalExperiment(slot);
        refreshIsland(false);
      } else {
        S.buildings = S.buildings.filter((x) => x.slot !== slot);
        if (editableExperiment) {
          delete localExperiments.threads[String(slot)];
          persistLocalExperiments();
        }
        refreshIsland(true);
      }
      toast('Mechanic removed from the island');
    });
  }

  function playSeries(b: Building): void {
    const play = document.createElement('div');
    play.className = 'isl-play';
    play.innerHTML =
      '<div class="isl-play__head">' +
        `<div class="isl-play__nm">${esc(b.name)} <span style="opacity:.55;font-weight:600">· ${TPL[b.tpl].label}</span></div>` +
        '<button class="isl-dbg" type="button" data-dbg>boot…</button>' +
        '<button class="isl-close" type="button" aria-label="Back" data-back>✕</button>' +
      '</div>';
    const frame = document.createElement('iframe');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'autoplay');
    if (guest) frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    else if (isLocalExperiment(b)) frame.setAttribute('sandbox', 'allow-scripts');
    play.appendChild(frame);
    ov.appendChild(play);

    // Launch telemetry: every step of the fork/fallback path is logged. The
    // chip in the header shows the verdict; tapping it opens the full log.
    const dbgLines: string[] = [];
    const dbg = (m: string) => { dbgLines.push(m); console.log('[island]', m); };
    const chip = play.querySelector('[data-dbg]') as HTMLElement;
    const setChip = (t: string) => { chip.textContent = t; };
    chip.addEventListener('click', () => {
      const old = play.querySelector('.isl-dbglog');
      if (old) { old.remove(); return; }
      const panel = document.createElement('div');
      panel.className = 'isl-dbglog';
      panel.textContent = dbgLines.join('\n');
      play.appendChild(panel);
    });
    dbg(`launch: "${b.name}" tpl=${b.tpl} pack=${b.pack} guest=${guest}`);

    const visitId = guest && publicIsland && b.buildingId ? newJobId() : null;
    const visitStartedAt = performance.now();
    const visitStart = visitId && publicIsland && b.buildingId
      ? apiStartIslandVisit({
          visit_id: visitId,
          owner_id: publicIsland.owner.id,
          building_id: b.buildingId,
        })
      : null;
    if (visitStart) {
      void visitStart.then((visit) => {
        applySocial(b, visit.social);
        dbg(`visit started: ${visit.visit_id}`);
      }).catch((error) => dbg(`visit start failed: ${errorText(error)}`));
    }

    // The canonical playable is never transformed in the client. Generated
    // mechanics exist only as tested hosted/local-lab artifacts.
    const stockSrc = playableUrl(TPL[b.tpl].playableId, { auto: false });
    const pk = resolvePack(b.pack);
    void (async () => {
      const hosted = hostedUrl(b);
      if (hosted) {
        dbg(`loading hosted build: ${hosted}`);
        setChip(`${isLocalExperiment(b) ? 'LOCAL LAB' : 'HOSTED'} · ${pk.name}`);
        frame.src = `${hosted}${hosted.includes('?') ? '&' : '?'}auto=0`;
        return;
      }
      dbg(`loading canonical stock: ${stockSrc}`);
      setChip(`STOCK · ${b.tpl}`);
      frame.src = stockSrc;
    })();

    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      try { frame.src = 'about:blank'; } catch { /* noop */ }
      play.remove();
    };
    let winShown = false;
    let visitCompleted = false;
    const showWin = () => {
      if (winShown) return;
      winShown = true;
      const win = document.createElement('div');
      win.className = 'isl-win';
      win.innerHTML =
        '<div class="isl-win__t">Round won! 🎉</div>' +
        (guest ? '<div class="isl-win__m" data-visit-status>Verifying this visit…</div>'
               : '<div class="isl-win__m">Your own build — no tokens for self-plays</div>') +
        (guest ? `<button class="isl-like${b.liked ? ' isl-like--on' : ''}" type="button" data-like disabled>${b.liked ? '♥ Liked' : '♡ Like this mechanic'}</button>` : '') +
        '<button class="isl-win__home" type="button" data-home>Back to island</button>';
      play.appendChild(win);
      const likeButton = win.querySelector('[data-like]') as HTMLButtonElement | null;
      const paintLike = () => {
        if (!likeButton) return;
        const current = S.buildings.find((candidate) => candidate.buildingId === b.buildingId) ?? b;
        likeButton.classList.toggle('isl-like--on', current.liked);
        likeButton.textContent = current.liked ? '♥ Liked' : '♡ Like this mechanic';
      };
      likeButton?.addEventListener('click', async () => {
        if (!visitCompleted || !publicIsland || !b.buildingId || !likeButton) return;
        const current = S.buildings.find((candidate) => candidate.buildingId === b.buildingId) ?? b;
        const nextLiked = !current.liked;
        likeButton.disabled = true;
        try {
          const social = await apiSetIslandLike(b.buildingId, publicIsland.owner.id, nextLiked);
          applySocial(b, social);
          paintLike();
          refreshIsland(false);
        } catch (error) {
          toast(`Like failed · ${errorText(error)}`);
        } finally {
          if (play.isConnected) likeButton.disabled = false;
        }
      });
      (win.querySelector('[data-home]') as HTMLElement).addEventListener('click', () => { cleanup(); refreshIsland(); });
      refreshIsland(false);

      if (!guest) return;
      const status = win.querySelector('[data-visit-status]') as HTMLElement;
      void (async () => {
        if (!visitStart || !visitId) throw new Error('This building has no server visit identity');
        await visitStart;
        const waitMs = Math.max(0, 850 - (performance.now() - visitStartedAt));
        if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        let completed;
        try {
          completed = await apiCompleteIslandVisit(visitId);
        } catch (error) {
          if (!(error instanceof ApiRequestError) || error.status !== 425) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 1100));
          completed = await apiCompleteIslandVisit(visitId);
        }
        applySocial(b, completed.social);
        visitCompleted = true;
        dbg(`visit completed: plays=${completed.social.plays}`);
        if (play.isConnected) {
          status.textContent = 'Visit counted · you can leave a like';
          if (likeButton) likeButton.disabled = false;
          paintLike();
        }
        if (ov.isConnected) refreshIsland(false);
      })().catch((error) => {
        dbg(`visit completion failed: ${errorText(error)}`);
        if (!play.isConnected) return;
        status.textContent = 'Played successfully · visit could not be verified';
        if (likeButton) {
          likeButton.disabled = true;
          likeButton.textContent = 'Like unavailable';
        }
      });
    };
    const onMsg = (e: MessageEvent) => {
      if (!ov.isConnected) { cleanup(); return; }
      if (e.source !== frame.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (d && typeof d === 'object' && d.source === 'playable') dbg(`frame msg: ${String(d.type ?? d.event ?? '?')}`);
      const out = outcomeOf(e.data);
      if (out === 'won') { dbg('outcome: won'); showWin(); }
      else if (out === 'lost') { dbg('outcome: lost'); toast('So close — the mechanic restarts itself'); }
    };
    window.addEventListener('message', onMsg);
    (play.querySelector('[data-back]') as HTMLElement).addEventListener('click', () => { cleanup(); refreshIsland(); });
  }

  // ── header / modes ─────────────────────────────────────────────────────────

  ov.querySelector('.isl-close')?.addEventListener('click', () => ctx.close());
  ov.querySelector('[data-share-island]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const ownerId = Number((window as unknown as {
      Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
    }).Telegram?.WebApp?.initDataUnsafe?.user?.id);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      toast('Open the island in Telegram to share it');
      return;
    }
    button.disabled = true;
    try {
      const view = await apiPublicIsland(ownerId);
      if (!view.buildings.length) {
        toast('Publish a mechanic before sharing the island');
        return;
      }
      const fallback = new URL(location.href);
      fallback.searchParams.delete('c');
      fallback.searchParams.set('island', String(ownerId));
      shareTelegramLink(view.share_url, view.deep_link || fallback.toString(), `Play on ${islandLabel}`);
    } catch (error) {
      toast(`Share unavailable · ${errorText(error)}`);
    } finally {
      if (ov.isConnected) button.disabled = false;
    }
  });
  ov.querySelector('[data-guest-cta]')?.addEventListener('click', () => {
    const buildings = visibleBuildings();
    const b = buildings[Math.floor(Math.random() * buildings.length)];
    if (b) playSeries(b);
  });

  // Paint the local cache immediately, then replace it with the authoritative
  // server snapshot. Polling keeps an already-open island fresh across devices.
  refreshIsland(false);
  if (!guest) {
    if (IS_DEV) void resumeGeneratorExperiments();
    // Wait for the first server read before resuming jobs so a stale device cache
    // cannot revive a bake that another client has already replaced.
    void stateSync?.hydrate().finally(resumePendingBakes);
    const pollState = async () => {
      if (!ov.isConnected) return;
      await stateSync?.refresh();
      window.setTimeout(pollState, 10000);
    };
    window.setTimeout(pollState, 10000);
  } else if (publicIsland) {
    const pollPublicIsland = async () => {
      if (!ov.isConnected) return;
      try {
        const next = await apiPublicIsland(publicIsland.owner.id);
        S.buildings = next.buildings.map((building) => ({ ...building }));
        if (next.aiPacks) S.aiPacks = Object.fromEntries(
          Object.entries(next.aiPacks).map(([id, pack]) => [id, { ...pack }]),
        );
        else delete S.aiPacks;
        refreshIsland(false);
      } catch { /* keep the last good public snapshot */ }
      window.setTimeout(pollPublicIsland, 10000);
    };
    window.setTimeout(pollPublicIsland, 10000);
  }
}
