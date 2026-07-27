/**
 * Read-only sequencing debug (§12): envelope validation, the three projection
 * view models, subject/limit normalization and display formatting.
 *
 * The server answers from stored snapshot/receipt bytes and carries that
 * promise in `readOnly: true` / `recomputed: false`. This module validates the
 * promise-bearing envelope and otherwise passes stored bytes through verbatim —
 * nothing here derives a score, a state, a counter or any other metric, and the
 * untouched response is always kept as `raw` so a structured render can never
 * be the only view of a projection.
 *
 * There is no mutation surface: personalization reset stays an operator CLI act
 * and reset receipts are read out of the history projection.
 */

export const SEQUENCING_DEBUG_PROFILE_SCHEMA = 'feed.debug-profile.v1';
export const SEQUENCING_DEBUG_WHY_NOW_SCHEMA = 'feed.debug-why-now.v1';
export const SEQUENCING_DEBUG_HISTORY_SCHEMA = 'feed.debug-history.v1';

export const SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT = 20;
export const SEQUENCING_DEBUG_HISTORY_LIMIT_MIN = 1;
export const SEQUENCING_DEBUG_HISTORY_LIMIT_MAX = 50;

export const SEQUENCING_DEBUG_PATHS = Object.freeze({
  profile: '/api/feed/sequencing/debug/profile',
  'why-now': '/api/feed/sequencing/debug/why-now',
  history: '/api/feed/sequencing/debug/history',
});

const SCHEMA_BY_KIND = Object.freeze({
  profile: SEQUENCING_DEBUG_PROFILE_SCHEMA,
  'why-now': SEQUENCING_DEBUG_WHY_NOW_SCHEMA,
  history: SEQUENCING_DEBUG_HISTORY_SCHEMA,
});

// The stored plan snapshot is echoed verbatim by the server; this is a render
// order for the sections it is known to contain. Unknown keys are appended in
// their original order so a snapshot section can never be hidden by drift.
const WHY_NOW_SECTION_ORDER = Object.freeze([
  'schema',
  'implementationVersion',
  'planId',
  'userId',
  'opportunity',
  'asOf',
  'causalWatermark',
  'configs',
  'epoch',
  'ontologyMembership',
  'profile',
  'satiationAndGaps',
  'regret',
  'explorationFloor',
  'coldStart',
  'continuity',
  'runway',
  'exploration',
  'chosen',
  'chosenSlotType',
  'rejected',
  'constraintConflicts',
  'authority',
]);

const SUBJECT_ID_RE = /^[0-9]{1,19}$/;

export class FeedSequencingDebugContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedSequencingDebugContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FeedSequencingDebugContractError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Structural clone + deep freeze: stored bytes are displayed, never mutated. */
function freezeJson(value) {
  if (value === undefined) return null;
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    fail('unserializable_response', 'sequencing debug response is not JSON data');
  }
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
    return item;
  };
  return freeze(cloned);
}

function stringOrNull(value, label, warnings) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  warnings.push(`${label} is not a string`);
  return null;
}

function booleanOrNull(value, label, warnings) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  warnings.push(`${label} is not a boolean`);
  return null;
}

function integerOrNull(value, label, warnings) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  warnings.push(`${label} is not a number`);
  return null;
}

function arrayOrEmpty(value, label, warnings) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) {
    warnings.push(`${label} is absent`);
    return [];
  }
  warnings.push(`${label} is not an array`);
  return [];
}

function reportUnknownKeys(value, known, label, warnings) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) warnings.push(`${label} carries an unknown field ${key}`);
  }
}

/**
 * Validate the shared envelope. Schema, readOnly, recomputed, subjectUserId and
 * sources carry the read-only promise of the whole contour, so a violation of
 * any of them is a hard contract error rather than a warning: a projection that
 * claims to be recomputed — or that cannot name the stored bytes it came from —
 * must not be displayed as a stored snapshot. Individual malformed entries
 * inside a well-formed sources array stay warnings.
 */
