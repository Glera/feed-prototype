export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DurableLegacyRunTicketRequest {
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'single' | 'series';
  challenge_id?: string;
  schema?: never;
  decision_id?: never;
}

export interface DurableCatalogRunTicketRequestV2 {
  schema: 'run.start.v2';
  ticket_id: string;
  run_id: string;
  mechanic_id: string;
  variant_id: string;
  kind: 'series';
  decision_id: string;
  challenge_id?: null;
}

export type DurableRunTicketRequest = DurableLegacyRunTicketRequest | DurableCatalogRunTicketRequestV2;

export interface DurableLegacyRunTicketView {
  ticket_id: string;
  run_id: string;
  state: 'active' | 'consumed' | 'expired';
}

export interface DurableCatalogRunTicketViewV2 {
  schema: 'run.ticket.v2';
  ticket_id: string;
  run_id: string;
  kind: 'series';
  mechanic_id: string;
  variant_id: string;
  decision_id: string;
  catalog_entry_id: string;
  series_id: string;
  runtime_release_id: string;
  runtime_contract_digest: string;
  runtime_artifact_digest: string;
  manifest_content_hash: string;
  levels: Array<{ ordinal: number; spec_hash: string }>;
  expected_levels: number;
  completed_levels: number;
  next_result_at: string;
  expires_at: string;
  state: 'active' | 'consumed' | 'expired' | 'revoked' | 'superseded';
}

export interface DurableCatalogRunTicketViewV3 extends Omit<DurableCatalogRunTicketViewV2, 'schema'> {
  schema: 'run.ticket.v3';
  skin_hash: string;
  skin_contract_digest: string;
}

export type DurableRunTicketView = DurableLegacyRunTicketView | DurableCatalogRunTicketViewV2 | DurableCatalogRunTicketViewV3;

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
