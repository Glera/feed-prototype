export interface HelpMapPreviewSources {
  search?: string;
  startParam?: string | null;
}

export function helpMapPreviewRequested(sources?: HelpMapPreviewSources): boolean;
