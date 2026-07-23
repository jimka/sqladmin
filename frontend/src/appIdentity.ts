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
