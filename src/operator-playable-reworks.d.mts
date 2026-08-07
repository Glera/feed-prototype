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
  } | null,
): string;

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
      createdAt?: string;
      request: Pick<OperatorPlayableReworkRequestV1, 'playableId' | 'instruction' | 'context'>;
    } | null;
    createMutationId(): string;
    resolveOccurrence?(): OperatorPlayableReworkOccurrence;
    submit(request: OperatorPlayableReworkRequestV1): Promise<unknown>;
  },
): OperatorPlayableReworkControl;
