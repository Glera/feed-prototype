/** Exact in-memory receipts for UI edges that must not infer success from a
 * shared outbox flush. Persistence remains owned by the outbox itself. */
export class ResultReceiptWaiters {
  constructor() {
    this._waiters = new Map();
  }

  wait(runId) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new TypeError('runId is required');
    }
    return new Promise((resolve) => {
      const waiters = this._waiters.get(runId) ?? new Set();
      waiters.add(resolve);
      this._waiters.set(runId, waiters);
    });
  }

  settle(receipt) {
    const runId = receipt?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new TypeError('receipt.runId is required');
    }
    const waiters = this._waiters.get(runId);
    if (!waiters) return 0;
    this._waiters.delete(runId);
    for (const resolve of waiters) resolve(receipt);
    return waiters.size;
  }

  pendingRuns() {
    return this._waiters.size;
  }
}

export function catalogResultAllowsProgress(receipt, runId) {
  return Boolean(receipt && receipt.runId === runId && receipt.status === 'confirmed');
}
