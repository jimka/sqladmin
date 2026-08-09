// The repo root's CHANGELOG.md is the single source of truth for release
// notes; this module inlines it into the bundle at build time via Vite's
// `?raw` import (ambient-typed in src/env.d.ts), so nothing is fetched at
// runtime and the dialog can never show a stale or missing copy. Deliberately
// imports no library component — library UI modules touch `document` at
// import scope, which would make this module unimportable from a
// node-environment unit test (frontend/vitest.config.ts).
import text from "../../../CHANGELOG.md?raw";

/** The repo root's CHANGELOG.md, inlined into the bundle at build time. */
export const CHANGELOG_MARKDOWN: string = text;