export function parseSequencingDebugEnvelope(value, expectedSchema, warnings = []) {
  if (!plainObject(value)) {
    fail('invalid_response', 'sequencing debug response must be a JSON object');
  }
  if (value.schema !== expectedSchema) {
    fail('unsupported_schema', `sequencing debug schema must be ${expectedSchema}`);
  }
  if (value.readOnly !== true) {
    fail('not_read_only', 'sequencing debug response must declare readOnly: true');
  }
  if (value.recomputed !== false) {
    fail('recomputed_projection', 'sequencing debug response must declare recomputed: false');
  }
  if (typeof value.subjectUserId !== 'string' || !SUBJECT_ID_RE.test(value.subjectUserId)) {
    fail('invalid_subject', 'sequencing debug response must echo a numeric subjectUserId');
  }
  // `sources` carries the digests that make a projection auditable, so it fails
  // closed like the other promise-bearing fields. An empty array is legitimate:
  // it is how the server states that nothing is stored for this subject yet.
  if (!Array.isArray(value.sources)) {
    fail('invalid_sources', 'sequencing debug response must carry a sources array');
  }
  const sources = value.sources.map((source, index) => {
    const label = `sources[${index}]`;
    if (!plainObject(source)) {
      warnings.push(`${label} is not an object`);
      return Object.freeze({ kind: null, id: null, digest: null, asOf: null });
    }
    reportUnknownKeys(source, ['kind', 'id', 'digest', 'asOf'], label, warnings);
    return Object.freeze({
      kind: stringOrNull(source.kind, `${label}.kind`, warnings),
      id: stringOrNull(source.id, `${label}.id`, warnings),
      digest: stringOrNull(source.digest, `${label}.digest`, warnings),
      asOf: stringOrNull(source.asOf, `${label}.asOf`, warnings),
    });
  });
  return Object.freeze({
    schema: value.schema,
    subjectUserId: value.subjectUserId,
    readOnly: true,
    recomputed: false,
    sources: Object.freeze(sources),
  });
}

/** §12.1 — family states exactly as the last committed receipt stored them. */
export function parseSequencingDebugProfileV1(value) {
  const warnings = [];
  const envelope = parseSequencingDebugEnvelope(value, SEQUENCING_DEBUG_PROFILE_SCHEMA, warnings);
  reportUnknownKeys(
    value,
    [
      'schema', 'subjectUserId', 'readOnly', 'recomputed', 'sources',
      'snapshotAsOf', 'snapshotAgeSeconds', 'epoch', 'configs', 'profile',
    ],
    'profile',
    warnings,
  );
  const profile = freezeJson(value.profile ?? null);
  const present = plainObject(value.profile);
  if (value.profile !== null && value.profile !== undefined && !present) {
    warnings.push('profile is neither an object nor null');
  }
  const families = present ? arrayOrEmpty(profile.families, 'profile.families', warnings) : [];
  const favoriteSet = present
    ? arrayOrEmpty(profile.favoriteSet, 'profile.favoriteSet', warnings)
    : [];
  return Object.freeze({
    kind: 'profile',
    subjectUserId: envelope.subjectUserId,
    sources: envelope.sources,
    snapshotAsOf: stringOrNull(value.snapshotAsOf, 'snapshotAsOf', warnings),
    snapshotAgeSeconds: integerOrNull(value.snapshotAgeSeconds, 'snapshotAgeSeconds', warnings),
    epoch: freezeJson(value.epoch ?? null),
    configs: freezeJson(value.configs ?? null),
    profile,
    profileSchema: present ? stringOrNull(profile.schema, 'profile.schema', warnings) : null,
    profileAsOf: present ? stringOrNull(profile.asOf, 'profile.asOf', warnings) : null,
    families: freezeJson(families),
    favoriteSet: freezeJson(favoriteSet),
    present,
    warnings: Object.freeze(warnings),
    raw: freezeJson(value),
  });
}

