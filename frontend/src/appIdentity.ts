// The single source of the app's name, version, and one-line description.
// Every on-screen surface that names the app — the menu-bar AppHeader, the
// About dialog, the start page heading, the localStorage window's button —
// reads these constants rather than writing its own literal, so the app
// cannot spell itself two different ways or show a stale version.

/** The canonical app name, as it should appear anywhere in the UI. */
export const APP_NAME = "SQLAdmin";

// Injected at build time from frontend/package.json's `version` field via a
// Vite `define` (see vite.config.ts and vitest.config.ts; the ambient
// declaration lives in src/env.d.ts) — so the released package.json version
// is the only place this is ever written by hand.
/** The app's version, as released — e.g. "0.1.0". Unprefixed (no leading "v"). */
export const APP_VERSION: string = __APP_VERSION__;

/** A one-line description of what the app is. */
export const APP_TAGLINE = "A browser-based PostgreSQL administration & query tool.";

/**
 * The app's mark: a database drum filling its whole viewBox, the tab icon that
 * says SQLAdmin rather than the library it is built on.
 *
 * Geometry, on a 32-unit viewBox so every dimension is a whole number and each
 * unit is half a pixel in a 16px browser tab: the drum is full-bleed, spanning
 * the entire width at `rx` 16. Its top ellipse sits at `cy` 6 and its bottom at
 * `cy` 26, both `ry` 4, so the silhouette runs from y 2 to y 30. Three 4-unit
 * bands at y 6, 14 and 22 form the platters, and the two 4-unit gaps between
 * them are left transparent rather than painted, so the browser's own tab
 * colour separates the platters in either theme. Full-bleed because an inset
 * mark loses most of its detail once a 32-unit drawing is downsampled to a
 * 16px tab.
 *
 * Colours are fixed rather than read from the active theme, and the SVG carries
 * its own `prefers-color-scheme` rule so the mark suits light *and* dark
 * browser chrome. The dark `#78AAF0` is lifted from the library's own mark, so
 * SQLAdmin's icon and the framework's sit together.
 *
 * Declared with single quotes because the string is full of double quotes, and
 * on one line because every newline and indent would be percent-encoded into
 * the data URI that ships on every page load.
 *
 * Exported for the encoding round-trip test; {@link APP_FAVICON} is what the
 * app actually installs.
 */
export const APP_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.mark{fill:#000000}@media(prefers-color-scheme:dark){.mark{fill:#78AAF0}}</style><ellipse class="mark" cx="16" cy="6" rx="16" ry="4"/><rect class="mark" x="0" y="6" width="32" height="4"/><rect class="mark" x="0" y="14" width="32" height="4"/><rect class="mark" x="0" y="22" width="32" height="4"/><ellipse class="mark" cx="16" cy="26" rx="16" ry="4"/></svg>';

/**
 * The app's mark as a ready-to-use `data:` URI, for `Body.init`'s `favicon`
 * option. Without it the library installs its own mark and the app wears the
 * framework's identity in the browser tab.
 *
 * Encoded with `encodeURIComponent` rather than a hand-written escape list.
 * Getting that list wrong fails silently: an unescaped `#` truncates the URI at
 * the first colour literal — `#000000` — dropping every element after it and
 * rendering a blank tab icon with nothing in the console.
 */
export const APP_FAVICON = `data:image/svg+xml,${encodeURIComponent(APP_MARK_SVG)}`;
