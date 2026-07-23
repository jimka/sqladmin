import { describe, it, expect } from "vitest";
import { appHeaderText } from "../../src/shell/appHeaderText";

const NAME = "SQLAdmin";
const VERSION = "0.1.0";
const TAGLINE = "A browser-based PostgreSQL administration & query tool.";

describe("appHeaderText", () => {
    it("carries the name and the v-prefixed version through unchanged", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE);

        expect(text.name).toBe("SQLAdmin");
        expect(text.version).toBe("v0.1.0");
    });

    it("includes the name, version, and tagline in the tooltip", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE);

        expect(text.tooltip).toContain(NAME);
        expect(text.tooltip).toContain("v0.1.0");
        expect(text.tooltip).toContain(TAGLINE);
    });

    it("never mentions a connected database in the tooltip", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE);

        expect(text.tooltip).not.toContain("Connected to");
    });

    it("prefixes the version with exactly one v", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE);

        expect(text.version).toBe("v0.1.0");
        expect(text.version).not.toBe("vv0.1.0");
    });

    it("passes a dotted prerelease version through unaltered apart from the prefix", () => {
        const text = appHeaderText(NAME, "0.2.0-rc.1", TAGLINE);

        expect(text.version).toBe("v0.2.0-rc.1");
    });
});