/** §12.2 — the last stored plan snapshot, verbatim. */
export function parseSequencingDebugWhyNowV1(value) {
  const warnings = [];
  const envelope = parseSequencingDebugEnvelope(value, SEQUENCING_DEBUG_WHY_NOW_SCHEMA, warnings);
  reportUnknownKeys(
    value,
    [
      'schema', 'subjectUserId', 'readOnly', 'recomputed', 'sources',
      'planId', 'chosenSlotType', 'chosenFamilyId', 'constraintConflict',
      'coldStartPhase', 'snapshot', 'snapshotDigest',
    ],
    'why-now',
    warnings,
  );
  const snapshot = freezeJson(value.snapshot ?? null);
  const present = plainObject(value.snapshot);
  if (value.snapshot !== null && value.snapshot !== undefined && !present) {
    warnings.push('snapshot is neither an object nor null');
  }
  return Object.freeze({
    kind: 'why-now',
    subjectUserId: envelope.subjectUserId,
    sources: envelope.sources,
    planId: stringOrNull(value.planId, 'planId', warnings),
    chosenSlotType: stringOrNull(value.chosenSlotType, 'chosenSlotType', warnings),
    chosenFamilyId: stringOrNull(value.chosenFamilyId, 'chosenFamilyId', warnings),
    constraintConflict: booleanOrNull(value.constraintConflict, 'constraintConflict', warnings),
    coldStartPhase: booleanOrNull(value.coldStartPhase, 'coldStartPhase', warnings),
    snapshot,
    snapshotDigest: stringOrNull(value.snapshotDigest, 'snapshotDigest', warnings),
    sections: sequencingSnapshotSections(snapshot),
    present,
    warnings: Object.freeze(warnings),
    raw: freezeJson(value),
  });
}

/** §12.3 — issued → seen chain plus the durable negative and reset receipts. */
export function parseSequencingDebugHistoryV1(value) {
  const warnings = [];
  const envelope = parseSequencingDebugEnvelope(value, SEQUENCING_DEBUG_HISTORY_SCHEMA, warnings);
  reportUnknownKeys(
    value,
    [
      'schema', 'subjectUserId', 'readOnly', 'recomputed', 'sources',
      'limit', 'units', 'generatedOfferMisses', 'favoriteDeliveryMisses', 'resets',
    ],
    'history',
    warnings,
  );
  const unitKeys = [
    'decisionId', 'issuedAt', 'slotType', 'policyVersion', 'arm', 'mechanicId',
    'builtinMappingId', 'rosterActivationId', 'seen', 'impressionId', 'revealedAt',
  ];
  const units = [];
  for (const [index, unit] of arrayOrEmpty(value.units, 'units', warnings).entries()) {
    const label = `units[${index}]`;
    if (!plainObject(unit)) {
      // Structured rendering skips it; the raw view below still shows the item.
      warnings.push(`${label} is not an object`);
      continue;
    }
    reportUnknownKeys(unit, unitKeys, label, warnings);
    units.push(Object.freeze({
      decisionId: stringOrNull(unit.decisionId, `${label}.decisionId`, warnings),
      issuedAt: stringOrNull(unit.issuedAt, `${label}.issuedAt`, warnings),
      slotType: stringOrNull(unit.slotType, `${label}.slotType`, warnings),
      policyVersion: stringOrNull(unit.policyVersion, `${label}.policyVersion`, warnings),
      arm: stringOrNull(unit.arm, `${label}.arm`, warnings),
      mechanicId: stringOrNull(unit.mechanicId, `${label}.mechanicId`, warnings),
      builtinMappingId: stringOrNull(unit.builtinMappingId, `${label}.builtinMappingId`, warnings),
      rosterActivationId: stringOrNull(
        unit.rosterActivationId, `${label}.rosterActivationId`, warnings,
      ),
      seen: booleanOrNull(unit.seen, `${label}.seen`, warnings),
      impressionId: stringOrNull(unit.impressionId, `${label}.impressionId`, warnings),
      revealedAt: stringOrNull(unit.revealedAt, `${label}.revealedAt`, warnings),
    }));
  }
  const resetKeys = ['resetId', 'scope', 'effectiveAt', 'newEpoch', 'receiptDigest'];
  const resets = [];
  for (const [index, reset] of arrayOrEmpty(value.resets, 'resets', warnings).entries()) {
    const label = `resets[${index}]`;
    if (!plainObject(reset)) {
      warnings.push(`${label} is not an object`);
      continue;
    }
    reportUnknownKeys(reset, resetKeys, label, warnings);
    resets.push(Object.freeze({
      resetId: stringOrNull(reset.resetId, `${label}.resetId`, warnings),
      scope: stringOrNull(reset.scope, `${label}.scope`, warnings),
      effectiveAt: stringOrNull(reset.effectiveAt, `${label}.effectiveAt`, warnings),
      newEpoch: integerOrNull(reset.newEpoch, `${label}.newEpoch`, warnings),
      receiptDigest: stringOrNull(reset.receiptDigest, `${label}.receiptDigest`, warnings),
    }));
  }
  const generatedOfferMisses = freezeJson(
    arrayOrEmpty(value.generatedOfferMisses, 'generatedOfferMisses', warnings),
  );
  const favoriteDeliveryMisses = freezeJson(
    arrayOrEmpty(value.favoriteDeliveryMisses, 'favoriteDeliveryMisses', warnings),
  );
  return Object.freeze({
    kind: 'history',
    subjectUserId: envelope.subjectUserId,
    sources: envelope.sources,
    limit: integerOrNull(value.limit, 'limit', warnings),
    units: Object.freeze(units),
    generatedOfferMisses,
    favoriteDeliveryMisses,
    resets: Object.freeze(resets),
    present: units.length > 0
      || generatedOfferMisses.length > 0
      || favoriteDeliveryMisses.length > 0
      || resets.length > 0,
    warnings: Object.freeze(warnings),
    raw: freezeJson(value),
  });
}

