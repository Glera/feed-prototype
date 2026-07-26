/**
 * Share / Challenge v1 durable phase envelope (P1-3).
 *
 * Persists the operation's minted-once ids + committed phase + frozen payload to a
 * storage slot (window.localStorage in the app; an injected Map-like store in
 * tests) BEFORE the first POST. A retry ("Нет сети · повторить") or a reload
 * re-opens the SAME slot and resumes — the ids are never re-minted, the payload
 * never changes — so a lost response after a committed offer/run/result/create
 * leaves at most one of each (backend idempotency by request_id/ticket_id/run_id
 * finishes the dedup). Mirrors island's durable claim_id / bake jobId pattern.
 */

const ENVELOPE_VERSION = 1;

function readRecord(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || record.v !== ENVELOPE_VERSION || !record.ids || !record.ids.ticketId || !record.ids.runId) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeRecord(storage, key, record) {
  try { storage.setItem(key, JSON.stringify(record)); } catch { /* quota/private mode → in-memory only */ }
}

/**
 * Open (or create) the durable envelope for `key`. `mint` mints a fresh id;
 * `runIdPrefix` prefixes the durable run id. Returns a ChallengePlayEnvelope plus
 * `clear()` (call on terminal success or explicit abandonment).
 */
export function openEnvelope(storage, key, mint, runIdPrefix = 'chr') {
  let record = readRecord(storage, key);
  if (!record) {
    record = {
      v: ENVELOPE_VERSION,
      ids: { requestId: mint(), ticketId: mint(), runId: `${runIdPrefix}-${mint()}` },
      phase: 'init',
      data: {},
    };
    writeRecord(storage, key, record);
  }
  return {
    ids: record.ids,
    getPhase: () => record.phase,
    getData: () => record.data,
    checkpoint(phase, extra) {
      record.phase = phase;
      if (extra) record.data = { ...record.data, ...extra };
      writeRecord(storage, key, record);
    },
    clear() {
      try { storage.removeItem(key); } catch { /* noop */ }
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
