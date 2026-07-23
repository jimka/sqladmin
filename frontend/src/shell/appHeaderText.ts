// The AppHeader's pure string logic, split out from AppHeader.ts so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (mirroring startPageWelcome.ts — see that file's header comment).

/** The strings AppHeader renders, derived from the app identity. */
export interface AppHeaderText {
    /** The app name, shown bold. */
    name: string;
    /** The version, already `v`-prefixed — e.g. "v0.1.0". */
    version: string;
    /** The hover tooltip for the whole block. */
    tooltip: string;
}

/**
 * Build the AppHeader's display strings. The connected database is deliberately
 * not shown here — the status bar's identity badge already pins it.
 *
 * @param name - The app name (APP_NAME).
 * @param version - The unprefixed version (APP_VERSION), e.g. "0.1.0".
 * @param tagline - The one-line app description (APP_TAGLINE).
 *
 * @returns The strings AppHeader renders.
 */
export function appHeaderText(
    name: string,
    version: string,
    tagline: string,
): AppHeaderText {
    const versionLabel = `v${version}`;

    return { name, version: versionLabel, tooltip: `${name} ${versionLabel} — ${tagline}` };
}
