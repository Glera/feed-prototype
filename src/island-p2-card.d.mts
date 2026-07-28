import type { IslandVisitAward } from './api';

export interface IslandVisitAwardCardOptions {
  parent: HTMLElement;
  award: IslandVisitAward;
  escapeHtml: (value: string) => string;
  onShown?: () => void;
  onDecline?: () => void | Promise<void>;
  onAccept?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export function mountIslandVisitAwardCard(
  options: IslandVisitAwardCardOptions,
): HTMLElement | null;
