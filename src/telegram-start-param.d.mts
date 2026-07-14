export interface TelegramStartParamSources {
  search?: string;
  hash?: string;
  webViewStartParam?: unknown;
  unsafeStartParam?: unknown;
  initData?: string;
}

export function resolveTelegramStartParam(
  sources?: TelegramStartParamSources,
): string | null;
