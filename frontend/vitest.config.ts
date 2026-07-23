import { defineConfig } from "vitest/config";
import pkg from "./package.json";

// Unit tests cover the pure data helpers (SQL generation, model building, the
// runQuery fetch client). They need no DOM, so the default node environment is
// used; component/DOM behaviour is verified live, not here.
export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
    // vitest.config.ts replaces vite.config.ts for test runs rather than
    // merging with it, so appIdentity.ts's __APP_VERSION__ global needs the
    // same define here too — otherwise any test importing it fails on an
    // undefined global (see vite.config.ts for the production side).
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
});
