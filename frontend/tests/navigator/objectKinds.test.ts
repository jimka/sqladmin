// Pure registry-logic tests for the object-kind seam: the single source
// KIND_GLYPH/OBJECT_CATEGORIES/isRelation (in objectGlyphs.ts/NavigatorTree.ts)
// derive from. DOM-free (no glyph registration or Component construction
// happens here — see memory "tsui DOM module side effects").

import { describe, expect, it } from "vitest";
import { isRelationKind, objectCategories, OBJECT_KINDS } from "../../src/navigator/objectKinds";

describe("OBJECT_KINDS", () => {
    it("has exactly one entry per known object kind", () => {
        const kinds = OBJECT_KINDS.map(k => k.kind);

        expect(kinds).toEqual([
            "database", "schema", "table", "view", "materializedView", "sequence", "function", "type",
        ]);
    });

    it("gives every entry a non-empty glyph name", () => {
        for (const entry of OBJECT_KINDS) {
            expect(entry.glyph.length).toBeGreaterThan(0);
        }
    });

    it("leaves database and schema without a category label", () => {
        const database = OBJECT_KINDS.find(k => k.kind === "database");
        const schema = OBJECT_KINDS.find(k => k.kind === "schema");

        expect(database?.categoryLabel).toBeUndefined();
        expect(schema?.categoryLabel).toBeUndefined();
    });

    it("gives table/view/materializedView/sequence/function/type a category label", () => {
        for (const kind of ["table", "view", "materializedView", "sequence", "function", "type"] as const) {
            expect(OBJECT_KINDS.find(k => k.kind === kind)?.categoryLabel).toBeDefined();
        }
    });
});

describe("isRelationKind", () => {
    it("is true for table, view, and materializedView", () => {
        expect(isRelationKind("table")).toBe(true);
        expect(isRelationKind("view")).toBe(true);
        expect(isRelationKind("materializedView")).toBe(true);
    });

    it("is false for database, schema, sequence, function, and type", () => {
        expect(isRelationKind("database")).toBe(false);
        expect(isRelationKind("schema")).toBe(false);
        expect(isRelationKind("sequence")).toBe(false);
        expect(isRelationKind("function")).toBe(false);
        expect(isRelationKind("type")).toBe(false);
    });

    it("is false for undefined", () => {
        expect(isRelationKind(undefined)).toBe(false);
    });
});

describe("objectCategories", () => {
    it("returns one category per labelled kind, in registry order", () => {
        expect(objectCategories()).toEqual([
            { label: "Tables", kind: "table" },
            { label: "Views", kind: "view" },
            { label: "Materialized Views", kind: "materializedView" },
            { label: "Sequences", kind: "sequence" },
            { label: "Functions", kind: "function" },
            { label: "Types", kind: "type" },
        ]);
    });
});
