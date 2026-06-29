import { defineConfig } from "vitest/config";

// Unit tests cover the pure data helpers (SQL generation, model building, the
// runQuery fetch client). They need no DOM, so the default node environment is
// used; component/DOM behaviour is verified live, not here.
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
