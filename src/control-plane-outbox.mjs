const STATE_SCHEMA = 'control-plane-outbox.v2';
const MAX_BATCH = 100;
const MAX_DEAD_LETTERS = 200;
const MAX_RECEIPTS = 256;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Durable, ordered control-plane queue.
 *
 * The caller owns feature gating and lifecycle hooks. This class owns the
 * immutable envelope, `(client_instance_id, seq)` order, retry backoff and
 * per-item ACK/dead-letter semantics. `pending_dependency` is a durable server
 * receipt, so it is removed locally just like `stored`/`projected`.
 */
export class DurableControlPlaneOutbox {
  constructor(options) {
    this._storage = options.storage;
    this._storageKey = options.storageKey;
    this._endpoint = options.endpoint;
    this._sessionId = options.sessionId;
    this._authorization = options.authorization;
    this._fetch = options.fetcher ?? globalThis.fetch?.bind(globalThis);
    this._now = options.now ?? (() => Date.now());
    this._uuid = options.uuid ?? controlPlaneUuid;
    this._state = loadState(this._storage, this._storageKey, this._uuid);
    // Exact per-item statuses are intentionally page-local. Durable envelopes
    // remain the source of retry truth; this bounded map lets a safety gate
    // distinguish `projected` from merely stored/pending_dependency.
    this._receipts = new Map();
    this._flushPromise = null;
    this._flushRequested = false;
    this._forceRequested = false;
  }

  enqueue(eventName, payload, occurredAt = new Date(this._now()).toISOString()) {
    if (typeof eventName !== 'string' || eventName.length < 1 || eventName.length > 48) {
      throw new TypeError('eventName must contain 1..48 characters');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('payload must be an object');
    }
    // The feed marks an item emitted only after this method returns an
    // envelope. Keep an exact rollback snapshot so a full/blocked storage
    // cannot turn an in-memory enqueue into a false durable acknowledgement.
    const previousState = jsonClone(this._state);
    if (this._state.nextSeq >= Number.MAX_SAFE_INTEGER) {
      if (this._state.pending.length > 0) throw new Error('control-plane sequence exhausted with pending events');
      this._state.clientInstanceId = this._uuid();
      this._state.nextSeq = 0;
    }
    const occurred = validIso(occurredAt);
    const envelope = {
      event_id: this._uuid(),
      client_instance_id: this._state.clientInstanceId,
      seq: this._state.nextSeq,
      session_id: this._sessionId,
      event_name: eventName,
      payload: jsonClone(payload),
      occurred_at: occurred,
      // Freeze sent_at before the first network attempt. A lost response must
      // retry the byte-equivalent identity instead of mutating the envelope.
      sent_at: new Date(this._now()).toISOString(),
    };
    this._state.nextSeq += 1;
    this._state.pending.push(envelope);
    if (!this._persist()) {
      this._state = previousState;
      return null;
    }
    // Never expose the object retained by the queue: caller mutation must not
    // alter an already-persisted retry envelope.
    return jsonClone(envelope);
  }

  flush(options = {}) {
    this._flushRequested = true;
    this._forceRequested ||= Boolean(options.force);
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this._drainFlushRequests()
      .finally(() => { this._flushPromise = null; });
    return this._flushPromise;
  }

  async _drainFlushRequests() {
    let latest = result('empty', 0, 0, 0, this);
    do {
      const force = this._forceRequested;
      this._flushRequested = false;
      this._forceRequested = false;
      latest = await this._flush(force);
      // A caller may enqueue and request a flush while the previous empty or
      // in-flight pass still owns `_flushPromise`. Loop before resolving that
      // shared promise so the new durable item cannot wait for the 5s timer.
    } while (this._flushRequested);
    return latest;
  }

  async _flush(force) {
    if (this._state.pending.length === 0) return result('empty', 0, 0, 0, this);
    if (typeof this._fetch !== 'function') return this._retryFailure('transport_unavailable');
    const authorization = this._authorization();
    if (!authorization) return result('auth_missing', 0, 0, 0, this);
    if (!force && this._state.nextRetryAt > this._now()) {
      return result('backoff', 0, 0, 0, this);
    }

    let acknowledged = 0;
    let rejected = 0;
    // Bound one flush so a huge recovered queue cannot monopolise the UI task.
    for (let batchNumber = 0; batchNumber < 5 && this._state.pending.length > 0; batchNumber += 1) {
      const batch = [...this._state.pending]
        .sort((left, right) => left.seq - right.seq)
        .slice(0, MAX_BATCH);
      let response;
      try {
        response = await this._fetch(this._endpoint, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
        });
      } catch {
        return this._retryFailure('transport_error', acknowledged, rejected);
      }
      if (!response?.ok) {
        return this._retryFailure(`http_${Number(response?.status) || 0}`, acknowledged, rejected);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return this._retryFailure('invalid_response', acknowledged, rejected);
      }
      if (!body || !Array.isArray(body.events)) {
        return this._retryFailure('invalid_response', acknowledged, rejected);
      }

      const byId = new Map();
      for (const ack of body.events) {
        if (ack && typeof ack === 'object' && typeof ack.event_id === 'string') {
          byId.set(ack.event_id, ack);
        }
      }
      const terminalIds = new Set();
      let missingAck = false;
      for (const event of batch) {
        const ack = byId.get(event.event_id);
        if (!ack || !['stored', 'projected', 'pending_dependency', 'rejected'].includes(ack.status)) {
          missingAck = true;
          continue;
        }
        terminalIds.add(event.event_id);
        this._recordReceipt(event.event_id, ack.status);
        if (ack.status === 'rejected') {
          rejected += 1;
          this._state.deadLetters.push({
            event,
            rejectReason: typeof ack.reject_reason === 'string' ? ack.reject_reason : 'rejected',
            rejectedAt: new Date(this._now()).toISOString(),
          });
        } else {
          acknowledged += 1;
        }
      }
      if (terminalIds.size > 0) {
        this._state.pending = this._state.pending.filter((event) => !terminalIds.has(event.event_id));
        if (this._state.deadLetters.length > MAX_DEAD_LETTERS) {
          this._state.deadLetters.splice(0, this._state.deadLetters.length - MAX_DEAD_LETTERS);
        }
        this._persist();
      }
      if (missingAck) return this._retryFailure('missing_ack', acknowledged, rejected);
    }