/** Ordered {key, value} pairs of a stored snapshot; nothing is dropped. */
export function sequencingSnapshotSections(snapshot) {
  if (!plainObject(snapshot)) return Object.freeze([]);
  const keys = Object.keys(snapshot);
  const ordered = WHY_NOW_SECTION_ORDER.filter((key) => keys.includes(key));
  const remaining = keys.filter((key) => !WHY_NOW_SECTION_ORDER.includes(key));
  return Object.freeze([...ordered, ...remaining].map((key) => Object.freeze({
    key,
    value: snapshot[key],
  })));
}

export function parseSequencingDebugProjection(kind, value) {
  if (kind === 'profile') return parseSequencingDebugProfileV1(value);
  if (kind === 'why-now') return parseSequencingDebugWhyNowV1(value);
  if (kind === 'history') return parseSequencingDebugHistoryV1(value);
  return fail('unknown_projection', `unknown sequencing debug projection ${String(kind)}`);
}

const EMPTY_MESSAGE = Object.freeze({
  profile: 'no committed receipt for this subject yet',
  'why-now': 'no stored plan snapshot for this subject yet',
  history: 'no decisions, misses or reset receipts for this subject yet',
});

/**
 * Fold one transport result into a display state. The 404 the server returns
 * for a disabled flag and for a non-allowlisted caller is deliberately
 * indistinguishable, so the client states it once and calmly, and never turns
 * it into a retry.
 */
export function buildSequencingDebugView(kind, result) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_BY_KIND, kind)) {
    fail('unknown_projection', `unknown sequencing debug projection ${String(kind)}`);
  }
  if (!plainObject(result)) {
    fail('invalid_result', 'sequencing debug result must be an object');
  }
  if (result.status === 'unavailable') {
    return Object.freeze({
      kind,
      state: 'unavailable',
      message: 'sequencing debug is not available for this account',
      retryable: false,
      view: null,
    });
  }
  if (result.status === 'error') {
    return Object.freeze({
      kind,
      state: 'error',
      message: typeof result.message === 'string' && result.message
        ? result.message
        : 'sequencing debug request failed',
      retryable: true,
      view: null,
    });
  }
  if (result.status !== 'ok') {
    fail('invalid_result', `unknown sequencing debug result status ${String(result.status)}`);
  }
  let view;
  try {
    view = parseSequencingDebugProjection(kind, result.body);
  } catch (error) {
    if (error instanceof FeedSequencingDebugContractError) {
      return Object.freeze({
        kind,
        state: 'error',
        message: `contract violation (${error.code}): ${error.message}`,
        retryable: false,
        view: null,
      });
    }
    throw error;
  }
  return Object.freeze({
    kind,
    state: view.present ? 'data' : 'empty',
    message: view.present ? null : EMPTY_MESSAGE[kind],
    retryable: false,
    view,
  });
}

