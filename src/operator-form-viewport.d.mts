export interface OperatorFormViewport {
  /** Re-assert the focused field's visibility now, without waiting for an event. */
  reveal(): void;
  /** Drop every listener/timer and the published viewport height. Idempotent. */
  release(): void;
}

export function observeOperatorFormViewport(form: HTMLElement | null): OperatorFormViewport;
