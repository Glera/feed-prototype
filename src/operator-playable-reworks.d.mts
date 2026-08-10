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
  destroy(): void;
}

export function buildOperatorPlayableReworkRequest(input: {
  mutationId: string;
  occurrence: OperatorPlayableReworkOccurrence;
  instruction: string;
  screenshot: OperatorPlayableReworkRequestV1['context']['screenshot'];
}): Readonly<OperatorPlayableReworkRequestV1>;

export function operatorPlayableReworkErrorMessage(error: unknown): string;

export function operatorPlayableReworkControlKey(
  occurrence: OperatorPlayableReworkOccurrence,
  existing?: {
    requestId: string;
    state: 'open' | 'claimed' | 'closed';
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
  } | null,
): string;

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
    existing?: {
      requestId: string;
      state: 'open' | 'claimed' | 'closed';
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
      request: Pick<OperatorPlayableReworkRequestV1, 'playableId' | 'instruction' | 'context'>;
    } | null;
    createMutationId(): string;
    resolveOccurrence?(): OperatorPlayableReworkOccurrence;
    submit(request: OperatorPlayableReworkRequestV1): Promise<unknown>;
  },
): OperatorPlayableReworkControl;
