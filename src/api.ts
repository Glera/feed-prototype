/**
 * Backend client (swipe-backend). The TMA calls the backend by its ABSOLUTE URL
 * (Render Static can't proxy /api/*), CORS is enabled server-side. Every request
 * carries `Authorization: tma <initData>`. Outside Telegram getInitData() is null
 * → these all resolve to null and callers fall back to in-memory behaviour, so
 * the feed works unchanged in a plain browser / AppLovin.
 */
import { getInitData } from './telegram';
import type {
  CatalogRuntimeIdentityV1,
  CatalogTicketLevelSpecBundle,
  CatalogTicketLevelSpecBundleV1,
  CatalogTicketLevelSpecBundleV2,
} from './catalog-player-v2.mjs';
import type {
  CatalogCanaryAuthorityResultV1,
  CatalogFeedAuthorityRequestV1,
  CatalogFeedAuthorityResultV1,
  CatalogGeneratedOfferRequestV1,
  CatalogGeneratedOfferResultV1,
} from './catalog-feed-authority.mjs';
import type { FeedRosterSessionV1 } from './feed-roster.mjs';
import type {
  OperatorLevelFlagRequestV1,
  OperatorLevelFlagResponseV1,
} from './operator-level-flags.mjs';

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
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const configuredOutboxRequestTimeoutMs = Number(
  (import.meta as any).env?.VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
);
const OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS = Number.isFinite(configuredOutboxRequestTimeoutMs)
  && configuredOutboxRequestTimeoutMs >= 100
  && configuredOutboxRequestTimeoutMs <= 60_000
  ? Math.round(configuredOutboxRequestTimeoutMs)
  : 12_000;

