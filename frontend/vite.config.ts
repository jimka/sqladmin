import { defineConfig } from "vite";

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
        exclude: ["@jimka/typescript-ui"],
    },
});
