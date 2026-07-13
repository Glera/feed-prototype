export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DurableRunTicketRequest {
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'single' | 'series';
  challenge_id?: string;
}

export interface DurableRunTicketView {
  ticket_id: string;
  run_id: string;
  state: 'active' | 'consumed' | 'expired';
}

export interface RunTicketStartFlushResult {
  status: 'ok' | 'retry' | 'invalid_response' | 'storage_error';
  confirmed: number;
  terminal: number;
  pending: number;
  latest: DurableRunTicketView | null;
}

export interface DurableRunTicketStartOutboxOptions {
  storage: StorageLike;
  queueKey: string;
  deadLetterKey: string;
  startRun: (request: DurableRunTicketRequest) => Promise<DurableRunTicketView>;
  now?: () => number;
}

export interface RunTicketStartDeadLetter {
  request: DurableRunTicketRequest;
  enqueued_at: string;
  reason: string;
  response: DurableRunTicketView | null;
  rejected_at: string;
}

export class DurableRunTicketStartOutbox {
  constructor(options: DurableRunTicketStartOutboxOptions);
  enqueue(request: DurableRunTicketRequest): boolean;
  flush(): Promise<RunTicketStartFlushResult>;
  pendingCount(): number;
  deadLetterCount(): number;
  deadLetters(): RunTicketStartDeadLetter[];
  clear(): void;
}
