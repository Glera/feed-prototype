export interface PlatformDevelopmentIntakeScreenshotV1 {
  kind: 'unavailable' | 'data_url';
  reason: string | null;
  mimeType: 'image/jpeg' | 'image/png' | null;
  dataUrl: string | null;
}

export interface PlatformDevelopmentIntakeRequestV1 {
  schema: 'platform.development-intake.request.v1';
  mutationId: string;
  instruction: string;
  surface: string;
  route: string;
  buildSha: string;
  capturedAt: string;
  screenshot: PlatformDevelopmentIntakeScreenshotV1;
}

export interface PlatformDevelopmentIntakeCancelV1 {
  schema: 'platform.development-intake.cancel.v1';
  mutationId: string;
  requestHash: string;
  reason: 'obsolete';
}

export interface PlatformDevelopmentIntakeReceiptV1 {
  schema: 'platform.development-intake.response.v1';
  requestId: string;
  mutationId: string;
  requestHash: string;
  delivery: {
    deliveryId: string;
    status: 'queued' | 'send_started' | 'outcome_unknown' | 'retry_wait' | 'confirmed' | 'failed_terminal';
    issueUrl: string | null;
    nothingPublished: boolean;
  };
  terminal: {
    status: 'READY_TO_PLAY' | 'NEEDS_HELP';
    summary: string;
    candidate: {
      repository: string;
      commitSha: string;
      artifactDigest: string;
      url: string;
    } | null;
    blocker: { reasonCode: string; operatorAction: string } | null;
    review: ({
      provider: 'claude';
      verdict: 'APPROVE';
      patchDigest: string;
      reviewedAt: string;
    } | {
      provider: 'platform-delivery';
      verdict: 'LIVE';
      platformCommitSha: string;
      deployedAt: string;
      stageTimings: {
        queueSeconds: number;
        authoringSeconds: number;
        ciMergeSeconds: number;
        rolloutSeconds: number;
        totalSeconds: number;
      };
    }) | null;
    recordedAt: string;
    nothingPublished: boolean;
  } | null;
  cancellation?: {
    mutationId: string;
    status: 'requested' | 'started' | 'outcome_unknown' | 'confirmed' | 'failed_terminal';
    reason: 'obsolete';
    requestedAt: string;
    cancelledAt: string | null;
    issueClosed: boolean;
    lastErrorCode: string | null;
  } | null;
  request: PlatformDevelopmentIntakeRequestV1;
  replayed: boolean;
  createdAt: string;
}

export interface PlatformDevelopmentIntakeControl {
  destroy(): void;
  update(receipts: ReadonlyArray<PlatformDevelopmentIntakeReceiptV1>): void;
}

export function platformDevelopmentIntakeAvailable(value: unknown): boolean;
export function platformDevelopmentIntakeSessionGrant(
  value: unknown,
  context: unknown,
  buildSha: string | null,
): boolean;
export function buildPlatformDevelopmentIntakeRequest(input: {
  mutationId: string;
  instruction: string;
  surface: string;
  route: string;
  buildSha: string;
  screenshot: PlatformDevelopmentIntakeScreenshotV1;
  capturedAt?: string;
}): Readonly<PlatformDevelopmentIntakeRequestV1>;
export function platformDevelopmentIntakePendingStorageKey(options: {
  actorUserId: number;
  buildSha: string;
  route: string;
}): string;
export function restorePlatformDevelopmentIntakePendingRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined,
  options: { actorUserId: number; buildSha: string; route: string; surface: string },
): Readonly<PlatformDevelopmentIntakeRequestV1> | null;
export function persistPlatformDevelopmentIntakePendingRequest(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  options: { actorUserId: number; buildSha: string; route: string; surface: string },
  request: PlatformDevelopmentIntakeRequestV1,
): boolean;
export function persistPlatformDevelopmentIntakePendingRequestWithFallback(
  primaryStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  fallbackStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  options: { actorUserId: number; buildSha: string; route: string; surface: string },
  request: PlatformDevelopmentIntakeRequestV1,
): 'primary' | 'fallback' | null;
export function validatePlatformDevelopmentIntakeReceipt(
  value: unknown,
  expectedRequest?: PlatformDevelopmentIntakeRequestV1 | null,
): Readonly<PlatformDevelopmentIntakeReceiptV1>;
export function validatePlatformDevelopmentIntakeList(value: unknown): Readonly<{
  schema: 'platform.development-intake.list.v1';
  items: ReadonlyArray<Readonly<PlatformDevelopmentIntakeReceiptV1>>;
}>;
export function buildPlatformDevelopmentIntakeCancelRequest(input: {
  mutationId: string;
  requestHash: string;
}): Readonly<PlatformDevelopmentIntakeCancelV1>;
export function platformDevelopmentIntakeFailureDisposition(error: unknown): 'rejected' | 'retry';
export function platformDevelopmentIntakeErrorMessage(error: unknown): string;
export function platformDevelopmentIntakeQueuePresentation(
  receipts: ReadonlyArray<PlatformDevelopmentIntakeReceiptV1>,
): ReadonlyArray<Readonly<{
  receipt: PlatformDevelopmentIntakeReceiptV1;
  label: string;
  state: 'active' | 'queued' | 'needs_help';
}>>;
export function mountPlatformDevelopmentIntakeControl(
  host: HTMLElement,
  options: {
    actorUserId: number;
    buildSha: string;
    surface: string;
    route: string;
    storage?: Storage;
    fallbackStorage?: Storage;
    existing?: ReadonlyArray<PlatformDevelopmentIntakeReceiptV1>;
    createMutationId(): string;
    submit(request: PlatformDevelopmentIntakeRequestV1): Promise<PlatformDevelopmentIntakeReceiptV1>;
    cancel?(
      requestId: string,
      request: PlatformDevelopmentIntakeCancelV1,
    ): Promise<PlatformDevelopmentIntakeReceiptV1>;
    refresh?(): void | Promise<void>;
    vocabulary?: import('./operator-presentation-vocabulary.mjs').OperatorPresentationVocabularyV1;
  },
): PlatformDevelopmentIntakeControl;
