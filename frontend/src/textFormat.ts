// The app's small pure value-to-display-string helpers. Imports nothing from
// the library, so this module runs under the node vitest.

/** Human-readable Yes/No for a boolean flag row. */
export function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}
