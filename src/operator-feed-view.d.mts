export type OperatorFeedView = 'dev' | 'release';

export function operatorFeedView(search?: string): OperatorFeedView;

export function operatorFeedViewUrl(view: OperatorFeedView, href?: string): URL;

export function mountOperatorFeedViewToggle(
  host: HTMLElement,
  options: {
    view: OperatorFeedView;
    onChange(view: OperatorFeedView): void;
  },
): Readonly<{ destroy(): void }>;
