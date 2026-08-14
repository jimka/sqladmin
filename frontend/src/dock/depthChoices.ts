// The DOM-free depth vocabulary: the DEPTH_CHOICES a rooted diagram's Depth
// control offers, the All sentinel, and the conversions between a choice and
// its hop count. Kept out of diagramShell.ts (which owns the Depth control
// itself, and imports ComboBox, Checkbox, and the library's Panel at module
// scope — touching `document` and unloadable under the project's
// node-environment vitest) so depthChoice/depthFromChoice can be unit-tested
// under the node harness — mirroring recordNavigation.ts's own DOM-free split.

/** The `Depth` choice meaning an unbounded walk. */
export const DEPTH_ALL = "All";

/** Depth choices offered by the control, in order. Capped at 3 hops before
 *  `All` because deeper walks quickly pull in most of the schema and defeat
 *  the point of a rooted view. */
export const DEPTH_CHOICES = ["1", "2", "3", DEPTH_ALL];

/** The depth every rooted diagram opens at — one hop keeps the first cut
 *  readable, the root plus its direct neighbours, not the whole transitive
 *  closure. The user widens it via the Depth control. */
export const DEFAULT_DEPTH = 1;

/**
 * The hop limit a `Depth` choice means.
 *
 * @param choice - A `DEPTH_CHOICES` entry.
 * @returns The hop count, or `Number.POSITIVE_INFINITY` for `DEPTH_ALL`.
 */
export function depthFromChoice(choice: string): number {
    return choice === DEPTH_ALL ? Number.POSITIVE_INFINITY : Number(choice);
}

/**
 * Normalize a raw depth request (a route's `depth` query value, or a panel's
 * `initialDepth`) onto a `DEPTH_CHOICES` entry. Case-insensitive for `All`;
 * anything unrecognized falls back to `String(DEFAULT_DEPTH)`.
 *
 * @param raw - The raw request, or undefined when none was given.
 * @returns A `DEPTH_CHOICES` entry.
 */
export function depthChoice(raw: string | undefined): string {
    if (raw === undefined) {
        return String(DEFAULT_DEPTH);
    }

    if (raw.toLowerCase() === DEPTH_ALL.toLowerCase()) {
        return DEPTH_ALL;
    }

    return DEPTH_CHOICES.includes(raw) ? raw : String(DEFAULT_DEPTH);
}
