/**
 * Per-user localStorage scoping.
 *
 * One physical device can carry several accounts — a shared phone, or an account
 * switch inside a single Telegram WebView — while `localStorage` is keyed by
 * ORIGIN only. Anything that persists PLAYER state must therefore be namespaced
 * by the same identity the client authenticates with:
 * `Telegram.WebApp.initDataUnsafe.user.id`, the id carried inside the `initData`
 * every API call is signed with. Reusing that exact source (and not, say, the
 * `/session` response) keeps the scope available at boot, before the first
 * request, which is when the first read usually happens.
 *
 * Fail-safe: outside Telegram (dev harnesses, a plain browser tab, a WebView
 * that has no signed initData at all) there is no user id, and the key stays
 * byte-identical to what it has always been. Nothing is scoped, nothing is lost.
 *
 * Device-owned preferences (sound, a generator client id, …) deliberately do NOT
 * belong here: they describe the device, not the player.
 */
import { getTelegramIdentityInitData } from './telegram';

/** The authenticated Telegram user id, or null when there is no identity. */
export function telegramUserId(): string | null {
  const unsafeId = (globalThis as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  if (Number.isSafeInteger(unsafeId)) return String(unsafeId);
  // Fall back to the signed `initData` itself — the exact credential every API
  // call is authenticated with. It stays readable when the WebView has not
  // hydrated `initDataUnsafe` (and in harnesses that pass `?initData=`), so the
  // scope does not silently collapse to device-wide in precisely those cases.
  try {
    const rawUser = new URLSearchParams(getTelegramIdentityInitData() ?? '').get('user');
    const parsed = rawUser ? JSON.parse(rawUser) as { id?: unknown } : null;
    if (parsed && typeof parsed.id === 'number' && Number.isSafeInteger(parsed.id)) return String(parsed.id);
  } catch { /* dev initData without a parseable user */ }
  return null;
}

/** True when a real user identity backs the current scope. */
export function isUserScoped(): boolean {
  return telegramUserId() !== null;
}

/**
 * `<base>:<userId>` inside Telegram, plain `<base>` otherwise. Always resolved
 * lazily at the call site: the user id can appear after module evaluation.
 */
export function userScopedStorageKey(base: string): string {
  const userId = telegramUserId();
  return userId ? `${base}:${userId}` : base;
}

/**
 * A `Storage` view whose keys are user-scoped. Lets modules that own their key
 * internally (the `.mjs` contract modules) be scoped from the call site without
 * changing their frozen signatures. Scoping is applied per operation, so the
 * same wrapper follows an account switch.
 */
export function userScopedStorage(storage: Storage): Storage {
  const view = {
    get length(): number { return storage.length; },
    clear: (): void => storage.clear(),
    key: (index: number): string | null => storage.key(index),
    getItem: (key: string): string | null => storage.getItem(userScopedStorageKey(key)),
    setItem: (key: string, value: string): void => storage.setItem(userScopedStorageKey(key), value),
    removeItem: (key: string): void => storage.removeItem(userScopedStorageKey(key)),
  };
  return view as unknown as Storage;
}
