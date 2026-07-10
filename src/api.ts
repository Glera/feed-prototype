/**
 * Backend client (swipe-backend). The TMA calls the backend by its ABSOLUTE URL
 * (Render Static can't proxy /api/*), CORS is enabled server-side. Every request
 * carries `Authorization: tma <initData>`. Outside Telegram getInitData() is null
 * → these all resolve to null and callers fall back to in-memory behaviour, so
 * the feed works unchanged in a plain browser / AppLovin.
 */
import { getInitData } from './telegram';

export const API_BASE: string =
  ((import.meta as any).env?.VITE_API_BASE as string) || 'https://swipe-backend-541t.onrender.com';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const init = getInitData();
  if (init) h['Authorization'] = 'tma ' + init;
  return h;
}

async function post<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null; // offline / no auth / CORS — degrade silently
  }
}

export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function postRequired<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiRequestError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw response */ }
  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? text ?? r.statusText;
    throw new ApiRequestError(r.status, `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  if (data == null) throw new ApiRequestError(r.status, 'Backend returned an empty response');
  return data as T;
}

async function putRequired<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
      // Island snapshots are small; allow a final write to outlive WebView
      // pagehide when Telegram closes the Mini App immediately after an action.
      keepalive: true,
    });
  } catch (e) {
    throw new ApiRequestError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw response */ }
  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? text ?? r.statusText;
    throw new ApiRequestError(r.status, `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  if (data == null) throw new ApiRequestError(r.status, 'Backend returned an empty response');
  return data as T;
}

async function getRequired<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, { headers: headers() });
  } catch (e) {
    throw new ApiRequestError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw response */ }
  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? text ?? r.statusText;
    throw new ApiRequestError(r.status, `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  if (data == null) throw new ApiRequestError(r.status, 'Backend returned an empty response');
  return data as T;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_BASE}${path}`, { headers: headers() });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export interface MeResp {
  user: ({ id: number; ref_code: string | null } & Record<string, unknown>) | null;
  balance: number;
  needs_session?: boolean;
}

export function apiMe(): Promise<MeResp | null> {
  return get<MeResp>('/api/me');
}

/** Reset the caller's own progress (balance → 0). Auth-gated server-side. */
export function apiReset(): Promise<{ ok: boolean; balance: number } | null> {
  return post<{ ok: boolean; balance: number }>('/api/reset');
}

/** TEST: seed a fake incoming challenge into my inbox rail (dev/QA only). */
export function apiSeedChallenge(): Promise<{ ok: boolean; from: string; beat_ms: number } | null> {
  return post<{ ok: boolean; from: string; beat_ms: number }>('/api/seed-challenge');
}

export interface SessionResp {
  user: { id: number; ref_code: string | null } & Record<string, unknown>;
  ref_code: string | null;
  balance: number;
  is_new: boolean;
  backend_version?: string;
}

export interface ResultResp {
  is_best: boolean;
  stars_awarded: number;
  balance: number;
}

export function apiSession(): Promise<SessionResp | null> {
  return post<SessionResp>('/api/session');
}

export interface ResultIn {
  mechanic_id: string;
  variant_id: string;
  run_id: string;
  metric_key: string;
  metric_value: number;
  stars?: number;   // stars this win grants (client reward roll 1–5); server clamps
}

export function apiPostResult(payload: ResultIn): Promise<ResultResp | null> {
  return post<ResultResp>('/api/results', payload);
}

// ── Challenges (W2) ─────────────────────────────────────────────────────────
// "Beat my time?" — metric is solve time (ms), lower is better (server-authoritative).

export interface ChallengeChallenger {
  id: number;
  first_name: string | null;
  username: string | null;
}

export interface ChallengeView {
  id: string;
  mechanic_id: string;
  variant_id: string;
  metric_key: string;
  challenger_value: number;   // time (ms) to beat
  status: string;
  challenger: ChallengeChallenger;
}

export interface ChallengeCreated {
  challenge_id: string;
  deep_link: string;          // t.me/<bot>?startapp=<id> (empty if BOT_USERNAME unset)
  share_url: string;          // t.me/share/url?... fallback
}

export interface ChallengeComplete {
  beat: boolean;
  stars_awarded: number;
  balance: number;
}

/** Challenger records their run → a shareable challenge. `challenger_value` = solve time (ms). */
export function apiCreateChallenge(payload: {
  mechanic_id: string; variant_id: string; metric_key?: string; challenger_value: number;
}): Promise<ChallengeCreated | null> {
  return post<ChallengeCreated>('/api/challenges', { metric_key: 'time_ms', ...payload });
}

/** Read a challenge to play it (deep-link landing). */
export function apiGetChallenge(id: string): Promise<ChallengeView | null> {
  return get<ChallengeView>(`/api/challenges/${encodeURIComponent(id)}`);
}

/** Recipient opens the challenge (creates an attempt + mutual friend edge). */
export function apiAcceptChallenge(id: string): Promise<ChallengeView | null> {
  return post<ChallengeView>(`/api/challenges/${encodeURIComponent(id)}/accept`);
}

/** Recipient finishes → beat? + two-sided reward. `metric_value` = their solve time (ms). */
export function apiCompleteChallenge(id: string, metricValue: number): Promise<ChallengeComplete | null> {
  return post<ChallengeComplete>(`/api/challenges/${encodeURIComponent(id)}/complete`, { metric_value: metricValue });
}

// ── Island UGC generation / bake ─────────────────────────────────────────────

