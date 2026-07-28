export interface DebugPanelQaRouteSources {
  dev?: unknown;
  search?: string;
  startParam?: unknown;
}

export function operatorDebugPanelAvailable(value: unknown): boolean;
export function debugPanelQaRouteRequested(sources?: DebugPanelQaRouteSources): boolean;
