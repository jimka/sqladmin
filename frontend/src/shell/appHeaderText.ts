// The AppHeader's pure string logic, split out from AppHeader.ts so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (mirroring startPageWelcome.ts — see that file's header comment).

/** The strings AppHeader renders, derived from the app identity and the connection. */
export interface AppHeaderText {
    /** The app name, shown bold. */
    name: string;
    /** The version, already `v`-prefixed — e.g. "v0.1.0". */
    version: string;
    /** The connected database, or null when the separator and label are omitted. */
    database: string | null;
    /** The hover tooltip for the whole block. */
    tooltip: string;
}

/**
 * Build the AppHeader's display strings. A blank or absent `database` is
 * treated as "no database": `.database` is null and the tooltip's connection
 * clause is dropped, rather than showing an empty separator/label.
 *
 * @param name - The app name (APP_NAME).
 * @param version - The unprefixed version (APP_VERSION), e.g. "0.1.0".
 * @param tagline - The one-line app description (APP_TAGLINE).
 * @param database - The connected database name, if any.
 *
 * @returns The strings AppHeader renders.
 */
export function appHeaderText(
    name: string,
    version: string,
    tagline: string,
    database?: string,
): AppHeaderText {
    const versionLabel = `v${version}`;
    const db = database ? database : null;
    const tooltip = db
        ? `${name} ${versionLabel} — ${tagline} Connected to “${db}”.`
        : `${name} ${versionLabel} — ${tagline}`;

    return { name, version: versionLabel, database: db, tooltip };
}