    this._state.retryAttempt = 0;
    this._state.nextRetryAt = 0;
    this._persist();
    return result('ok', acknowledged, rejected, 0, this);
  }

  _retryFailure(reason, acknowledged = 0, rejected = 0) {
    this._state.retryAttempt += 1;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * (2 ** Math.min(16, this._state.retryAttempt - 1)),
    );
    this._state.nextRetryAt = this._now() + delay;
    this._persist();
    return result(reason, acknowledged, rejected, delay, this);
  }

  pendingCount() {
    return this._state.pending.length;
  }

  deadLetterCount() {
    return this._state.deadLetters.length;
  }

  deadLetters() {
    return jsonClone(this._state.deadLetters);
  }

  /** Exact receipt state for a previously enqueued event identity. */
  eventState(eventId) {
    if (this._state.pending.some((event) => event.event_id === eventId)) return 'pending';
    if (this._state.deadLetters.some((entry) => entry.event.event_id === eventId)) return 'rejected';
    // The outbox removes an envelope only after a per-item ACK. Callers retain
    // the event id returned by enqueue, so absence from both durable sets is an
    // exact acknowledgement rather than a global queue heuristic.
    return 'acknowledged';
  }

  eventReceiptStatus(eventId) {
    if (this._state.pending.some((event) => event.event_id === eventId)) return 'pending';
    if (this._state.deadLetters.some((entry) => entry.event.event_id === eventId)) return 'rejected';
    return this._receipts.get(eventId) ?? 'unavailable';
  }

  _recordReceipt(eventId, status) {
    this._receipts.set(eventId, status);
    while (this._receipts.size > MAX_RECEIPTS) {
      this._receipts.delete(this._receipts.keys().next().value);
    }
  }

  nextRetryAt() {
    return this._state.nextRetryAt;
  }

  clear() {
    this._state.pending = [];
    this._state.deadLetters = [];
    this._state.retryAttempt = 0;
    this._state.nextRetryAt = 0;
    this._receipts.clear();
    this._persist();
  }

  _persist() {
    try {
      this._storage.setItem(this._storageKey, JSON.stringify(this._state));
      return true;
    } catch {
      return false;
    }
  }
}

function result(status, acknowledged, rejected, retryInMs, outbox) {
  return {
    status,
    acknowledged,
    rejected,
    pending: outbox.pendingCount(),
    retryInMs,
  };
}

function loadState(storage, key, uuid) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(key) || 'null'); } catch { /* corrupt/missing */ }
  if (!raw || raw.schema !== STATE_SCHEMA || typeof raw.clientInstanceId !== 'string') {
    return freshState(uuid());
  }
  const pending = Array.isArray(raw.pending) ? raw.pending.filter(validEnvelope) : [];
  const deadLetters = Array.isArray(raw.deadLetters) ? raw.deadLetters.filter(validDeadLetter) : [];
  const highestSeq = pending.reduce((highest, event) => Math.max(highest, event.seq), -1);
  return {
    schema: STATE_SCHEMA,
    clientInstanceId: raw.clientInstanceId,
    nextSeq: Math.max(highestSeq + 1, safeNonnegativeInteger(raw.nextSeq)),
    pending,
    deadLetters: deadLetters.slice(-MAX_DEAD_LETTERS),
    retryAttempt: safeNonnegativeInteger(raw.retryAttempt),
    nextRetryAt: safeNonnegativeNumber(raw.nextRetryAt),
  };
}

function freshState(clientInstanceId) {
  return {
    schema: STATE_SCHEMA,
    clientInstanceId,
    nextSeq: 0,
    pending: [],
    deadLetters: [],
    retryAttempt: 0,
    nextRetryAt: 0,
  };
}

function validEnvelope(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.event_id === 'string'
    && typeof value.client_instance_id === 'string'
    && Number.isSafeInteger(value.seq) && value.seq >= 0
    && typeof value.session_id === 'string'
    && typeof value.event_name === 'string'
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    && typeof value.occurred_at === 'string'
    && typeof value.sent_at === 'string');
}

function validDeadLetter(value) {
  return Boolean(value && typeof value === 'object' && validEnvelope(value.event)
    && typeof value.rejectReason === 'string' && typeof value.rejectedAt === 'string');
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeNonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : 0;
}

function validIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('occurredAt must be an ISO date-time');
  }
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function controlPlaneUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
