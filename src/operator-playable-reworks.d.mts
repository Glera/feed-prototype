export interface OperatorPlayableReworkOccurrence {
  playableId: string;
  mappingId: string;
  rosterActivationId: string;
  runtime: {
    version: string;
    artifactDigest: string;
    sourceCommit: string | null;
  };
  feedPosition: number;
  level: number | null;
  runId: string | null;
}

export interface OperatorPlayableReworkRequestV1 {
  schema: 'feed.playable-rework.request.v1';
  mutationId: string;
  playableId: string;
  mappingId: string;
  rosterActivationId: string;
  runtime: OperatorPlayableReworkOccurrence['runtime'];
  context: {
    feedPosition: number;
    level: number | null;
    runId: string | null;
    capturedAt: string;
    screenshot: {
      kind: 'unavailable' | 'data_url';
      reason: string | null;
      mimeType: 'image/jpeg' | 'image/png' | null;
      dataUrl: string | null;
    };
  };
  instruction: string;
}

export interface OperatorPlayableReworkControl {
  readonly key: string;
  readonly playableId: string;
  destroy(): void;
}

export interface OperatorPlayableReworkQueueItem {
  requestId: string;
  state: 'open' | 'claimed' | 'closed';
  sourceAdapter: 'telegram' | 'codex';
  queueDisposition: 'active_batch' | 'queued' | 'duplicate_of' | 'closed';
  batchPresent: boolean;
  queueCounts: { active: number; queued: number };
  execution?: {
    state: 'accepted' | 'blocked';
    code: string | null;
    summary: string | null;
    updatedAt: string | null;
  };
  releaseExecution?: {
    releaseId: string;
    state: 'preparing' | 'ready_for_approval' | 'needs_help';
    code: string | null;
    summary: string | null;
    updatedAt: string;
  };
  createdAt?: string;
  request: Pick<OperatorPlayableReworkRequestV1, 'schema' | 'playableId' | 'instruction' | 'context'>;
}

export function buildOperatorPlayableReworkRequest(input: {
  mutationId: string;
  occurrence: OperatorPlayableReworkOccurrence;
  instruction: string;
  screenshot: OperatorPlayableReworkRequestV1['context']['screenshot'];
}): Readonly<OperatorPlayableReworkRequestV1>;

export function screenshotFromFile(
  file: File | null,
): Promise<Readonly<OperatorPlayableReworkRequestV1['context']['screenshot']>>;

export function operatorPlayableReworkErrorMessage(error: unknown): string;

export function operatorPlayableReworkControlKey(
  occurrence: OperatorPlayableReworkOccurrence,
  queue?: readonly OperatorPlayableReworkQueueItem[],
): string;

export function isOperatorPlayableReworkQueueItem(
  value: unknown,
  playableId?: string,
): value is OperatorPlayableReworkQueueItem;

export function groupOperatorPlayableReworkQueue(
  items: readonly unknown[],
): Map<string, OperatorPlayableReworkQueueItem[]>;

export function operatorPlayableReworkQueuePresentation(
  queue: readonly OperatorPlayableReworkQueueItem[],
): Readonly<{
  state: 'idle' | 'active' | 'queued' | 'needs_help';
  label: '✎ Доработать механику' | 'В работе · добавить замечание' | `В работе · ещё ${number}` | 'Нужна помощь · добавить замечание';
  active: number;
  queued: number;
  duplicates: number;
  unresolved: number;
}>;

export function operatorPlayableReworkPresentation(task: {
  state?: string;
  execution?: { state?: string; summary?: string | null };
  releaseExecution?: {
    state?: 'preparing' | 'ready_for_approval' | 'needs_help';
    summary?: string | null;
  };
}): Readonly<{
  state: string;
  icon: string;
  label: 'Готовится' | 'Готово к проверке' | 'Нужна помощь' | 'Задача принята';
  blocker: string | null;
}>;

export function mountOperatorPlayableReworkControl(
  host: HTMLElement,
  options: {
    occurrence: OperatorPlayableReworkOccurrence;
    queue?: readonly OperatorPlayableReworkQueueItem[];
    createMutationId(): string;
    resolveOccurrence?(): OperatorPlayableReworkOccurrence;
    submit(request: OperatorPlayableReworkRequestV1): Promise<{ replayed?: boolean } | void>;
    refresh?(): void | Promise<void>;
  },
): OperatorPlayableReworkControl;
