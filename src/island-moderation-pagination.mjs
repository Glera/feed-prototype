/**
 * Run one moderation pagination action while keeping its button retryable.
 *
 * The task owns the keyset cursor: it advances it only after a successful page
 * response. This helper owns the UI lifecycle and guarantees that a transient
 * failure cannot strand the still-mounted button in a disabled state.
 */
export async function runModerationPageAction(button, task) {
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

/** Monotonic request generation: reload/filter changes invalidate every older
 * reload and pagination response without needing transport-specific abort APIs. */
export function createModerationRequestGeneration() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    capture() {
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
  };
}

/** Allow exactly one mutation from a button group to run at a time. */
export async function runExclusiveModerationAction(buttons, task) {
  if (buttons.some((button) => button.disabled)) return false;
  for (const button of buttons) button.disabled = true;
  try {
    await task();
    return true;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

/** Cross-render mutation fence. A paint/reload may replace every DOM button
 * while a POST is in flight, so exclusivity must live outside the DOM group. */
export async function runKeyedModerationAction(inFlight, key, buttons, task) {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  for (const button of buttons) button.disabled = true;
  try {
    await task();
    return true;
  } finally {
    inFlight.delete(key);
    for (const button of buttons) button.disabled = false;
  }
}
