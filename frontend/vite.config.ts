import { defineConfig } from "vite";
import pkg from "./package.json";

// The library is consumed as a symlinked local dependency (file:../../typescript-ui),
// so a few dev-server accommodations are needed:
//   - fs.strict off: the linked package lives outside this project root.
//   - dedupe + optimizeDeps.exclude: avoid double-bundling the linked ESM lib.
//   - /api proxy: the frontend issues relative /api/... calls; forward them to
//     the FastAPI backend so requests stay same-origin (no CORS in dev).
export default defineConfig({
    // The library derives every component's CSS class (and its Dock layout
    // serialization keys) from `this.constructor.name`, so the production
    // minifier must not mangle class identifiers — otherwise constructor.name
    // returns a short string, breaking all CSS scoping and layout save/restore
    // (the page renders unstyled/non-functional). esbuild's keepNames preserves
    // function/class .name through minification, mirroring the keepNames the
    // library's own Vite build already sets.
    esbuild: {
        keepNames: true,
    },
    // Bakes the released package.json version into the bundle as a compile-time
    // constant (declared in src/env.d.ts), so appIdentity.ts's APP_VERSION can
    // never drift from what actually shipped.
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
        port: 5173,
        fs: { strict: false },
        proxy: {
            "/api": "http://localhost:8000",
        },
    },
    resolve: {
        dedupe: ["@jimka/typescript-ui"],
    },
    optimizeDeps: {
        // The schema/database diagrams lazily `import("elkjs/lib/elk.bundled.js")`,
        // which is a CommonJS/UMD bundle. Because @jimka/typescript-ui is excluded
        // below, vite's dep scanner never looks inside it and so never discovers —
        // or CJS→ESM pre-bundles — elkjs. Served raw, its `default` export is
        // undefined, so `new ELK()` throws inside the library and the diagram
        // silently renders empty (the failure is swallowed by its layout catch).
        // Pre-bundling elkjs explicitly restores a proper default export. This only
        // bites when the library is an installed package (a real node_modules copy,
        // as the published ^0.1.0 resolves); with the file: symlink vite scanned the
        // linked source and pre-bundled elkjs on its own. Production builds are
        // unaffected — Rollup handles the CJS interop at build time.
        include: ["elkjs/lib/elk.bundled.js"],
        exclude: ["@jimka/typescript-ui"],
    },
});
