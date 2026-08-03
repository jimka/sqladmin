import { describe, it, expect } from "vitest";
import { APP_MARK_SVG, APP_FAVICON } from "../src/appIdentity";

const DATA_URI_PREFIX = "data:image/svg+xml,";

describe("APP_FAVICON", () => {
    it("is an SVG data URI", () => {
        expect(APP_FAVICON.startsWith(DATA_URI_PREFIX)).toBe(true);
    });

    it("encodes the mark so no character breaks the data URI", () => {
        const encoded = APP_FAVICON.slice(DATA_URI_PREFIX.length);

        // An unescaped '#' would truncate the URI at the fragment, dropping
        // every element after it and rendering an empty tab icon.
        // decodeURIComponent alone cannot catch that — it returns a string
        // carrying no '%' unchanged, so an unencoded payload round-trips just
        // as happily as an encoded one.
        expect(encoded).not.toMatch(/[#<>"]/);
        expect(decodeURIComponent(encoded)).toBe(APP_MARK_SVG);
    });
});

describe("APP_MARK_SVG", () => {
    it("carries the '#' that makes the encoding necessary", () => {
        // Asserted as the character rather than the element that happens to
        // carry it: the mark's shapes are free to change, but every colour
        // literal is a '#', so the encoding requirement outlives any redesign.
        expect(APP_MARK_SVG).toContain("#");
    });

    it("adapts to dark browser chrome", () => {
        expect(APP_MARK_SVG).toContain("prefers-color-scheme:dark");
    });
});
