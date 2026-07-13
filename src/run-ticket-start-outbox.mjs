const TERMINAL_HTTP_STATUSES = new Set([400, 404, 409, 410, 422, 428]);
const TERMINAL_STATES = new Set(['active', 'consumed', 'expired']);
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
        const reason = terminalErrorReason(error);
        if (!reason) {
          return { status: 'retry', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        if (!this._moveToDeadLetter(item, reason)) {
          return { status: 'storage_error', confirmed, terminal, pending: this.pendingCount(), latest };
        }
        terminal += 1;
        continue;
      }
      if (!view || !TERMINAL_STATES.has(view.state)
        || view.ticket_id !== item.request.ticket_id || view.run_id !== item.request.run_id) {
        return { status: 'invalid_response', confirmed, terminal, pending: this.pendingCount(), latest };
      }
      latest = jsonClone(view);
      if (view.state === 'expired') {
        if (!this._moveToDeadLetter(item, 'ticket_expired', view)) {
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
  if (value.challenge_id !== undefined && typeof value.challenge_id !== 'string') {
    throw new TypeError('run-ticket request challenge_id must be a string');
  }
  return jsonClone(value);
}

function terminalErrorReason(error) {
  const status = Number(error?.status);
  return TERMINAL_HTTP_STATUSES.has(status) ? `http_${status}` : null;
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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
