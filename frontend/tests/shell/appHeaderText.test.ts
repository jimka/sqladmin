import { describe, it, expect } from "vitest";
import { appHeaderText } from "../../src/shell/appHeaderText";

const NAME = "SQLAdmin";
const VERSION = "0.1.0";
const TAGLINE = "A browser-based PostgreSQL administration & query tool.";

describe("appHeaderText", () => {
    it("carries the name, v-prefixed version, and database through unchanged", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE, "sqladmin");

        expect(text.name).toBe("SQLAdmin");
        expect(text.version).toBe("v0.1.0");
        expect(text.database).toBe("sqladmin");
    });

    it("includes the name, version, tagline, and database in the tooltip", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE, "sqladmin");

        expect(text.tooltip).toContain(NAME);
        expect(text.tooltip).toContain("v0.1.0");
        expect(text.tooltip).toContain(TAGLINE);
        expect(text.tooltip).toContain("sqladmin");
    });

    it("drops the database and the tooltip's connection clause when undefined", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE, undefined);

        expect(text.database).toBeNull();
        expect(text.tooltip).not.toContain("Connected to");
    });

    it("treats an empty-string database the same as undefined", () => {
        const text = appHeaderText(NAME, VERSION, TAGLINE, "");

        expect(text.database).toBeNull();
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
