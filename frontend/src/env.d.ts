// Ambient globals injected by the build. `__APP_VERSION__` is a Vite `define`
// replaced with the string literal from frontend/package.json's `version`
// field at build time — set in both vite.config.ts (production/dev) and
// vitest.config.ts (test runs, which don't load vite.config.ts). Consumed by
// src/appIdentity.ts, the single place this global is read.
declare const __APP_VERSION__: string;

// Vite's own ambient declarations (vite/client, which includes `*.md?raw` and
// every other `?raw`/`?url`/asset-suffix import) are not in scope here:
// tsconfig.json sets "types": [], so no ambient .d.ts package is pulled in
// automatically. Hand-write the one suffix this app actually imports —
// src/shell/changelogText.ts's `import text from "../../../CHANGELOG.md?raw"`.
declare module "*.md?raw" {
    const content: string;
    export default content;
}
