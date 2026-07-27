/**
 * Share / Challenge v1 durable phase envelope (P1-3), FAIL-CLOSED (Codex R2 P1).
 *
 * Persists the operation's minted-once ids + committed phase + frozen payload to a
 * storage slot (window.localStorage in the app; an injected store in tests) BEFORE
 * the first POST. A retry ("Нет сети · повторить") or a reload re-opens the SAME
 * slot and resumes — ids are never re-minted, the payload never changes — so a lost
 * response after a committed offer/run/result/create leaves at most one of each
 * (backend idempotency by request_id/ticket_id/run_id finishes the dedup).
 *
 * FAIL-CLOSED contract (an earlier revision swallowed storage errors, which let a
 * network POST go out with NO durable identity, and let a failed checkpoint leave
 * the durable phase at `init` so a reload re-ran a committed step):
 *   1. The initial write AND every checkpoint are fail-closed: on any storage
 *      failure they raise `ChallengeEnvelopeError` (code
 *      `challenge_envelope_not_persisted`). No caller may proceed to network/mount.
 *   2. Write order is strictly candidate → setItem → READ-BACK VERIFICATION →
 *      only then is the in-memory phase advanced. A silently-dropped write (quota,
 *      private mode, evicted key) can therefore never look committed.
 *   3. An existing but unreadable/corrupt envelope is NEVER replaced with fresh ids
 *      (that would destroy idempotency for an operation that may already be
 *      committed server-side) — it is the same fail-closed error.
 *   4. A TERMINAL envelope (the op already finished) is never resumed: the clear is
 *      retried and the slot is re-established fresh, so a failed terminal clear can
 *      never cause a replay or a re-issued share.
 */

const ENVELOPE_VERSION = 1;

/** Phases after which the operation is finished and must never be resumed. */
export const TERMINAL_PHASES = Object.freeze(['completed', 'created']);

export class ChallengeEnvelopeError extends Error {
  constructor(detail) {
    super(`challenge_envelope_not_persisted: ${detail}`);
    this.name = 'ChallengeEnvelopeError';
    this.code = 'challenge_envelope_not_persisted';
  }
}

function isTerminalPhase(phase) {
  return TERMINAL_PHASES.includes(phase);
}

function validShape(record) {
  return !!record
    && record.v === ENVELOPE_VERSION
    && !!record.ids
    && typeof record.ids.ticketId === 'string' && record.ids.ticketId.length > 0
    && typeof record.ids.runId === 'string' && record.ids.runId.length > 0
    && typeof record.phase === 'string' && record.phase.length > 0
    && !!record.data && typeof record.data === 'object';
}

/** Raw read. Throws if the slot cannot be read at all (fail-closed, rule 3). */
function readRaw(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    throw new ChallengeEnvelopeError(`storage unreadable: ${e?.message ?? e}`);
  }
}

/**
 * candidate → setItem → read-back verification. Returns only when the EXACT bytes
 * are provably durable; otherwise throws. Never mutates caller state.
 */
function persistVerified(storage, key, record) {
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch (e) {
    throw new ChallengeEnvelopeError(`candidate not serializable: ${e?.message ?? e}`);
  }
  try {
    storage.setItem(key, serialized);
  } catch (e) {
    throw new ChallengeEnvelopeError(`write rejected: ${e?.message ?? e}`);
  }
  const readBack = readRaw(storage, key);
  if (readBack !== serialized) {
    throw new ChallengeEnvelopeError('read-back verification failed (write did not stick)');
  }
}

/** Best-effort removal + verification. Returns true only if the slot is gone. */
function tryRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  try {
    return storage.getItem(key) == null;
  } catch {
    return false;
  }
}

/**
 * Open (or create) the durable envelope for `key`. `mint` mints a fresh id;
 * `runIdPrefix` prefixes the durable run id.
 *
 * @throws {ChallengeEnvelopeError} when durability cannot be proven — the caller
 *   MUST abort before any network call or level mount.
 */
export function openEnvelope(storage, key, mint, runIdPrefix = 'chr') {
  const raw = readRaw(storage, key);
  let record = null;

  if (raw != null && raw !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Rule 3: an existing-but-corrupt envelope may hide a committed operation.
      // Replacing it with fresh ids would break idempotency → fail closed.
      throw new ChallengeEnvelopeError(`existing envelope is corrupt: ${e?.message ?? e}`);
    }
    if (!validShape(parsed)) {
      throw new ChallengeEnvelopeError('existing envelope has an unusable shape');
    }
    if (isTerminalPhase(parsed.phase)) {
      // Rule 4: the previous operation FINISHED. Never resume it (that would
      // re-share / re-play). Retry the clear, then establish a fresh slot; the
      // fresh persist below also overwrites the stale terminal record.
      tryRemove(storage, key);
    } else {
      record = parsed;
    }
  }

  if (record === null) {
    record = {
      v: ENVELOPE_VERSION,
      ids: { requestId: mint(), ticketId: mint(), runId: `${runIdPrefix}-${mint()}` },
      phase: 'init',
      data: {},
    };
    // Rule 1: nothing may proceed unless the identity is provably durable.
    persistVerified(storage, key, record);
  }

  return {
    ids: record.ids,
    getPhase: () => record.phase,
    getData: () => record.data,
    /** @throws {ChallengeEnvelopeError} — the in-memory phase advances only after
     *  the new phase is provably durable (rules 1+2). */
    checkpoint(phase, extra) {
      const candidate = {
        ...record,
        phase,
        data: extra ? { ...record.data, ...extra } : record.data,
      };
      persistVerified(storage, key, candidate);
      record = candidate;   // ONLY after verified persistence
    },
    isTerminal: () => isTerminalPhase(record.phase),
    /** Terminal cleanup. Best-effort with one retry; it never throws, because the
     *  operation is already committed and a surviving TERMINAL record is handled on
     *  the next open (retried clear + fresh slot) rather than resumed. */
    clear() {
      if (tryRemove(storage, key)) return true;
      return tryRemove(storage, key);   // one retry
    },
  };
}

export const RECIPIENT_ENVELOPE_PREFIX = 'chpl-env-v1:r:';
export const SOURCE_ENVELOPE_KEY = 'chpl-env-v1:s';

/** Durable envelope for a recipient play (keyed by challenge id). */
export function openRecipientEnvelope(storage, challengeId, mint) {
  return openEnvelope(storage, `${RECIPIENT_ENVELOPE_PREFIX}${challengeId}`, mint, 'chr');
}

/** Durable envelope for the single active source play ("Бросить вызов"). A
 *  pending one is resumed so a retry continues the same offer/run/challenge. */
export function openSourceEnvelope(storage, mint) {
  return openEnvelope(storage, SOURCE_ENVELOPE_KEY, mint, 'chs');
}
