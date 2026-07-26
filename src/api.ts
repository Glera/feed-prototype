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
import { validateChallengeLevelBundle } from './challenge-player.mjs';
import type { ChallengeLevelSpecBundleV1 } from './challenge-player.mjs';

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
    // Parsed `Retry-After` (ms) when the server sent one — used by bounded
    // retry loops (e.g. the island 425 "played too early" claim path).
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
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

async function postRequired<T>(
  path: string,
  body?: unknown,
  timeoutMs?: number,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let r: Response;
  let text: string;
  try {
    ({ response: r, text } = await withRequestTimeout(async (signal) => {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: extraHeaders ? { ...headers(), ...extraHeaders } : headers(),
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
      parseRetryAfterMs(r.headers.get('Retry-After')),
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

async function deleteRequired<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method: 'DELETE',
      headers: headers(),
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

async function getRequired<T>(
  path: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      headers: extraHeaders ? { ...headers(), ...extraHeaders } : headers(),
      signal,
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
export function apiGetCatalogCanaryAuthorityRequired(
  signal?: AbortSignal,
): Promise<CatalogCanaryAuthorityResultV1> {
  return getRequired<CatalogCanaryAuthorityResultV1>('/api/catalog/canary-authority', signal);
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

export interface CatalogAllocationManifestV3 extends Omit<CatalogAllocationManifestV1, 'schema'> {
  schema: 'series.manifest.v3';
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
  manifest: CatalogAllocationManifestV1 | CatalogAllocationManifestV2
    | CatalogAllocationManifestV3;
  offerSelection: CatalogGeneratedOfferSelectionV1;
};

export type CatalogAllocationDecisionResultV4 = Omit<
  CatalogAllocationDecisionResultBaseV1,
  'schema'
> & {
  schema: 'catalog.allocate-decision-result.v4';
  outcome: 'allocated';
  holdExpiresAt: string;
  catalog: CatalogAllocationIdentityV1;
  runtime: CatalogRuntimeIdentityV1;
  manifest: CatalogAllocationManifestV3;
};

export type CatalogAllocationDecisionResult =
  | CatalogAllocationDecisionResultV1
  | CatalogAllocationDecisionResultV2
  | CatalogAllocationDecisionResultV3
  | CatalogAllocationDecisionResultV4;

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

/** Bootstrap variant which preserves an authenticated rejection instead of
 * silently collapsing it into the ordinary offline fallback. The feed remains
 * playable on failure, but can now tell the player when Telegram must mint a
 * fresh WebApp credential before catalog content is reachable. */
export function apiSessionRequired(): Promise<SessionResp> {
  return postRequired<SessionResp>('/api/session');
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
  // Share/Challenge v1: recipient's applied content-addressed challenge WRAPPER
  // digest, verified server-side against the pre-play ticket binding on /results
  // (P1-1). Distinct from applied_spec_hash (the per-level catalog LevelSpec hash);
  // a challenge ticket carries no catalog binding. Omitted for non-challenge runs.
  applied_spec_digest?: string;
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
  contentDigest?: string;
  // Development/rolling-compatibility only. Production closed delivery never
  // receives or persists an artifact URL in island state.
  url?: string;
  // ── Island Social Core (P1) server-derived fields ──────────────────────────
  // All optional and read-only: the backend adds them to /island/state (owner)
  // and /island/public (guest). The client only renders them; they are never
  // authored locally. `stage` = min(foreign_claims, 10). `bot_claims` is the
  // "system neighbour" (bot) portion of foreign_claims, shown separately (F006).
  stage?: number;
  foreign_claims?: number;
  bot_claims?: number;
  pending_gifts?: number;        // owner /island/state — uncollected gifts (0..9)
  gift_available_today?: boolean; // guest /island/public — a gift is offered today
  is_public?: boolean;            // published UGC artifact (visible to guests)
  takedown?: boolean;             // moderation-removed (P3); hidden from guests
  // Builtin binding (ТЗ v1.4 §3.1, F007): for a bot builtin building the runtime is
  // resolved from `mechanicId` (the identity/runtime authority), NEVER from the
  // mutable `tpl`. Present only on builtin (bot) buildings in /island/public;
  // absent for player UGC.
  builtin?: IslandBuiltinBinding;
}

export interface IslandBuiltinBinding {
  // Runtime authority — resolves to a first-party playable; fail-closed if unknown.
  mechanicId: string;
  // Rotation/audit record only (identity, not a client-verifiable content digest).
  // The platform has no versioned builtin delivery — delivery is the current deploy.
  rosterRevision?: string;
  versionsDigest?: string;
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
  owner: {
    id: number;
    first_name: string | null;
    username: string | null;
    photo_url?: string | null; // Island Social Core: from TMA initData (§2.2)
    is_bot?: boolean;          // Island Social Core: bot island → "бот" badge (§4.3)
  };
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

// ── Island Social Core (P1) — gifts, collect, friends ───────────────────────
// Backend routes are gated by ENABLE_ISLAND_SOCIAL server-side; forms track ТЗ
// v1.3 §2.2 exactly. Every function degrades through the ApiRequestError path so
// the client can show an honest toast without breaking the visit/play flow.

/** Guest completion-claim disposition (ТЗ §2.2 result response). */
export type IslandGiftDisposition =
  | 'granted' | 'repeat_day' | 'daily_cap' | 'rewards_disabled' | 'zero_policy';

/** Owner-collect receipt disposition (ТЗ §2.2 collect response). */
export type IslandCollectDisposition =
  | 'granted' | 'empty' | 'daily_cap' | 'rewards_disabled';

/** Response of POST /island/visits/{visit_id}/result — a projection of the
 *  immutable completion-outcome receipt (ТЗ §2.2). */
export interface IslandVisitResult {
  claim_recorded: boolean;
  stage: number;
  foreign_claims: number;
  disposition: IslandGiftDisposition;
  gift: { puzzles: number } | null;
}

/** Guest claims a completed visit; the server gates min-time, cooldown, caps and
 *  the reward kill-switch, and always writes a terminal receipt (ТЗ §2.2). */
export function apiIslandVisitResult(
  visitId: string,
  durationMs: number,
): Promise<IslandVisitResult> {
  return postRequired<IslandVisitResult>(
    `/api/island/visits/${encodeURIComponent(visitId)}/result`,
    { outcome: 'completed', duration_ms: Math.max(0, Math.round(durationMs)) },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** Response of POST /island/buildings/{building_id}/collect — a projection of the
 *  append-only collect receipt (ТЗ §2.2). `pending_gifts` is the materialised
 *  counter after the collect so the client can repaint the badge. */
export interface IslandCollectResult {
  disposition: IslandCollectDisposition;
  gifts: number;
  puzzles: number;
  pending_gifts?: number;
}

/** Owner collects piled gifts. `claimId` MUST be persisted before the request and
 *  reused on retry so the append-only receipt is idempotent (ТЗ §2.2). */
export function apiIslandCollect(
  buildingId: string,
  claimId: string,
): Promise<IslandCollectResult> {
  return postRequired<IslandCollectResult>(
    `/api/island/buildings/${encodeURIComponent(buildingId)}/collect`,
    { claim_id: claimId },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export interface IslandActivityEvent {
  claim_id: string;
  seq: number;
  occurred_at: string;
  source: 'human' | 'bot';
  actor: {
    id: number;
    name: string;
    is_bot: boolean;
  };
  building: {
    id: string;
    name: string;
  };
}

export interface IslandActivityPage {
  schema: 'island.activity.v1';
  cursor: number;
  events: IslandActivityEvent[];
}

/** Read only server-recorded completion claims for the caller's own island.
 * Omitting `afterSeq` bootstraps the current high-water mark without replaying
 * historical activity. */
export function apiIslandActivity(afterSeq?: number): Promise<IslandActivityPage> {
  const query = afterSeq == null
    ? ''
    : `?after_seq=${encodeURIComponent(String(Math.max(0, Math.floor(afterSeq))))}`;
  return getRequired<IslandActivityPage>(`/api/island/activity${query}`);
}

export interface IslandFriend {
  user_id: number;
  first_name: string | null;
  username: string | null;
  photo_url: string | null;
  is_bot: boolean;
  has_island: boolean;
  published_buildings: number;
}

/** POST /island/friends/code → a durable invite code + deep-link (ТЗ §2.2). */
export interface IslandFriendCodeResult {
  code: string;
  link: string;
}

export function apiIslandFriendCode(): Promise<IslandFriendCodeResult> {
  return postRequired<IslandFriendCodeResult>(
    '/api/island/friends/code',
    undefined,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** POST /island/friends/accept {code}. The response body is not fully pinned in
 *  ТЗ §2.2 (только коды ошибок 400/404/409, 200 no-op); we read the new friend's
 *  profile best-effort for the toast and never depend on a specific field. */
export interface IslandFriendAcceptResult {
  status?: string;
  friend?: Partial<IslandFriend> | null;
}

export function apiIslandFriendAccept(code: string): Promise<IslandFriendAcceptResult> {
  return postRequired<IslandFriendAcceptResult>(
    '/api/island/friends/accept',
    { code },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** GET /island/friends → active friendships (ТЗ §2.2). Accepts either a bare
 *  array or a `{friends:[...]}` envelope so the client is resilient to either. */
export async function apiIslandFriends(): Promise<IslandFriend[]> {
  const r = await getRequired<IslandFriend[] | { friends?: IslandFriend[] }>('/api/island/friends');
  if (Array.isArray(r)) return r;
  return r?.friends ?? [];
}

export function apiIslandFriendRemove(userId: number): Promise<{ removed: boolean }> {
  return deleteRequired<{ removed: boolean }>(
    `/api/island/friends/${encodeURIComponent(String(userId))}`,
  );
}

export function apiIslandFriendBlock(
  userId: number,
  blocked: boolean,
): Promise<{ blocked: boolean; friendship_removed: boolean }> {
  return putRequired<{ blocked: boolean; friendship_removed: boolean }>(
    `/api/island/friends/${encodeURIComponent(String(userId))}/block`,
    { blocked },
  );
}

export interface IslandVisitAwardTarget {
  owner_id: number;
  first_name: string | null;
  username: string | null;
  photo_url: string | null;
  is_bot: boolean;
  deep_link: string;
}

export interface IslandVisitAward {
  run_id: string;
  roll_id: string;
  won: boolean;
  holdout: boolean;
  state: 'offered' | 'accepted' | 'declined';
  target: IslandVisitAwardTarget | null;
  gift_preview: { puzzles: number } | null;
}

export function apiIslandVisitAwardFromChest(runId: string): Promise<IslandVisitAward> {
  return postRequired<IslandVisitAward>(
    '/api/island/visit-award/from-chest',
    { run_id: runId },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandVisitAwardResolve(
  rollId: string,
  action: 'accept' | 'decline',
): Promise<IslandVisitAward> {
  return postRequired<IslandVisitAward>(
    `/api/island/visit-award/${encodeURIComponent(rollId)}/${action}`,
    undefined,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandWriteAccess(
  allowsWritePm: boolean,
): Promise<{ allows_write_pm: boolean }> {
  return putRequired<{ allows_write_pm: boolean }>(
    '/api/island/notifications/write-access',
    { allows_write_pm: allowsWritePm },
  );
}

/** Durable `/island/theme` job (backend §5.1). POST returns 202 {job_id}; the
 *  client polls it to terminal `ready` (with the pack) or `failed`. */
export interface IslandThemeJob {
  job_id: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  pack?: IslandThemePack;
  error?: string;
}

// ── Island Social Core (P3) — guest report + operator moderation ────────────
// Report is a guest route (gated server-side by ENABLE_ISLAND_SOCIAL). The
// moderation routes are ADDITIONALLY gated by the server-enforced
// `island_moderator_ids` allowlist on every request (ТЗ §2.2, F015): the client
// ?diag=1 moderation page is navigation only, NOT an authorization boundary —
// a non-moderator caller simply gets 403 from the server.

export type IslandReportReason = 'inappropriate' | 'broken' | 'other';

export interface IslandReportResult {
  report_id: string;
  building_id: string;
  reason: string;
  status: string;
  created_at: string | null;
}

/** POST /island/buildings/{id}/report — a guest reports a published building.
 *  The server pins the exact artifact revision at report time, dedups by
 *  (building, reporter) — a repeat returns the saved row (200) — and rate-limits
 *  per UTC day (ТЗ §2.2, F011). */
export function apiIslandReport(
  buildingId: string,
  reason: IslandReportReason,
  text?: string,
): Promise<IslandReportResult> {
  const trimmed = text && text.trim() ? text.trim().slice(0, 500) : null;
  return postRequired<IslandReportResult>(
    `/api/island/buildings/${encodeURIComponent(buildingId)}/report`,
    { reason, text: trimmed },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export interface IslandModerationOwner {
  id: number;
  first_name: string | null;
  username: string | null;
  is_bot?: boolean;
}

export interface IslandModerationPublication {
  building_id: string;
  owner: IslandModerationOwner;
  name: string;
  prompt: string | null;
  rel: string | null;
  url: string | null;
  counts: {
    plays: number;
    likes: number;
    bot_likes: number;
    foreign_claims: number;
    bot_claims: number;
    pending_gifts: number;
  };
  reports: { open: number; total: number };
  taken_down: boolean;
  created_at: string | null;
}

export interface IslandModerationReport {
  report_id: string;
  building_id: string;
  owner: IslandModerationOwner | null;
  reporter_id: number;
  reason: string;
  text: string | null;
  status: string;
  artifact_rel: string | null;
  taken_down: boolean;
  created_at: string | null;
}

export interface IslandTakedownResult {
  building_id: string;
  taken_down: boolean;
  artifact_rel: string | null;
}

export function apiIslandModerationPublications(
  opts: { limit?: number; before?: string | null } = {},
): Promise<{ publications: IslandModerationPublication[]; next_before: string | null }> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.before) params.set('before', opts.before);
  return withRequestTimeout(
    (signal) => getRequired(
      `/api/island/moderation/publications?${params.toString()}`,
      signal,
    ),
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandModerationReports(
  opts: { status?: string; before?: string | null } = {},
): Promise<{ reports: IslandModerationReport[]; next_before: string | null }> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.before) params.set('before', opts.before);
  const q = params.toString();
  return withRequestTimeout(
    (signal) => getRequired(
      `/api/island/moderation/reports${q ? `?${q}` : ''}`,
      signal,
    ),
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** POST /island/moderation/takedown — the exact artifact_rel reviewed must match
 *  the building's current revision or the server returns 409 (F011). */
export function apiIslandModerationTakedown(
  buildingId: string,
  artifactRel: string,
  reason?: string,
): Promise<IslandTakedownResult> {
  return postRequired<IslandTakedownResult>(
    '/api/island/moderation/takedown',
    { building_id: buildingId, artifact_rel: artifactRel, reason: reason ?? null },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandModerationRestore(
  buildingId: string,
  reason?: string,
): Promise<IslandTakedownResult> {
  return postRequired<IslandTakedownResult>(
    '/api/island/moderation/restore',
    { building_id: buildingId, reason: reason ?? null },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandModerationResolveReport(
  reportId: string,
  status: 'reviewed' | 'dismissed' | 'escalated',
  reason?: string,
): Promise<IslandModerationReport> {
  return postRequired<IslandModerationReport>(
    `/api/island/moderation/reports/${encodeURIComponent(reportId)}/resolve`,
    { status, reason: reason ?? null },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandTheme(payload: {
  request_id?: string;
  prompt: string;
  avoid?: string;
  difficulty?: IslandDifficultyPreference;
  motion?: IslandMotionPreference;
}): Promise<IslandThemeJob> {
  return postRequired<IslandThemeJob>(
    '/api/island/theme',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

export function apiIslandThemeJob(
  jobId: string,
  timeoutMs: number = OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
): Promise<IslandThemeJob> {
  return withRequestTimeout(
    (signal) => getRequired<IslandThemeJob>(
      `/api/island/theme/${encodeURIComponent(jobId)}`,
      signal,
    ),
    Math.min(OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)),
  );
}

export interface IslandBakeJob {
  job_id: string;
  status: 'queued' | 'baking' | 'deploying' | 'ready' | 'published' | 'failed';
  rel: string;
  content_digest?: string;
  url?: string;
  error: string;
  ready: boolean;
}

export function apiIslandBake(payload: { request_id: string; pack: IslandThemePack; prompt: string; tpl?: 'sort' }): Promise<IslandBakeJob> {
  return postRequired<IslandBakeJob>('/api/island/bake', payload);
}

export function apiIslandBakeJob(jobId: string): Promise<IslandBakeJob> {
  return getRequired<IslandBakeJob>(`/api/island/bake/${encodeURIComponent(jobId)}`);
}

export interface IslandArtifactUrl {
  building_id: string;
  rel: string;
  contentDigest: string;
  url: string;
  expires_at: string;
}

export function apiIslandArtifactUrl(buildingId: string): Promise<IslandArtifactUrl> {
  return getRequired<IslandArtifactUrl>(
    `/api/island/artifact-url?building_id=${encodeURIComponent(buildingId)}`,
  );
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

// ── Share / Challenge v1 (content-addressed level identity) ──────────────────
// Spec-bound routes require the wire header (missing/unsupported → 426). All v1
// functions use the `*Required` transports so a typed error (426/404/409/410) is
// preserved for the caller instead of collapsing into the silent-degrade path
// that the legacy functions above intentionally use. Everything here is gated on
// the client by VITE_CHALLENGE_V1_ENABLED (see challenge-config).

export const CHALLENGE_WIRE_HEADER = 'X-P4G-Challenge-Wire-Version';
export const CHALLENGE_WIRE_VERSION = 1;
function challengeWireHeaders(): Record<string, string> {
  return { [CHALLENGE_WIRE_HEADER]: String(CHALLENGE_WIRE_VERSION) };
}

/** Spec-bound recipient view of a v1 challenge (GET /challenges/{id} + wire). */
export interface ChallengeSpecBoundView extends ChallengeView {
  spec_digest: string;
  wire_version: number;
  params: Record<string, unknown> | null;
  playable_id: string | null;
  adapter_version: number | null;
  runtime_url: string | null;
  expired: boolean;
}

/** Challenge source spec (run.start.challenge.v1). Recipient run.start never
 *  sends this — the server derives the recipient spec from challenge.spec_digest. */
export interface ChallengeSourceSpecV1 {
  playableId: string;
  adapterVersion: number;
  schemaVersion: number;
  params: Record<string, unknown>;
}

/** run.start.challenge.v1 source request (challenger freezes a spec BEFORE play). */
export interface ChallengeSourceRunRequest {
  schema: 'run.start.challenge.v1';
  purpose: 'challenge_source';
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'single';
  challengeSpec: ChallengeSourceSpecV1;
}

/** Recipient run.start request (challenge_id only; NO challengeSpec/schema). */
export interface ChallengeRecipientRunRequest {
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'single';
  challenge_id: string;
}

/**
 * Create a v1 challenge from an immutable, spec-bound verified source run. The
 * caller MUST persist `request_id` (a uuid) before the call and reuse it on retry
 * so the append-only create event is idempotent (D7). `request_digest` is
 * OPTIONAL on the wire — the server recomputes it; when supplied it must agree.
 */
export function apiCreateChallengeV1Required(payload: {
  mechanic_id: string;
  variant_id: string;
  source_run_id: string;
  request_id: string;
  request_digest?: string;
}): Promise<ChallengeCreated> {
  return postRequired<ChallengeCreated>(
    '/api/challenges',
    { metric_key: 'time_ms', ...payload },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/**
 * Server-issued challenge SOURCE level (v1.4.2 D12). The client cannot author a
 * source level (built-in sort levels are non-declarative on the client; catalog
 * runs are forbidden by D4), so the server picks an operator-approved published
 * sort level, freezes it into the challenge contour and returns the full
 * challengeSpec + spec_digest. The caller MUST persist `request_id` before the
 * call and reuse it on retry (idempotent: a repeat returns the same offer). The
 * returned `challengeSpec` carries the runtime digests for reference; run.start
 * accepts only the four authored fields (see apiStartChallengeSourceRunRequired).
 */
export interface ChallengeSourceLevelOffer {
  request_id: string;
  spec_digest: string;
  challengeSpec: {
    playableId: string;
    adapterVersion: number;
    schemaVersion: number;
    params: Record<string, unknown>;
    runtimeContractDigest: string;
    runtimeArtifactDigest: string;
  };
}

export function apiCreateSourceLevelRequired(requestId: string): Promise<ChallengeSourceLevelOffer> {
  return postRequired<ChallengeSourceLevelOffer>(
    '/api/challenges/source-level',
    { request_id: requestId },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
    challengeWireHeaders(),
  );
}

/** Read a spec-bound v1 challenge to play it (deep-link landing). */
export function apiGetChallengeSpecBoundRequired(id: string): Promise<ChallengeSpecBoundView> {
  return getRequired<ChallengeSpecBoundView>(
    `/api/challenges/${encodeURIComponent(id)}`,
    undefined,
    challengeWireHeaders(),
  );
}

/**
 * Fetch the challenge-scoped level-delivery bundle for a ticket the caller owns
 * (the exact level + content-addressed runtime, no catalog identity). The bundle
 * is validated with the same strict contract the sibling player enforces.
 */
export async function apiGetChallengeLevelBundleRequired(
  ticketId: string,
): Promise<ChallengeLevelSpecBundleV1> {
  const raw = await getRequired<unknown>(
    `/api/challenges/tickets/${encodeURIComponent(ticketId)}/level-bundle`,
    undefined,
    challengeWireHeaders(),
  );
  return validateChallengeLevelBundle(raw);
}

/**
 * Read a challenge WITHOUT the wire header, surfacing the HTTP status. A legacy
 * challenge returns its view (200); a spec-bound v1 challenge returns a typed 426
 * `challenge_client_upgrade_required`. Used at flag OFF to honestly distinguish a
 * v1 deep-link (→ "please update" toast) from a genuinely missing/offline one,
 * instead of the silent-null the legacy getter collapses everything into.
 */
export function apiGetChallengeRawRequired(id: string): Promise<ChallengeView> {
  return getRequired<ChallengeView>(`/api/challenges/${encodeURIComponent(id)}`);
}

/** Recipient opens a spec-bound challenge (attempt + first-writer receipt). */
export function apiAcceptChallengeV1Required(id: string): Promise<ChallengeSpecBoundView> {
  return postRequired<ChallengeSpecBoundView>(
    `/api/challenges/${encodeURIComponent(id)}/accept`,
    undefined,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
    challengeWireHeaders(),
  );
}

/** Challenger's own run.start that FREEZES a content-addressed spec (D1/D3). */
export function apiStartChallengeSourceRunRequired(
  payload: ChallengeSourceRunRequest,
): Promise<LegacyRunTicketView> {
  return postRequired<LegacyRunTicketView>(
    '/api/runs/start',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
    challengeWireHeaders(),
  );
}

/** Recipient run.start: server derives the spec, binds the ticket pre-play,
 *  writes the first-writer friendship receipt + accept event (D3/D8/D11). */
export function apiStartChallengeRecipientRunRequired(
  payload: ChallengeRecipientRunRequest,
): Promise<LegacyRunTicketView> {
  return postRequired<LegacyRunTicketView>(
    '/api/runs/start',
    payload,
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
    challengeWireHeaders(),
  );
}

/** Post a recipient challenge level result carrying the applied wrapper digest;
 *  the server verifies it against the pre-play ticket binding (P1-1). */
export function apiPostChallengeResultRequired(payload: {
  mechanic_id: string;
  variant_id: string;
  run_id: string;
  ticket_id: string;
  metric_value: number;
  applied_spec_digest: string;
  tz_offset_minutes?: number;
}): Promise<ResultResp> {
  return postRequired<ResultResp>(
    '/api/results',
    { metric_key: 'time_ms', ...payload },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
}

/** Complete a v1 challenge from its challenge-bound verified run, echoing the
 *  applied wrapper digest (verified against challenge.spec_digest). No wire
 *  header on /complete (per §4). */
export function apiCompleteChallengeV1Required(payload: {
  id: string;
  source_run_id: string;
  applied_spec_digest: string;
}): Promise<ChallengeComplete> {
  return postRequired<ChallengeComplete>(
    `/api/challenges/${encodeURIComponent(payload.id)}/complete`,
    {
      source_run_id: payload.source_run_id,
      applied_spec_digest: payload.applied_spec_digest,
      tz_offset_minutes: tzOffsetMinutes(),
    },
    OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS,
  );
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