/** Operator navigation only: an empty field means "the calling subject". */
export function normalizeSequencingSubject(value) {
  if (value === null || value === undefined) return Object.freeze({ status: 'own' });
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) return Object.freeze({ status: 'invalid' });
    return Object.freeze({ status: 'subject', userId: value });
  }
  if (typeof value !== 'string') return Object.freeze({ status: 'invalid' });
  const trimmed = value.trim();
  if (trimmed === '') return Object.freeze({ status: 'own' });
  if (!SUBJECT_ID_RE.test(trimmed)) return Object.freeze({ status: 'invalid' });
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Object.freeze({ status: 'invalid' });
  return Object.freeze({ status: 'subject', userId: parsed });
}

/**
 * The server always echoes the subject it actually read. When an operator named
 * one explicitly and the echo differs, the displayed bytes belong to a different
 * user than the one on screen — surfaced as a warning, while the value shown
 * stays the server's.
 */
export function sequencingSubjectEchoWarning(requested, echoed) {
  const subject = normalizeSequencingSubject(requested === undefined ? null : requested);
  if (subject.status !== 'subject') return null;
  if (typeof echoed !== 'string' || echoed === '') return null;
  return String(subject.userId) === echoed
    ? null
    : `server echoed subjectUserId ${echoed} for requested user_id ${subject.userId}`;
}

/** The server rejects anything outside 1..50; an unusable input falls back. */
export function normalizeSequencingHistoryLimit(value) {
  // A cleared input is "unspecified", not "the smallest window".
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed === '') return SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT;
    parsed = Number(trimmed);
  }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT;
  }
  const rounded = Math.trunc(parsed);
  if (rounded < SEQUENCING_DEBUG_HISTORY_LIMIT_MIN) return SEQUENCING_DEBUG_HISTORY_LIMIT_MIN;
  if (rounded > SEQUENCING_DEBUG_HISTORY_LIMIT_MAX) return SEQUENCING_DEBUG_HISTORY_LIMIT_MAX;
  return rounded;
}

export function buildSequencingDebugPath(kind, options = {}) {
  const base = Object.prototype.hasOwnProperty.call(SEQUENCING_DEBUG_PATHS, kind)
    ? SEQUENCING_DEBUG_PATHS[kind]
    : null;
  if (base === null) {
    fail('unknown_projection', `unknown sequencing debug projection ${String(kind)}`);
  }
  const subject = normalizeSequencingSubject(
    options.subject === undefined ? null : options.subject,
  );
  if (subject.status === 'invalid') {
    fail('invalid_subject_input', 'user_id must be a positive integer');
  }
  const params = [];
  if (subject.status === 'subject') params.push(`user_id=${subject.userId}`);
  if (kind === 'history') {
    params.push(`limit=${normalizeSequencingHistoryLimit(options.limit)}`);
  }
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

/** Display only: the server sends UTC millisecond ISO text, shown verbatim so
 *  a receipt digest and its timestamp always describe the same stored bytes. */
export function formatSequencingTimestamp(value) {
  return typeof value === 'string' && value !== '' ? value : '—';
}

export function formatSequencingSnapshotAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  const whole = Math.trunc(seconds);
  if (whole < 0) return `${whole}s (clock skew)`;
  const parts = [];
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest}s`);
  return parts.slice(0, 3).join(' ');
}

/** Verbatim JSON text: key order is the server's, never sorted or reshaped. */
export function formatSequencingJson(value) {
  if (value === undefined) return '(absent)';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