async function withRequestTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return operation(undefined);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiRequestError(
        0,
        `Request timed out after ${timeoutMs}ms`,
        'request_timeout',
      ));
    }, timeoutMs);
  });
  try {
    // The explicit race also makes the deadline effective in test doubles which
    // do not implement AbortSignal. Native fetch still receives the signal so a
    // real hung socket is released rather than merely ignored.
    return await Promise.race([
      operation(controller.signal),
      timeout,
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function backendErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as {
    code?: unknown;
    detail?: unknown;
    error?: unknown;
  };
  const candidates = [
    body.code,
    typeof body.detail === 'object' && body.detail !== null
      ? (body.detail as { code?: unknown }).code
      : null,
    typeof body.error === 'object' && body.error !== null
      ? (body.error as { code?: unknown }).code
      : null,
  ];
  const code = candidates.find((candidate) =>
    typeof candidate === 'string' && /^[a-z][a-z0-9_]{1,95}$/.test(candidate));
  return typeof code === 'string' ? code : null;
}

async function postRequired<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let r: Response;
  let text: string;
  try {
    ({ response: r, text } = await withRequestTimeout(async (signal) => {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: headers(),
        body: body != null ? JSON.stringify(body) : undefined,
        signal,
      });
      return { response, text: await response.text() };
    }, timeoutMs));
  } catch (e) {
    if (e instanceof ApiRequestError) throw e;
    throw new ApiRequestError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw response */ }
  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? text ?? r.statusText;
    throw new ApiRequestError(
      r.status,
      `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      backendErrorCode(data),
    );
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
    throw new ApiRequestError(
      r.status,
      `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      backendErrorCode(data),
    );
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
    throw new ApiRequestError(
      r.status,
      `HTTP ${r.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
      backendErrorCode(data),
    );
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
  puzzles?: number;
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
  puzzles?: number;
  is_new: boolean;
  backend_version?: string;
  catalog_lab_authorization_available?: boolean;
  operator_level_flagging_available?: boolean;
  builtin_feed_bindings?: BuiltinFeedBindingsV1;
  feedRoster?: FeedRosterSessionV1;
}

/** Pilot-only exact field annotation. The server rechecks the Telegram user. */
export function apiCreateOperatorLevelFlagRequired(
  payload: OperatorLevelFlagRequestV1,
): Promise<OperatorLevelFlagResponseV1> {
  return postRequired<OperatorLevelFlagResponseV1>(
    '/api/operator-level-flags',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export interface BuiltinFeedBindingV1 {
  mapping_id: string;
  playable_id: string;
  variant_id: string;
  catalog_mechanic: string;
  mechanic_family: string;
  mapping_version: string;
  mapping_digest: string;
}

export interface BuiltinFeedBindingsV1 {
  schema: 'feed.builtin-bindings.v1';
  available: boolean;
  unavailable_reason: string | null;
  by_playable_id: Record<string, BuiltinFeedBindingV1>;
}

/** Ask the server policy to plan one already-projected built-in opportunity. */
export function apiGetCatalogFeedAuthorityRequired(
  payload: CatalogFeedAuthorityRequestV1,
): Promise<CatalogFeedAuthorityResultV1> {
  return postRequired<CatalogFeedAuthorityResultV1>('/api/feed/catalog-authority', payload);
}

/** Request one server-selected published offer; caller supplies no content identity. */
export function apiGetGeneratedOfferRequired(
  payload: CatalogGeneratedOfferRequestV1,
): Promise<CatalogGeneratedOfferResultV1> {
  return postRequired<CatalogGeneratedOfferResultV1>(
    '/api/feed/generated-offer',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** Read one account-bound invitation; the response contains no content identity. */
export function apiGetCatalogCanaryAuthorityRequired(): Promise<CatalogCanaryAuthorityResultV1> {
  return getRequired<CatalogCanaryAuthorityResultV1>('/api/catalog/canary-authority');
}

export interface CatalogAllocateAuthorizedRequestV2 {
  schema: 'catalog.allocate-authorized.v2';
  authorizationId: string;
}

export interface CatalogAllocationIdentityV1 {
  entryId: string;
  entryState: 'canary' | 'published';
  entryStateVersion: number;
  mechanic: string;
  variant: string;
  seriesId: string;
}

export interface CatalogAllocationManifestV1 {
  schema: 'series.manifest.v1';
  contentHash: string;
  seriesFingerprint: string;
  fingerprintVersion: string;
  levels: Array<{ ordinal: number; specHash: string }>;
}

export interface CatalogAllocationManifestV2 extends Omit<CatalogAllocationManifestV1, 'schema'> {
  schema: 'series.manifest.v2';
  skinHash: string;
  skinContractDigest: string;
  gameplayFingerprint: string;
  presentationFingerprint: string;
}

interface CatalogAllocationDecisionResultBaseV1 {
  schema: 'catalog.allocate-decision-result.v1';
  decisionId: string;
  allocationId: string;
  requestHash: string;
  requestedCatalogMechanic: string;
  slotType: string;
  policyVersion: string;
}

export type CatalogAllocationDecisionResultV1 = CatalogAllocationDecisionResultBaseV1 & (
  | {
    outcome: 'allocated';
    holdExpiresAt: string;
    catalog: CatalogAllocationIdentityV1;
    runtime: CatalogRuntimeIdentityV1;
    manifest: CatalogAllocationManifestV1;
  }
  | {
    outcome: 'policy_runway_empty';
    holdExpiresAt: null;
    catalog: null;
    runtime: null;
    manifest: null;
  }
);

interface CatalogAllocationDecisionResultBaseV2 extends Omit<CatalogAllocationDecisionResultBaseV1, 'schema'> {
  schema: 'catalog.allocate-decision-result.v2';
}

export type CatalogAllocationDecisionResultV2 = CatalogAllocationDecisionResultBaseV2 & {
  outcome: 'allocated';
  holdExpiresAt: string;
  catalog: CatalogAllocationIdentityV1;
  runtime: CatalogRuntimeIdentityV1;
  manifest: CatalogAllocationManifestV2;
};

export interface CatalogGeneratedOfferSelectionV1 {
  schema: 'feed.generated-offer-selection.v1';
  mode: 'affinity' | 'fallback_any';
  reason: 'favorite_eligible' | 'insufficient_affinity' | 'affinity_stale'
    | 'preferred_runway_empty';
  asOf: string;
  affinityConfig: { kind: 'affinity'; version: string; digest: string };
  slotConfig: { kind: 'slot'; version: string; digest: string };
  runwayConfig: { kind: 'runway'; version: string; digest: string };
  affinitySnapshotId: string | null;
  preferredMechanic: string | null;
  poolKind: 'unseen' | 'released_repeat';
  poolDigest: string;
  tieDigest: string;
}

export type CatalogAllocationDecisionResultV3 = Omit<
  CatalogAllocationDecisionResultBaseV1,
  'schema'
> & {
  schema: 'catalog.allocate-decision-result.v3';
  outcome: 'allocated';
  holdExpiresAt: string;
  catalog: CatalogAllocationIdentityV1;
  runtime: CatalogRuntimeIdentityV1;
  manifest: CatalogAllocationManifestV1 | CatalogAllocationManifestV2;
  offerSelection: CatalogGeneratedOfferSelectionV1;
};

export type CatalogAllocationDecisionResult =
  | CatalogAllocationDecisionResultV1
  | CatalogAllocationDecisionResultV2
  | CatalogAllocationDecisionResultV3;

export interface CatalogAllocateAuthorizedResultV2 {
  schema: 'catalog.allocate-authorized-result.v2';
  authorizationId: string;
  authorizationDigest: string;
  allocation: CatalogAllocationDecisionResult;
}

/** Additive player-v2 transport; the only real-feed caller is triple-gated. */
export function apiAllocateAuthorizedCatalogRequired(
  payload: CatalogAllocateAuthorizedRequestV2,
): Promise<CatalogAllocateAuthorizedResultV2> {
  return postRequired<CatalogAllocateAuthorizedResultV2>('/api/catalog/allocate-authorized', payload);
}

/** Fetch specs through an active server-owned ticket, never by client hashes. */
export function apiGetCatalogTicketSpecsRequired(
  ticketId: string,
): Promise<CatalogTicketLevelSpecBundle> {
  return getRequired<CatalogTicketLevelSpecBundle>(
    `/api/catalog/tickets/${encodeURIComponent(ticketId)}/specs`,
  );
}

export type {
  CatalogTicketLevelSpecBundle,
  CatalogTicketLevelSpecBundleV1,
  CatalogTicketLevelSpecBundleV2,
};

export interface ResultResp {
  is_best: boolean;
  stars_awarded: number;
  balance: number;
  puzzles_awarded?: number;
  puzzle_balance?: number;
}

export function apiSession(): Promise<SessionResp | null> {
  return post<SessionResp>('/api/session');
}

export interface ResultIn {
  schema?: 'catalog.result.v2';
  mechanic_id: string;
  variant_id: string;
  run_id: string;
  metric_key: string;
  metric_value: number;
  stars?: number;   // display hint; zero marks an intermediate series level
  expected_puzzles?: number; // local outbox reconciliation only; never sent
  run_ticket?: RunTicketRequest; // durable local start intent; API receives ticket_id only
  series_level?: number;
  // Catalog-v2 level binding is all-or-none; chest rows carry only series_id.
  series_id?: string;
  ordinal?: number;
  applied_spec_hash?: string;
  applied_skin_hash?: string;
  complete_challenge_id?: string; // durable post-result action; never sent to /results
  server_confirmed?: boolean; // local outbox state; never sent
  tz_offset_minutes?: number;
}

function resultPayload(payload: ResultIn): Record<string, unknown> {
  const {
    expected_puzzles,
    run_ticket,
    complete_challenge_id,
    server_confirmed,
    ...body
  } = payload;
  void expected_puzzles;
  void complete_challenge_id;
  void server_confirmed;
  return {
    ...body,
    ticket_id: run_ticket?.ticket_id,
  };
}

export function apiPostResult(payload: ResultIn): Promise<ResultResp | null> {
  return post<ResultResp>('/api/results', resultPayload(payload));
}

export function apiPostResultRequired(payload: ResultIn): Promise<ResultResp> {
  return postRequired<ResultResp>(
    '/api/results',
    resultPayload(payload),
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

interface CatalogResultBaseV2 {
  mechanic_id: string;
  variant_id: string;
  run_id: string;
  ticket_id: string;
  metric_value: number;
  series_id: string;
  stars?: number;
  tz_offset_minutes?: number;
}

export interface CatalogLevelResultV2 extends CatalogResultBaseV2 {
  metric_key: 'time_ms';
  series_level: number;
  ordinal: number;
  applied_spec_hash: string;
}

export interface CatalogChestResultV2 extends CatalogResultBaseV2 {
  metric_key: 'series';
  series_level?: never;
  ordinal?: never;
  applied_spec_hash?: never;
}

export interface CatalogSkinLevelResultV2 extends CatalogLevelResultV2 {
  schema: 'catalog.result.v2';
  applied_skin_hash: string;
}

export interface CatalogSkinChestResultV2 extends CatalogChestResultV2 {
  schema: 'catalog.result.v2';
  applied_skin_hash?: never;
}

export function apiPostCatalogLevelResultRequired(payload: CatalogLevelResultV2): Promise<ResultResp> {
  return postRequired<ResultResp>('/api/results', payload, OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS);
}

export function apiPostCatalogChestResultRequired(payload: CatalogChestResultV2): Promise<ResultResp> {
  return postRequired<ResultResp>('/api/results', payload, OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS);
}

export interface LegacyRunTicketRequest {
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'single' | 'series';
  challenge_id?: string;
  schema?: never;
  decision_id?: never;
}

export interface CatalogRunTicketRequestV2 {
  schema: 'run.start.v2';
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'series';
  decision_id: string;
  challenge_id?: null;
}

export type RunTicketRequest = LegacyRunTicketRequest | CatalogRunTicketRequestV2;

export interface LegacyRunTicketView {
  ticket_id: string;
  run_id: string;
  kind: 'single' | 'series';
  expected_levels: number;
  completed_levels: number;
  next_result_at: string;
  expires_at: string;
  state: 'active' | 'consumed' | 'expired';
}

export interface CatalogRunTicketViewV2 {
  schema: 'run.ticket.v2';
  ticket_id: string;
  run_id: string;
  kind: 'series';
  mechanic_id: string;
  variant_id: string;
  decision_id: string;
  catalog_entry_id: string;
  series_id: string;
  runtime_release_id: string;
  runtime_contract_digest: string;
  runtime_artifact_digest: string;
  manifest_content_hash: string;
  levels: Array<{ ordinal: number; spec_hash: string }>;
  expected_levels: number;
  completed_levels: number;
  next_result_at: string;
  expires_at: string;
  state: 'active' | 'consumed' | 'expired' | 'revoked' | 'superseded';
}

export interface CatalogRunTicketViewV3 extends Omit<CatalogRunTicketViewV2, 'schema'> {
  schema: 'run.ticket.v3';
  skin_hash: string;
  skin_contract_digest: string;
}

export type RunTicketView = LegacyRunTicketView | CatalogRunTicketViewV2 | CatalogRunTicketViewV3;

export function apiStartCatalogRunRequired(
  payload: CatalogRunTicketRequestV2,
): Promise<CatalogRunTicketViewV2 | CatalogRunTicketViewV3> {
  return postRequired<CatalogRunTicketViewV2 | CatalogRunTicketViewV3>(
    '/api/runs/start',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiStartRun(payload: RunTicketRequest): Promise<RunTicketView | null> {
  return post<RunTicketView>('/api/runs/start', payload);
}

export function apiStartRunRequired(payload: RunTicketRequest): Promise<RunTicketView> {
  return postRequired<RunTicketView>(
    '/api/runs/start',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export interface DailyQuestView {
  id: string;
  title: string;
  progress: number;
  target: number;
  reward_puzzles: number;
  completed: boolean;
  claimed: boolean;
}

export interface DailyStateResp {
  day: string;
  reset_at: string;
  seconds_remaining: number;
  puzzle_balance: number;
  quests: DailyQuestView[];
}

function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function currentTzOffsetMinutes(): number {
  return tzOffsetMinutes();
}

export function apiDailySync(): Promise<DailyStateResp | null> {
  return post<DailyStateResp>('/api/daily/sync', { tz_offset_minutes: tzOffsetMinutes() });
}

export function apiDailyClaim(questId: string): Promise<DailyStateResp | null> {
  return post<DailyStateResp>('/api/daily/claim', { quest_id: questId, tz_offset_minutes: tzOffsetMinutes() });
}

/** QA only: begin a fresh daily cycle while preserving already-earned puzzles. */
export function apiResetDaily(): Promise<(DailyStateResp & { ok: boolean }) | null> {
  return post<DailyStateResp & { ok: boolean }>('/api/reset-daily', { tz_offset_minutes: tzOffsetMinutes() });
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

/** Create a shareable challenge from an immutable verified solve-time run. */
export function apiCreateChallenge(payload: {
  mechanic_id: string; variant_id: string; metric_key?: string; source_run_id: string;
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

/** Complete a challenge from its challenge-bound verified run. */
export function apiCompleteChallenge(id: string, sourceRunId: string): Promise<ChallengeComplete | null> {
  return post<ChallengeComplete>(`/api/challenges/${encodeURIComponent(id)}/complete`, {
    source_run_id: sourceRunId,
    tz_offset_minutes: tzOffsetMinutes(),
  });
}

export function apiCompleteChallengeRequired(id: string, sourceRunId: string): Promise<ChallengeComplete> {
  return postRequired<ChallengeComplete>(`/api/challenges/${encodeURIComponent(id)}/complete`, {
    source_run_id: sourceRunId,
    tz_offset_minutes: tzOffsetMinutes(),
  });
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
  buildingId?: string;
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

export interface PublicIslandView {
  owner: { id: number; first_name: string | null; username: string | null };
  buildings: IslandBuildingState[];
  aiPacks?: Record<string, IslandStoredPack> | null;
  deep_link: string;
  share_url: string;
}

export interface IslandSocialView {
  building_id: string;
  plays: number;
  likes: number;
  liked: boolean;
  changed?: boolean;
}

export interface IslandVisitView {
  visit_id: string;
  building_id: string;
  owner_id: number;
  state: 'active' | 'completed';
  expires_at: string;
  social: IslandSocialView;
}

export function apiPublicIsland(ownerId: number): Promise<PublicIslandView> {
  return getRequired<PublicIslandView>(`/api/island/public/${encodeURIComponent(ownerId)}`);
}

export function apiStartIslandVisit(payload: {
  visit_id: string;
  owner_id: number;
  building_id: string;
}): Promise<IslandVisitView> {
  return postRequired<IslandVisitView>('/api/island/visits/start', payload);
}

export function apiCompleteIslandVisit(visitId: string): Promise<IslandVisitView> {
  return postRequired<IslandVisitView>(`/api/island/visits/${encodeURIComponent(visitId)}/complete`);
}

export function apiSetIslandLike(buildingId: string, ownerId: number, liked: boolean): Promise<IslandSocialView> {
  return putRequired<IslandSocialView>(`/api/island/buildings/${encodeURIComponent(buildingId)}/like`, {
    owner_id: ownerId,
    liked,
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

// ── Catalog Lab device authorization (dev users only) ──────────────────────

export type CatalogLabDeviceState = 'pending' | 'approved' | 'denied' | 'consumed';

export interface CatalogPromotionSummaryLevel {
  ordinal: number;
  specHash: string;
  evaluationId: string;
  reviewTargetId: string;
}

export interface CatalogPromotionSingleSummary {
  schema: 'catalog.promotion-summary.v1' | 'catalog.promotion-summary.v2';
  publishId: string;
  requestHash: string;
  contentHash: string;
  mechanic: string;
  variant: string;
  runtimeArtifactDigest: string;
  seriesReviewTargetId?: string;
  levels: CatalogPromotionSummaryLevel[];
  reason: string;
  skin?: {
    skinHash: string;
    skinContractDigest: string;
    reviewTargetId: string;
    params: Record<string, unknown>;
  };
}

export interface CatalogPromotionBatchSummaryItem {
  ordinal: number;
  publishId: string;
  requestHash: string;
  contentHash: string;
  bindingHash: string;
  summary: CatalogPromotionSingleSummary;
}

export interface CatalogPromotionBatchSummary {
  schema: 'catalog.promotion-summary-batch.v1';
  publishId: string;
  requestHash: string;
  contentHash: string;
  reason: string;
  items: CatalogPromotionBatchSummaryItem[];
}

export interface CatalogPromotionArtifactSummary {
  schema: 'catalog.artifact-promotion-summary.v1';
  publishId: string;
  requestHash: string;
  contentHash: string;
  reviewTargetId: string;
  title: string;
  description: string;
  artPackHash: string;
  runtimeArtifactDigest: string;
  gameplayFingerprint: string;
  presentationFingerprint: string;
  reason: string;
}

export type CatalogPromotionSummary =
  | CatalogPromotionSingleSummary
  | CatalogPromotionBatchSummary
  | CatalogPromotionArtifactSummary;

export interface CatalogLabDeviceAuthorization {
  authorizationId: string;
  clientName: string;
  clientInstanceId: string;
  scopes: string[];
  state: CatalogLabDeviceState;
  expiresAt: string;
  decisionVersion: number;
  promotionSummary?: CatalogPromotionSummary;
}

export interface CatalogLabGrantView {
  jti: string;
  clientInstanceId: string;
  clientName: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  revocationEpoch: number;
  revokedAt: string | null;
  active: boolean;
}

/** Resolve a short user code entered by an allowlisted Telegram dev. */
export function apiCatalogLabLookup(userCode: string): Promise<CatalogLabDeviceAuthorization> {
  return postRequired<CatalogLabDeviceAuthorization>('/api/admin/device-auth/lookup', { userCode });
}

/** Approve or deny exactly the authorization returned by lookup. */
export function apiCatalogLabDecision(payload: {
  authorizationId: string;
  userCode: string;
  expectedDecisionVersion: number;
  decision: 'approve' | 'deny';
}): Promise<CatalogLabDeviceAuthorization> {
  return postRequired<CatalogLabDeviceAuthorization>('/api/admin/device-auth/decision', payload);
}

/** Metadata only: the backend never returns bearer tokens to the TMA. */
export async function apiCatalogLabTokens(): Promise<CatalogLabGrantView[]> {
  const response = await getRequired<{ tokens: CatalogLabGrantView[] }>('/api/admin/lab-tokens');
  return response.tokens;
}

export function apiRevokeCatalogLabToken(
  jti: string,
  expectedRevocationEpoch: number,
  reason: string,
): Promise<CatalogLabGrantView> {
  return postRequired<CatalogLabGrantView>(
    `/api/admin/lab-tokens/${encodeURIComponent(jti)}/revoke`,
    { expectedRevocationEpoch, reason },
  );
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
