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

export function mountOperatorPlayableReworkControl(
  host: HTMLElement,
  options: {
    occurrence: OperatorPlayableReworkOccurrence;
    existing?: {
      requestId: string;
      state: 'open' | 'claimed' | 'closed';
      request: { playableId: string };
    } | null;
    createMutationId(): string;
    resolveOccurrence?(): OperatorPlayableReworkOccurrence;
    submit(request: OperatorPlayableReworkRequestV1): Promise<unknown>;
  },
): OperatorPlayableReworkControl;
