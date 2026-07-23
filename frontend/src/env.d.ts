// Ambient globals injected by the build. `__APP_VERSION__` is a Vite `define`
// replaced with the string literal from frontend/package.json's `version`
// field at build time — set in both vite.config.ts (production/dev) and
// vitest.config.ts (test runs, which don't load vite.config.ts). Consumed by
// src/appIdentity.ts, the single place this global is read.
declare const __APP_VERSION__: string;
