/**
 * Persistent operator entry to the on-device debug panel (`mountDebugPanel`).
 *
 * WHO is an operator is decided by the SERVER — the exact same mechanism that
 * reveals the Catalog Lab button sitting next to it in the bottom bar:
 * `/session` answers
 * `catalog_lab_authorization_available = ENABLE_CATALOG_LAB_AUTH && caller.id in DEV_USER_IDS`.
 * The client deliberately carries NO Telegram-id allowlist of its own: a second,
 * client-side answer to "is this the operator?" would be weaker than the one the
 * server already computes for every Lab operation, and it would drift the moment
 * DEV_USER_IDS changes.
 *
 * This is a convenience affordance only. The debug panel itself is not an
 * authorization boundary (every endpoint it calls is server-gated), which is
 * exactly why the pre-existing QA routes — `?diag`, `startapp=diag`, local Vite
 * dev — keep working untouched and independently of the capability.
 */

/** Fail closed: only the exact server capability makes the entry persistent. */
export function operatorDebugPanelAvailable(value) {
  return value === true;
}

/**
 * The QA routes that opened the debug entry before the operator capability
 * existed. Unchanged semantics: any `?diag` value, `start_param=diag`, or a
 * local Vite dev build.
 */
export function debugPanelQaRouteRequested({ dev = false, search = '', startParam = null } = {}) {
  if (dev === true) return true;
  if (startParam === 'diag') return true;
  return new URLSearchParams(String(search || '')).has('diag');
}
