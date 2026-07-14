import { API_BASE } from './api';
import {
  controlPlaneUuid,
  DurableControlPlaneOutbox,
  type ControlPlaneFlushResult,
} from './control-plane-outbox.mjs';
import { getInitData } from './telegram';
import { sessionIdOf } from './telemetry';
import type {
  CatalogConfigurationFailurePayload,
  CatalogLevelImpressionPayload,
} from './catalog-player-v2.mjs';

type Uuid = string;

export interface BuiltinFeedDecisionPayload {
  decision_id: Uuid;
  mapping_id: Uuid;
  feed_position: number;
}

export interface ClientFeedDecisionPayload {
  decision_id: Uuid;
  slot_type: string;
  policy_version: string;
  mechanic_id: string;
  candidate_count: number;
  chosen_ref: string;
}

export interface UnitImpressionPayload {
  decision_id: Uuid;
  impression_id: Uuid;
  mechanic_id: string;
  series_id?: Uuid;
  slot_type: string;
}

export interface LevelImpressionPayload {
  impression_id: Uuid;
  level_impression_id: Uuid;
  level_index: number;
  level_spec_hash: string;
  applied_spec_hash: string;
}

export interface BuiltinLevelImpressionPayload {
  impression_id: Uuid;
  level_impression_id: Uuid;
  level_index: number;
}

export interface ConfigurationFailurePayload {
  impression_id: Uuid;
  level_index?: number;
  reason: 'timeout' | 'digest' | 'origin' | 'runtime' | 'contract' | 'mount';
}

export interface UnitExitPayload {
  impression_id: Uuid;
  reason: 'swipe' | 'background' | 'close';
  state: 'preview' | 'playing' | 'won' | 'lost';
  dwell_active_ms: number;
  dwell_censored: boolean;
}

export interface AttemptStartPayload {
  run_id: string;
  ticket_id: Uuid;
  level_impression_id: Uuid;
  level_index: number;
}

export interface AttemptResultPayload {
  run_id: string;
  outcome: 'win' | 'lose';
  time_ms: number;
}

export interface ManualActionPayload {
  run_id: string;
  level_impression_id: Uuid;
  action_seq: number;
  action_type: string;
  accepted: boolean;
  changed_state: boolean;
}

export interface MoreLikeThisPayload {
  impression_id: Uuid;
  family: string;
}

export interface ControlPlanePayloadMap {
  client_feed_decision: ClientFeedDecisionPayload;
  builtin_feed_decision: BuiltinFeedDecisionPayload;
  unit_impression: UnitImpressionPayload;
  level_impression: LevelImpressionPayload;
  catalog_level_impression: CatalogLevelImpressionPayload;
  catalog_level_impression_v2: CatalogLevelImpressionPayload & {
    skin_hash: string;
    applied_skin_hash: string;
    skin_contract_digest: string;
  };
  builtin_level_impression: BuiltinLevelImpressionPayload;
  configuration_failure: ConfigurationFailurePayload;
  catalog_configuration_failure: CatalogConfigurationFailurePayload;
  catalog_configuration_failure_v2: CatalogConfigurationFailurePayload & {
    expected_skin_hash: string;
    skin_contract_digest: string;
  };
  unit_exit: UnitExitPayload;
  attempt_start: AttemptStartPayload;
  attempt_result: AttemptResultPayload;
  manual_action: ManualActionPayload;
  more_like_this: MoreLikeThisPayload;
  session_pause: Record<string, never>;
  session_resume: Record<string, never>;
}

const CONTROL_PLANE_ENABLED =
  String((import.meta as any).env?.VITE_CONTROL_PLANE_ENABLED ?? '').toLowerCase() === 'true';
const FLUSH_INTERVAL_MS = 5000;
const STORAGE_PREFIX = 'swipe_control_plane_outbox_v2';

let outbox: DurableControlPlaneOutbox | null = null;
let initialized = false;
let foreground = typeof document !== 'undefined' && !document.hidden;

export function controlPlaneEnabled(): boolean {
  return CONTROL_PLANE_ENABLED && getInitData() !== null;
}

export function createControlPlaneId(): string {
  return controlPlaneUuid();
}

export function initControlPlane(): void {
  if (initialized) return;
  initialized = true;
  if (!controlPlaneEnabled()) return;
  outbox = new DurableControlPlaneOutbox({
    storage: localStorage,
    storageKey: `${STORAGE_PREFIX}:${telegramUserScope()}`,
    endpoint: `${API_BASE}/api/cp/events`,
    sessionId: sessionIdOf(),
    authorization: () => {
      const initData = getInitData();
      return initData ? `tma ${initData}` : null;
    },
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', () => { void flushControlPlane({ force: true }); });
  window.setInterval(() => { void flushControlPlane(); }, FLUSH_INTERVAL_MS);
  void flushControlPlane({ force: true });
}

export function queueControlPlaneEvent<Name extends keyof ControlPlanePayloadMap>(
  eventName: Name,
  payload: ControlPlanePayloadMap[Name],
  occurredAt?: string,
): string | null {
  if (!outbox) return null;
  const event = outbox.enqueue(
    eventName,
    payload as unknown as Record<string, unknown>,
    occurredAt,
  );
  if (!event) return null;
  void outbox.flush();
  return event.event_id;
}

export function flushControlPlane(options: { force?: boolean } = {}): Promise<ControlPlaneFlushResult | null> {
  return outbox ? outbox.flush(options) : Promise.resolve(null);
}

export function controlPlaneQueueState(): { pending: number; deadLetters: number; nextRetryAt: number } {
  return {
    pending: outbox?.pendingCount() ?? 0,
    deadLetters: outbox?.deadLetterCount() ?? 0,
    nextRetryAt: outbox?.nextRetryAt() ?? 0,
  };
}

export function controlPlaneEventState(
  eventId: string | null,
): 'pending' | 'rejected' | 'acknowledged' | 'unavailable' {
  if (!outbox || !eventId) return 'unavailable';
  return outbox.eventState(eventId);
}

export function controlPlaneEventReceiptStatus(
  eventId: string | null,
): 'pending' | 'stored' | 'projected' | 'pending_dependency' | 'rejected' | 'unavailable' {
  if (!outbox || !eventId) return 'unavailable';
  return outbox.eventReceiptStatus(eventId);
}

function onVisibilityChange(): void {
  const nextForeground = !document.hidden;
  if (nextForeground === foreground) return;
  foreground = nextForeground;
  queueControlPlaneEvent(nextForeground ? 'session_resume' : 'session_pause', {});
  if (nextForeground) void flushControlPlane({ force: true });
}

function onPageHide(): void {
  if (!foreground) return;
  foreground = false;
  // Persistence is synchronous. Delivery can happen on the next launch; unlike
  // legacy telemetry this authenticated route never relies on sendBeacon.
  queueControlPlaneEvent('session_pause', {});
}

function onPageShow(): void {
  if (foreground || document.hidden) return;
  foreground = true;
  queueControlPlaneEvent('session_resume', {});
  void flushControlPlane({ force: true });
}

function telegramUserScope(): string {
  const unsafeId = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  if (Number.isSafeInteger(unsafeId)) return String(unsafeId);
  try {
    const rawUser = new URLSearchParams(getInitData() ?? '').get('user');
    const parsed = rawUser ? JSON.parse(rawUser) as { id?: unknown } : null;
    if (parsed && typeof parsed.id === 'number' && Number.isSafeInteger(parsed.id)) return String(parsed.id);
  } catch { /* dev initData without a parseable user */ }
  return 'authenticated';
}
