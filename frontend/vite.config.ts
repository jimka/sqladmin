import { defineConfig } from "vite";

// The library is consumed as a symlinked local dependency (file:../../typescript-ui),
// so a few dev-server accommodations are needed:
//   - fs.strict off: the linked package lives outside this project root.
//   - dedupe + optimizeDeps.exclude: avoid double-bundling the linked ESM lib.
//   - /api proxy: the frontend issues relative /api/... calls; forward them to
//     the FastAPI backend so requests stay same-origin (no CORS in dev).
export default defineConfig({
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
