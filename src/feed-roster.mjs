const ROSTER_SCHEMA = 'feed.roster-config.v1';
const SNAPSHOT_KEY = 'swipe_feed_roster_next_session_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Variant ids are deterministic digest-derived identifiers, not RFC-versioned
// UUIDs (production example: 87ad934c-8d95-d598-dfc7-d60c61034667). The backend
// accepts any hex UUID shape for them; requiring version/variant bits here
// would reject the first live /session roster.
const HEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PLAYABLE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,94}[a-z0-9])?$/;

export class FeedRosterContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedRosterContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FeedRosterContractError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function cloneAndFreeze(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
    return item;
  };
  return freeze(cloned);
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail('invalid_uuid', `${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function hexUuid(value, label) {
  if (typeof value !== 'string' || !HEX_UUID_RE.test(value)) {
    fail('invalid_uuid', `${label} must be a lowercase hex UUID shape`);
  }
  return value;
}

function canonicalHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    fail('invalid_hash', `${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

/** Strictly parse the server-owned /session.feedRoster projection. */
export function parseFeedRosterSessionV1(value) {
  if (!exactKeys(value, ['schema', 'activationId', 'rosterHash', 'entries'])) {
    fail('invalid_projection', 'feedRoster must contain only schema, activationId, rosterHash and entries');
  }
  if (value.schema !== ROSTER_SCHEMA) {
    fail('unsupported_schema', `feedRoster schema must be ${ROSTER_SCHEMA}`);
  }
  canonicalUuid(value.activationId, 'feedRoster.activationId');
  canonicalHash(value.rosterHash, 'feedRoster.rosterHash');
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 24) {
    fail('invalid_entries', 'feedRoster.entries must contain 1..24 items');
  }

  const mappingIds = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const label = `feedRoster.entries[${index}]`;
    if (!exactKeys(entry, [
      'builtinMappingId',
      'playableId',
      'variantId',
      'catalogMechanic',
      'mappingDigest',
      'mappingState',
    ])) fail('invalid_entry', `${label} contains missing or unknown fields`);
    canonicalUuid(entry.builtinMappingId, `${label}.builtinMappingId`);
    hexUuid(entry.variantId, `${label}.variantId`);
    canonicalHash(entry.mappingDigest, `${label}.mappingDigest`);
    if (mappingIds.has(entry.builtinMappingId)) {
      fail('duplicate_mapping', `${label}.builtinMappingId must be unique`);
    }
    mappingIds.add(entry.builtinMappingId);
    if (typeof entry.playableId !== 'string' || !PLAYABLE_ID_RE.test(entry.playableId)) {
      fail('invalid_playable', `${label}.playableId is invalid`);
    }
    if (typeof entry.catalogMechanic !== 'string'
      || entry.catalogMechanic.length < 1 || entry.catalogMechanic.length > 96) {
      fail('invalid_mechanic', `${label}.catalogMechanic is invalid`);
    }
    if (!['active', 'retired'].includes(entry.mappingState)) {
      fail('invalid_mapping_state', `${label}.mappingState must be active or retired`);
    }
  }
  return cloneAndFreeze(value);
}

/** Exact JCS bytes for the intentionally tiny v1 roster identity object. */
export function feedRosterIdentityJcs(projection) {
  const parsed = parseFeedRosterSessionV1(projection);
  // RFC 8785 sorts these two object keys as entries, schema. Nested identity
  // rows have one key, so JSON.stringify is byte-identical to JCS here.
  return JSON.stringify({
    entries: parsed.entries.map((entry) => ({ builtinMappingId: entry.builtinMappingId })),
    schema: parsed.schema,
  });
}

async function sha256Hex(value, cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') {
    fail('crypto_unavailable', 'WebCrypto SHA-256 is required to verify feedRoster identity');
  }
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

/** Verify that mutable response projection still names the exact roster identity. */
export async function verifyFeedRosterSessionV1(value, cryptoImpl = globalThis.crypto) {
  const parsed = parseFeedRosterSessionV1(value);
  const actualHash = await sha256Hex(feedRosterIdentityJcs(parsed), cryptoImpl);
  if (actualHash !== parsed.rosterHash) {
    fail('roster_hash_mismatch', 'feedRoster.rosterHash does not match its ordered builtinMappingId identity');
  }
  return parsed;
}

