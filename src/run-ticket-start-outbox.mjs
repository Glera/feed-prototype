const TERMINAL_HTTP_STATUSES = new Set([400, 404, 409, 410, 422, 428]);
const ACCEPTED_STATES = new Set([
  'active', 'consumed', 'expired', 'revoked', 'superseded',
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DEAD_LETTERS = 100;

/**
 * Small durable queue for `/runs/start` intents.
 *
 * The request is persisted synchronously before `startRun` is invoked. A lost
 * response therefore becomes an idempotent retry of the exact same ticket.
 * Storage failures are allowed to escape enqueue: callers must not send an
 * unpersisted start intent.
 */
export class DurableRunTicketStartOutbox {
  constructor(options) {
    this._storage = options.storage;
    this._queueKey = options.queueKey;
    this._deadLetterKey = options.deadLetterKey;
    this._startRun = options.startRun;
    this._now = options.now ?? (() => Date.now());
    this._flushPromise = null;
  }

  enqueue(request) {
    const exact = validateRequest(request);
    const queue = this._loadQueue();
    const existing = queue.find((item) =>
      item.request.ticket_id === exact.ticket_id || item.request.run_id === exact.run_id);
    if (existing) {
      if (stableJson(existing.request) !== stableJson(exact)) {
        throw new Error(`run-ticket start identity conflict for ${exact.run_id}`);
      }
      return false;
    }
    queue.push({ request: exact, enqueued_at: new Date(this._now()).toISOString() });
    // Deliberately not caught: no network call is allowed if persistence failed.
    this._saveQueue(queue);
    return true;
  }

  flush() {
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this._flush().finally(() => { this._flushPromise = null; });
    return this._flushPromise;
  }

  async _flush() {
    let confirmed = 0;
    let terminal = 0;
    let latest = null;
    while (true) {
      const item = this._loadQueue()[0];
      if (!item) break;
      let view;
      try {
        // Clone again so a transport adapter cannot mutate the persisted copy.
        view = await this._startRun(jsonClone(item.request));
      } catch (error) {
        const reason = terminalErrorReason(error, item.request);
        if (!reason) {
          return { status: 'retry', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        if (!this._moveToDeadLetter(item, reason)) {
          return { status: 'storage_error', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        terminal += 1;
        continue;
      }
      const validatedView = validateResponse(view, item.request);
      if (!validatedView) {
        return { status: 'invalid_response', confirmed, terminal, pending: this.pendingCount(), latest };
      }
      latest = validatedView;
      if (['expired', 'revoked', 'superseded'].includes(validatedView.state)) {
        const reason = validatedView.state === 'expired'
          ? 'ticket_expired'
          : validatedView.state === 'superseded'
            ? 'ticket_superseded'
            : 'ticket_revoked';
        if (!this._moveToDeadLetter(item, reason, validatedView)) {
          return { status: 'storage_error', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        terminal += 1;
      } else {
        if (!this._remove(item.request.ticket_id)) {
          return { status: 'storage_error', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        confirmed += 1;
      }
    }
    return { status: 'ok', confirmed, terminal, pending: 0, latest };
  }

  pendingCount() {
    return this._loadQueue().length;
  }

  deadLetterCount() {
    return this._loadDeadLetters().length;
  }

  deadLetters() {
    return jsonClone(this._loadDeadLetters());
  }

  clear() {
    this._saveQueue([]);
    this._saveDeadLetters([]);
  }

  _remove(ticketId) {
    const queue = this._loadQueue().filter((item) => item.request.ticket_id !== ticketId);
    try {
      this._saveQueue(queue);
      return true;
    } catch {
      return false;
    }
  }

  _moveToDeadLetter(item, reason, response = null) {
    const deadLetters = this._loadDeadLetters();
    const identity = `${item.request.ticket_id}:${reason}`;
    if (!deadLetters.some((entry) => `${entry.request.ticket_id}:${entry.reason}` === identity)) {
      deadLetters.push({
        request: item.request,
        enqueued_at: item.enqueued_at,
        reason,
        response: response ? jsonClone(response) : null,
        rejected_at: new Date(this._now()).toISOString(),
      });
    }
    if (deadLetters.length > MAX_DEAD_LETTERS) {
      deadLetters.splice(0, deadLetters.length - MAX_DEAD_LETTERS);
    }
    try {
      // Save audit evidence first. A crash before queue removal causes only an
      // idempotent duplicate dead-letter attempt on the next launch.
      this._saveDeadLetters(deadLetters);
      this._saveQueue(
        this._loadQueue().filter((queued) => queued.request.ticket_id !== item.request.ticket_id),
      );
      return true;
    } catch {
      return false;
    }
  }

  _loadQueue() {
    try {
      const raw = JSON.parse(this._storage.getItem(this._queueKey) || '[]');
      return Array.isArray(raw) ? raw.filter(validQueueItem) : [];
    } catch {
      return [];
    }
  }

  _saveQueue(queue) {
    this._storage.setItem(this._queueKey, JSON.stringify(queue));
  }

  _loadDeadLetters() {
    try {
      const raw = JSON.parse(this._storage.getItem(this._deadLetterKey) || '[]');
      return Array.isArray(raw) ? raw.filter(validDeadLetter) : [];
    } catch {
      return [];
    }
  }

  _saveDeadLetters(deadLetters) {
    this._storage.setItem(this._deadLetterKey, JSON.stringify(deadLetters));
  }
}

function validateRequest(value) {
  if (!value || typeof value !== 'object') throw new TypeError('run-ticket request must be an object');
  for (const key of ['ticket_id', 'run_id', 'mechanic_id', 'variant_id']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new TypeError(`run-ticket request ${key} is required`);
    }
  }
  if (value.kind !== 'single' && value.kind !== 'series') {
    throw new TypeError('run-ticket request kind must be single or series');
  }
  const v2 = value.schema !== undefined || value.decision_id !== undefined;
  if (v2) {
    const exactWithoutChallenge = hasExactKeys(value, [
      'schema', 'ticket_id', 'run_id', 'mechanic_id', 'variant_id', 'kind', 'decision_id',
    ]);
    const exactNullChallenge = hasExactKeys(value, [
      'schema', 'ticket_id', 'run_id', 'mechanic_id', 'variant_id', 'kind', 'decision_id', 'challenge_id',
    ]) && value.challenge_id === null;
    if (!exactWithoutChallenge && !exactNullChallenge) {
      throw new TypeError('run.start.v2 request must use the exact catalog wire');
    }
    if (value.schema !== 'run.start.v2' || value.kind !== 'series') {
      throw new TypeError('run.start.v2 request must be an unchallenged series');
    }
    for (const key of ['ticket_id', 'variant_id', 'decision_id']) {
      if (!UUID_RE.test(value[key])) throw new TypeError(`run.start.v2 ${key} must be a canonical UUID`);
    }
  } else if (value.challenge_id !== undefined && typeof value.challenge_id !== 'string') {
    throw new TypeError('run-ticket request challenge_id must be a string');
  }
  return jsonClone(value);
}

function validateResponse(value, request) {
  if (!value || typeof value !== 'object' || !ACCEPTED_STATES.has(value.state)
    || value.ticket_id !== request.ticket_id || value.run_id !== request.run_id) return null;
  if (request.schema !== 'run.start.v2') {
    if (value.schema !== undefined || !['active', 'consumed', 'expired'].includes(value.state)) return null;
    return jsonClone(value);
  }
  const keys = [
    'schema', 'ticket_id', 'run_id', 'kind', 'mechanic_id', 'variant_id',
    'decision_id', 'catalog_entry_id', 'series_id', 'runtime_release_id',
    'runtime_contract_digest', 'runtime_artifact_digest', 'manifest_content_hash',
    'levels', 'expected_levels', 'completed_levels', 'next_result_at', 'expires_at', 'state',
    ...(value.schema === 'run.ticket.v3' ? ['skin_hash', 'skin_contract_digest'] : []),
  ];
  if (!hasExactKeys(value, keys) || !['run.ticket.v2', 'run.ticket.v3'].includes(value.schema)
    || value.kind !== 'series' || value.mechanic_id !== request.mechanic_id
    || value.variant_id !== request.variant_id || value.decision_id !== request.decision_id) return null;
  for (const key of [
    'ticket_id', 'variant_id', 'decision_id', 'catalog_entry_id', 'series_id', 'runtime_release_id',
  ]) {
    if (typeof value[key] !== 'string' || !UUID_RE.test(value[key])) return null;
  }
  if (typeof value.runtime_contract_digest !== 'string' || !HASH_RE.test(value.runtime_contract_digest)
    || typeof value.manifest_content_hash !== 'string' || !HASH_RE.test(value.manifest_content_hash)
    || typeof value.runtime_artifact_digest !== 'string' || !DIGEST_RE.test(value.runtime_artifact_digest)
    || typeof value.next_result_at !== 'string' || value.next_result_at.length === 0
    || typeof value.expires_at !== 'string' || value.expires_at.length === 0) return null;
  if (value.schema === 'run.ticket.v3'
    && (!HASH_RE.test(String(value.skin_hash || ''))
      || !HASH_RE.test(String(value.skin_contract_digest || '')))) return null;
  if (!Array.isArray(value.levels) || value.levels.length < 1 || value.levels.length > 6
    || value.levels.some((level, index) => !hasExactKeys(level, ['ordinal', 'spec_hash'])
      || level.ordinal !== index + 1 || typeof level.spec_hash !== 'string' || !HASH_RE.test(level.spec_hash))) {
    return null;
  }
  if (!Number.isInteger(value.expected_levels) || value.expected_levels !== value.levels.length
    || !Number.isInteger(value.completed_levels) || value.completed_levels < 0
    || value.completed_levels > value.expected_levels) return null;
  return jsonClone(value);
}

function terminalErrorReason(error, request) {
  const status = Number(error?.status);
  if (!TERMINAL_HTTP_STATUSES.has(status)) return null;
  if (request.schema === 'run.start.v2'
    && typeof error?.code === 'string'
    && /^[a-z][a-z0-9_]{1,95}$/.test(error.code)) return error.code;
  return `http_${status}`;
}

function validQueueItem(value) {
  try {
    validateRequest(value?.request);
    return typeof value.enqueued_at === 'string';
  } catch {
    return false;
  }
}

function validDeadLetter(value) {
  return validQueueItem(value)
    && typeof value.reason === 'string'
    && typeof value.rejected_at === 'string';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