export type IslandDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
export type IslandDifficultyPreference = 'surprise' | IslandDifficulty;
export type IslandMotion = 'calm' | 'heavy' | 'bouncy' | 'chaotic';
export type IslandMotionPreference = 'surprise' | IslandMotion;

export interface IslandThemePack {
  id?: string;
  name: string;
  kw?: string[];
  ground: string;
  edge: string;
  sceneBg?: string;
  boardBg: string;
  belt?: string;
  outline?: string;
  items: string[];
  prop: 'mushroom' | 'crystal' | 'coral' | 'lollipop' | 'rock';
  body: string;
  roof: string;
  seed?: number;
  difficulty?: IslandDifficulty;
  motion?: IslandMotion;
  marbleStyle?: 'glossy' | 'matte' | 'glass' | 'metal' | 'gem' | 'bubble' | 'ember' | 'obsidian';
  markerStyle?: 'none' | 'rings' | 'dots' | 'stripes' | 'glyphs';
  targetShape?: 'capsule' | 'hex' | 'jar' | 'bowl' | 'crystal';
  conveyorPath?: 'racetrack' | 'oval' | 'compact' | 'wave';
  sourceShape?: 'bottle' | 'hopper' | 'silo' | 'flask';
  backgroundPattern?: 'solid' | 'grid' | 'stars' | 'bubbles' | 'embers';
}

export interface IslandStoredPack extends IslandThemePack {
  id: string;
  kw: string[];
}

export type IslandTemplateId = 'sort' | 'merge' | 'pins';

export interface IslandBuildingState {
  slot: number;
  tpl: IslandTemplateId;
  pack: string;
  name: string;
  plays: number;
  likes: number;
  liked: boolean;
  fresh?: boolean;
  prompt?: string;
  publishing?: boolean;
  publishError?: string;
  jobId?: string;
  rel?: string;
  url?: string;
}

export interface IslandPersistedState {
  tokens: number;
  buildings: IslandBuildingState[];
  aiPacks?: Record<string, IslandStoredPack>;
  aiSeq?: number;
}

export interface IslandStateResponse {
  state: IslandPersistedState | null;
  revision: number;
  schema_version: number;
  updated_at: string | null;
}

export function apiIslandState(): Promise<IslandStateResponse> {
  return getRequired<IslandStateResponse>('/api/island/state');
}

export function apiSaveIslandState(state: IslandPersistedState, expectedRevision: number): Promise<IslandStateResponse> {
  return putRequired<IslandStateResponse>('/api/island/state', {
    state,
    expected_revision: expectedRevision,
  });
}

export function apiIslandTheme(payload: {
  prompt: string;
  avoid?: string;
  difficulty?: IslandDifficultyPreference;
  motion?: IslandMotionPreference;
}): Promise<IslandThemePack> {
  return postRequired<IslandThemePack>('/api/island/theme', payload);
}

export interface IslandBakeJob {
  job_id: string;
  status: 'queued' | 'baking' | 'deploying' | 'ready' | 'published' | 'failed';
  rel: string;
  url: string;
  error: string;
  ready: boolean;
}

export function apiIslandBake(payload: { request_id: string; pack: IslandThemePack; prompt: string; tpl?: 'sort' }): Promise<IslandBakeJob> {
  return postRequired<IslandBakeJob>('/api/island/bake', payload);
}

export function apiIslandBakeJob(jobId: string): Promise<IslandBakeJob> {
  return getRequired<IslandBakeJob>(`/api/island/bake/${encodeURIComponent(jobId)}`);
}

export interface ChallengeInboxItem {
  id: string;
  mechanic_id: string;
  metric_key: string;
  challenger_value: number;
  challenger: ChallengeChallenger;
  played: boolean;
}

/** Incoming challenges to play (top-of-feed rail): friends' challenges I haven't beaten. */
export async function apiChallengeInbox(): Promise<ChallengeInboxItem[]> {
  const r = await get<{ box: string; items: ChallengeInboxItem[] }>('/api/challenges?box=in');
  return r?.items ?? [];
}

/** On-device diagnostics (open with ?diag=1). Surfaces exactly why persistence
 *  might fail: no Telegram, empty initData, auth 401 (BOT_TOKEN mismatch), etc. */
export async function apiDiagnose(): Promise<Record<string, unknown>> {
  const init = getInitData();
  const out: Record<string, unknown> = {
    hasTelegram: !!(window as any).Telegram?.WebApp,
    initDataLen: init ? init.length : 0,
    hasSignature: !!init && init.includes('signature='),
    apiBase: API_BASE,
  };
  try {
    const r = await fetch(`${API_BASE}/api/session`, { method: 'POST', headers: headers() });
    out.sessionStatus = r.status;
    out.sessionBody = (await r.text()).slice(0, 400);
  } catch (e) {
    out.sessionError = String(e);
  }
  return out;
}

/**
 * Deterministic uuid-format id per mechanic. W1 placeholder so /results has a
 * stable `variant_id` before W2 seeds real frozen variant specs (the server
 * lazily stubs unknown variants). NOT a real uuid5 — just stable + valid-format.
 */
export function variantIdForMechanic(mechanicId: string): string {
  let x = 0x811c9dc5 >>> 0;
  const hex: string[] = [];
  for (let i = 0; i < 32; i++) {
    x ^= mechanicId.charCodeAt(i % mechanicId.length) + i * 131;
    x = Math.imul(x, 0x01000193) >>> 0;
    hex.push(((x >>> 24) & 0xf).toString(16));
  }
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
