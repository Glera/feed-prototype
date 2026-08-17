export interface OperatorScreenshotV1 {
  kind: 'unavailable' | 'data_url';
  reason: string | null;
  mimeType: 'image/jpeg' | 'image/png' | null;
  dataUrl: string | null;
}

export const SCREENSHOT_DATA_URL_LIMIT: 500_000;
export const SCREENSHOT_PASSTHROUGH_BYTES: 370_000;
export const SCREENSHOT_MAX_EDGE: 1_600;

export function prepareScreenshotFromFile(
  file: File | null,
  code: string,
): Promise<Readonly<OperatorScreenshotV1>>;

export function formatScreenshotBytes(value: number): string;

export function screenshotSelectionLabel(file: File | null): string;

export function screenshotSelectionMarkup(hook: string): string;
