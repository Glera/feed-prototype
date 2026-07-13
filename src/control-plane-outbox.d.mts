export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ControlPlaneEnvelope {
  event_id: string;
  client_instance_id: string;
  seq: number;
  session_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  sent_at: string;
}

export interface ControlPlaneDeadLetter {
  event: ControlPlaneEnvelope;
  rejectReason: string;
  rejectedAt: string;
}

export interface ControlPlaneFlushResult {
  status: string;
  acknowledged: number;
  rejected: number;
  pending: number;
  retryInMs: number;
}

export interface DurableControlPlaneOutboxOptions {
  storage: StorageLike;
  storageKey: string;
  endpoint: string;
  sessionId: string;
  authorization: () => string | null;
  fetcher?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
}

export class DurableControlPlaneOutbox {
  constructor(options: DurableControlPlaneOutboxOptions);
  enqueue(eventName: string, payload: Record<string, unknown>, occurredAt?: string): ControlPlaneEnvelope | null;
  flush(options?: { force?: boolean }): Promise<ControlPlaneFlushResult>;
  pendingCount(): number;
  deadLetterCount(): number;
  deadLetters(): ControlPlaneDeadLetter[];
  nextRetryAt(): number;
  clear(): void;
}

export function controlPlaneUuid(): string;
