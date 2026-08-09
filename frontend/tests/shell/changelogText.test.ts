import { describe, it, expect } from "vitest";
import { CHANGELOG_MARKDOWN } from "../../src/shell/changelogText";

describe("CHANGELOG_MARKDOWN", () => {
    it("starts with the top-level Changelog heading", () => {
        expect(CHANGELOG_MARKDOWN.startsWith("# Changelog")).toBe(true);
    });

    it("contains at least one release heading", () => {
        expect(CHANGELOG_MARKDOWN).toMatch(/^## \[\d+\.\d+\.\d+\]/m);
    });

    it("contains at least one link-reference definition", () => {
        // The rendering of this construct (a release heading linking to its GitHub
        // tag via a trailing reference-style definition) is checked manually — see
        // the changelog-dialog plan's "## Expected Behaviour" — this only pins that
        // the source text still carries the construct to render.
        expect(CHANGELOG_MARKDOWN).toMatch(/^\[\d+\.\d+\.\d+\]: https:\/\//m);
    });
});
