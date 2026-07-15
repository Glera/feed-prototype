export interface CatalogGeneratedPreviewBucket {
  descriptor: Readonly<{ file: string; sha256: string; width: number; height: number }>;
  bytes: Uint8Array;
}
export class CatalogGeneratedPreviewError extends Error {
  readonly code: string;
}
export function loadCatalogGeneratedPreview(options: {
  baseUrl: string;
  contentHash: string;
  runtimeArtifactDigest: string;
  fetchImpl?: typeof fetch;
  cryptoImpl?: Crypto;
}): Promise<Readonly<{
  mobile: CatalogGeneratedPreviewBucket;
  compact: CatalogGeneratedPreviewBucket;
}>>;
