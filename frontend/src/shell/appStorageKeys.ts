// The app's localStorage key-partition rule, shared by the Show localStorage…
// inspector and any future caller: which keys "Clear SQLAdmin data" removes
// vs. which "Clear saved connections" removes. A saved connection preset
// carries a host/port/database/username the user typed once and cannot get
// back, so it is deliberately excluded from the disposable set and gets its
// own confirmed action instead — this is the rule that must never regress,
// so it lives in its own DOM-free module rather than inline in
// localStorageWindow.ts, and is unit-tested here rather than only exercised
// live. Its only import is `PRESETS_KEY` (a plain string constant), so this
// module carries none of the DOM side effects library component modules run
// at import scope and keeps running under the node vitest environment.

import { PRESETS_KEY } from "../data/presetStore";

/** The prefix every key this app persists is namespaced under. */
export const APP_KEY_PREFIX = "sqladmin.";

/** Whether `key` belongs to this app's namespace at all (disposable or not). */
export function isAppKey(key: string): boolean {
    return key.startsWith(APP_KEY_PREFIX);
}

/** Whether `key` is the saved-connection-presets key. */
export function isPresetKey(key: string): boolean {
    return key === PRESETS_KEY;
}

/**
 * Whether `key` is one "Clear SQLAdmin data" removes: an app key that is NOT
 * the presets key. History, saved queries, notes, and layout are either
 * regenerable or cheap to lose; presets are not, so they are carved out and
 * get their own confirmed "Clear saved connections" action instead.
 */
export function isDisposableAppKey(key: string): boolean {
    return isAppKey(key) && !isPresetKey(key);
}
