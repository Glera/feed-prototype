/**
 * The visual-viewport source the helper measures. `window.visualViewport`
 * satisfies it; a harness may substitute a fake to stage the divergent case
 * (visual viewport shrinks, layout viewport does not) that a browser's own
 * viewport controls cannot produce.
 */
export interface OperatorFormViewportSource extends EventTarget {
  readonly height: number;
  readonly offsetTop: number;
}

export interface OperatorFormViewportOptions {
  /** Defaults to `window.visualViewport`. */
  viewport?: OperatorFormViewportSource | null;
}

export interface OperatorFormViewport {
  /** Re-measure the visible band and re-assert the focused field's visibility now. */
  reveal(): void;
  /** Drop every listener/timer and the published custom properties. Idempotent. */
  release(): void;
}

export function observeOperatorFormViewport(
  form: HTMLElement | null,
  options?: OperatorFormViewportOptions,
): OperatorFormViewport;
