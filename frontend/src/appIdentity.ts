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
 * The app's mark: a database drum on a rounded plate, the tab icon that says
 * SQLAdmin rather than the library it is built on.
 *
 * Geometry, on a 32-unit viewBox so every dimension is a whole number and each
 * unit is half a pixel in a 16px browser tab: the plate is the full 32×32 with
 * a 6-unit corner radius, and clips the drum so it inherits those rounded
 * corners. The drum spans x 6-26 — its top ellipse at `cy` 8, its body from
 * y 8 to y 24, its bottom ellipse at `cy` 24 — and two 2-unit plate-coloured
 * bands at y 13 and y 19 cut it into the three stacked platters that read as a
 * database at tab size.
 *
 * Colours are fixed rather than read from the active theme, and the SVG carries
 * its own `prefers-color-scheme` rule so the mark suits light *and* dark
 * browser chrome. The dark pair `#505050` / `#78AAF0` is lifted from the
 * library's own mark, so SQLAdmin's icon and the framework's sit together.
 *
 * Declared with single quotes because the string is full of double quotes.
 *
 * Exported for the encoding round-trip test; {@link APP_FAVICON} is what the
 * app actually installs.
 */
export const APP_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.plate{fill:#FFFFFF}.mark{fill:#000000}@media(prefers-color-scheme:dark){.plate{fill:#505050}.mark{fill:#78AAF0}}</style><clipPath id="plate"><rect width="32" height="32" rx="6"/></clipPath><g clip-path="url(#plate)"><rect class="plate" width="32" height="32"/><ellipse class="mark" cx="16" cy="8" rx="10" ry="4"/><rect class="mark" x="6" y="8" width="20" height="16"/><ellipse class="mark" cx="16" cy="24" rx="10" ry="4"/><rect class="plate" x="6" y="13" width="20" height="2"/><rect class="plate" x="6" y="19" width="20" height="2"/></g></svg>';

/**
 * The app's mark as a ready-to-use `data:` URI, for `Body.init`'s `favicon`
 * option. Without it the library installs its own mark and the app wears the
 * framework's identity in the browser tab.
 *
 * Encoded with `encodeURIComponent` rather than a hand-written escape list.
 * Getting that list wrong fails silently: an unescaped `#` truncates the URI at
 * `url(#plate)`, dropping the clip path and rendering a blank tab icon with
 * nothing in the console.
 */
export const APP_FAVICON = `data:image/svg+xml,${encodeURIComponent(APP_MARK_SVG)}`;