/** Read once before Feed construction. Later writes cannot reorder this session. */
export function loadFeedRosterSessionSnapshot(storage) {
  let raw = null;
  try { raw = storage?.getItem(SNAPSHOT_KEY) ?? null; } catch { return null; }
  if (!raw) return null;
  try { return parseFeedRosterSessionV1(JSON.parse(raw)); } catch {
    try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* best effort */ }
    return null;
  }
}

/** Re-verify persisted bytes before they can affect a newly constructed feed. */
export async function loadVerifiedFeedRosterSessionSnapshot(
  storage,
  cryptoImpl = globalThis.crypto,
) {
  const parsed = loadFeedRosterSessionSnapshot(storage);
  if (!parsed) return null;
  try { return await verifyFeedRosterSessionV1(parsed, cryptoImpl); } catch {
    try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* best effort */ }
    return null;
  }
}

/**
 * Stage the authoritative document for the next page/session. Missing or
 * invalid data removes an older snapshot instead of keeping stale authority.
 */
export async function stageFeedRosterForNextSession(storage, value, cryptoImpl = globalThis.crypto) {
  if (value == null) {
    try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* best effort */ }
    return Object.freeze({ status: 'baked', reason: 'absent' });
  }
  try {
    const parsed = await verifyFeedRosterSessionV1(value, cryptoImpl);
    storage?.setItem(SNAPSHOT_KEY, JSON.stringify(parsed));
    return Object.freeze({ status: 'staged', activationId: parsed.activationId, rosterHash: parsed.rosterHash });
  } catch (error) {
    try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* best effort */ }
    return Object.freeze({
      status: 'rejected',
      reason: error instanceof FeedRosterContractError ? error.code : 'storage_failure',
    });
  }
}

/** Intersect one frozen session snapshot with this exact deployment. */
export function resolveFeedRosterSession(snapshot, bakedPlayables, isAvailable) {
  const baked = bakedPlayables.map((item) => Object.freeze({ id: item.id }));
  if (!snapshot) return Object.freeze({
    source: 'baked',
    playables: Object.freeze(baked),
    entries: Object.freeze(baked.map(() => null)),
    unavailable: Object.freeze([]),
    availableCount: baked.length,
    activationId: null,
    rosterHash: null,
  });
  const parsed = parseFeedRosterSessionV1(snapshot);
  const available = [];
  const unavailable = [];
  for (const entry of parsed.entries) {
    const reason = entry.mappingState === 'retired'
      ? 'retired'
      : (isAvailable(entry.playableId) ? null : 'not_deployed');
    if (reason) unavailable.push(Object.freeze({
      builtinMappingId: entry.builtinMappingId,
      playableId: entry.playableId,
      reason,
    }));
    else available.push(entry);
  }
  if (available.length < 3) return Object.freeze({
    source: 'fallback',
    playables: Object.freeze(baked),
    entries: Object.freeze(baked.map(() => null)),
    unavailable: Object.freeze(unavailable),
    availableCount: available.length,
    activationId: parsed.activationId,
    rosterHash: parsed.rosterHash,
  });
  return Object.freeze({
    source: 'roster',
    playables: Object.freeze(available.map((entry) => Object.freeze({ id: entry.playableId }))),
    entries: Object.freeze(available),
    unavailable: Object.freeze(unavailable),
    availableCount: available.length,
    activationId: parsed.activationId,
    rosterHash: parsed.rosterHash,
  });
}

export function buildBuiltinFeedDecisionV2(decisionId, entry, rosterActivationId, feedPosition) {
  canonicalUuid(decisionId, 'decision_id');
  canonicalUuid(entry?.builtinMappingId, 'mapping_id');
  canonicalUuid(rosterActivationId, 'roster_activation_id');
  if (!Number.isSafeInteger(feedPosition) || feedPosition < 0) {
    fail('invalid_feed_position', 'feed_position must be a non-negative safe integer');
  }
  return Object.freeze({
    decision_id: decisionId,
    mapping_id: entry.builtinMappingId,
    roster_activation_id: rosterActivationId,
    feed_position: feedPosition,
  });
}

export const FEED_ROSTER_SNAPSHOT_KEY = SNAPSHOT_KEY;
