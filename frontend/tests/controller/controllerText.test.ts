// Pins controllerText.ts's pure string derivations — panel ids, panelIdsFor,
// panelTooltip, elideName, errorMessage, detailOf — against the plan's
// `## Expected Behaviour` cases 1-14 (plans/implemented/sqladmin-controller-split.md).
// tableExportFilename is a later addition (see the plan's `## Implementation
// Notes`), pinned in its own describe block below.

import { describe, expect, it } from "vitest";
import {
    panelId, structurePanelId, definitionPanelId, sequenceInfoPanelId, indexInfoPanelId,
    typeInfoPanelId, functionDefinitionPanelId, diagramPanelId, relationDiagramPanelId,
    relationDependencyPanelId, relationInheritancePanelId, dependencyPanelId, inheritancePanelId,
    databaseDiagramPanelId, ddlPanelId, notesPanelId, roleGrantsPanelId, roleGrantsDiagramPanelId,
    roleMembershipDiagramPanelId, panelIdsFor, panelTooltip, elideName, errorMessage, detailOf,
    tableExportFilename,
} from "../../src/controller/controllerText";
import type { DbObjectRef } from "../../src/contract";

const REF: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", name: "orders", kind: "table" };

describe("panel id builders (cases 1-2)", () => {
    it("case 1: panelId and its ::suffix siblings are all distinct", () => {
        expect(panelId(REF)).toBe("default/sqladmin/public.orders");
        expect(structurePanelId(REF)).toBe("default/sqladmin/public.orders::structure");
        expect(definitionPanelId(REF)).toBe("default/sqladmin/public.orders::definition");
        expect(sequenceInfoPanelId(REF)).toBe("default/sqladmin/public.orders::sequence");
        expect(indexInfoPanelId(REF)).toBe("default/sqladmin/public.orders::index");
        expect(typeInfoPanelId(REF)).toBe("default/sqladmin/public.orders::type");
        expect(relationDiagramPanelId(REF)).toBe("default/sqladmin/public.orders::diagram");
        expect(relationDependencyPanelId(REF)).toBe("default/sqladmin/public.orders::dependencies");
        expect(relationInheritancePanelId(REF)).toBe("default/sqladmin/public.orders::inheritance");

        const ids = [
            panelId(REF), structurePanelId(REF), definitionPanelId(REF), sequenceInfoPanelId(REF),
            indexInfoPanelId(REF), typeInfoPanelId(REF), relationDiagramPanelId(REF),
            relationDependencyPanelId(REF), relationInheritancePanelId(REF),
        ];
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("case 2: functionDefinitionPanelId disambiguates overloads by signature", () => {
        const withSig = functionDefinitionPanelId({ ...REF, name: "total_orders", signature: "integer" });
        const withoutSig = functionDefinitionPanelId({ ...REF, name: "total_orders", signature: undefined });

        expect(withSig).toBe("default/sqladmin/public.total_orders(integer)::function");
        expect(withoutSig).toBe("default/sqladmin/public.total_orders()::function");
        expect(withSig).not.toBe(withoutSig);
    });

    it("case 3: schema- and database-scoped ids omit the object segment", () => {
        const schemaRef: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", kind: "schema" };

        expect(diagramPanelId(schemaRef)).toBe("default/sqladmin/public::diagram");
        expect(dependencyPanelId(schemaRef)).toBe("default/sqladmin/public::dependencies");
        expect(inheritancePanelId(schemaRef)).toBe("default/sqladmin/public::inheritance");

        const dbRef: DbObjectRef = { connectionId: "default", database: "sqladmin", kind: "database" };
        expect(databaseDiagramPanelId(dbRef)).toBe("default/sqladmin::db-diagram");
    });

    it("case 4: the four connection-scoped role/notes ids are distinct", () => {
        const ids = [
            notesPanelId("default"),
            roleGrantsPanelId("default", "alice"),
            roleGrantsDiagramPanelId("default", "alice"),
            roleMembershipDiagramPanelId("default", "alice"),
        ];

        expect(ids).toEqual([
            "notes/default",
            "grants/default/alice",
            "roles/default/alice::grants-diagram",
            "roles/default/alice::membership",
        ]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("case 5: ddlPanelId for a schema-only ref, and for a named object with a multi-word slug", () => {
        const schemaRef: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", kind: "schema" };

        expect(ddlPanelId(schemaRef, "table")).toBe("default/sqladmin/public/::ddl-table");
        expect(ddlPanelId({ ...schemaRef, name: "addr" }, "composite-type")).toBe("default/sqladmin/public/addr::ddl-composite-type");
    });

    it("case 6: refs differing only in database produce different panelIds", () => {
        expect(panelId(REF)).not.toBe(panelId({ ...REF, database: "otherdb" }));
    });
});

describe("panelIdsFor (cases 7-9)", () => {
    it("case 7: a relation ref returns exactly the ten object-scoped ids, in order", () => {
        expect(panelIdsFor(REF)).toEqual([
            panelId(REF), structurePanelId(REF), definitionPanelId(REF),
            sequenceInfoPanelId(REF), indexInfoPanelId(REF), typeInfoPanelId(REF),
            functionDefinitionPanelId(REF),
            relationDiagramPanelId(REF), relationDependencyPanelId(REF), relationInheritancePanelId(REF),
        ]);
    });

    it("case 8: a schema ref returns exactly its three ids, a database ref exactly one", () => {
        const schemaRef: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", kind: "schema" };
        const dbRef: DbObjectRef = { connectionId: "default", database: "sqladmin", kind: "database" };

        expect(panelIdsFor(schemaRef)).toEqual([diagramPanelId(schemaRef), dependencyPanelId(schemaRef), inheritancePanelId(schemaRef)]);
        expect(panelIdsFor(dbRef)).toEqual([databaseDiagramPanelId(dbRef)]);
    });

    it("case 9: every returned id is distinct across every kind", () => {
        const schemaRef: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", kind: "schema" };
        const dbRef: DbObjectRef = { connectionId: "default", database: "sqladmin", kind: "database" };

        const all = [...panelIdsFor(REF), ...panelIdsFor(schemaRef), ...panelIdsFor(dbRef)];
        expect(new Set(all).size).toBe(all.length);
    });
});

describe("panelTooltip, elideName, errorMessage, detailOf (cases 10-14)", () => {
    it("case 10: panelTooltip orders name/type/schema/database", () => {
        expect(panelTooltip(REF, "Table")).toBe("orders\n\nType: Table\nSchema: public\nDatabase: sqladmin");
    });

    it("case 11: elideName passes a 40-char name through and elides a 41-char one, shedding a trailing space first", () => {
        const exact = "a".repeat(40);
        const over = "a".repeat(39) + " b"; // 41 chars; slice(0, 39) is all "a"s, no space to shed
        // 41 chars whose 39th character (slice(0, 39)'s last char) is itself a space.
        const overWithTrailingSpace = `${"a".repeat(38)} xx`;

        expect(elideName(exact)).toBe(exact);
        expect(elideName(over)).toBe(`${"a".repeat(39)}…`);
        expect(elideName(overWithTrailingSpace)).toBe(`${"a".repeat(38)}…`);
        expect(elideName(overWithTrailingSpace)).not.toContain(" …");
    });

    it("case 12: errorMessage prefers body detail, then message, then String(error)", () => {
        expect(errorMessage({ body: { detail: "relation does not exist" } })).toBe("relation does not exist");
        expect(errorMessage({ body: { detail: [{ msg: "a" }, { msg: "b" }] } })).toBe("a; b");
        expect(errorMessage({ body: {}, message: "network down" })).toBe("network down");
        expect(errorMessage(new Error("boom"))).toBe("boom");
        expect(errorMessage("plain")).toBe("plain");
        expect(errorMessage(null)).toBe("null");
    });

    it("case 13: detailOf's null/string/array/unusable-shape handling", () => {
        expect(detailOf(null)).toBeNull();
        expect(detailOf(undefined)).toBeNull();
        expect(detailOf("a string")).toBeNull();
        expect(detailOf(42)).toBeNull();
        expect(detailOf({ detail: 42 })).toBeNull();
        expect(detailOf({ detail: "x" })).toBe("x");
        expect(detailOf({ detail: [{ msg: "a" }, "raw", { msg: "b" }] })).toBe("a; raw; b");
    });

    it("case 14: an unusable detail falls through to message rather than stringifying it", () => {
        expect(errorMessage({ body: { detail: 42 }, message: "fallback" })).toBe("fallback");
    });
});

describe("tableExportFilename", () => {
    it("joins schema and name with the format extension", () => {
        expect(tableExportFilename(REF, "csv")).toBe("public.orders.csv");
        expect(tableExportFilename(REF, "json")).toBe("public.orders.json");
    });

    it("falls back to a bare \"export\" stem when schema and name are both absent", () => {
        const dbRef: DbObjectRef = { connectionId: "default", database: "sqladmin", kind: "database" };

        expect(tableExportFilename(dbRef, "csv")).toBe("export.csv");
    });
});
