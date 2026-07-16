import { describe, it, expect, vi } from "vitest";

// Mock the DOM-bound exporters so the item builders' action closures are
// testable in node vitest without pulling the library (or download()) in.
vi.mock("../../src/dock/exportQueryResult",  () => ({ exportQueryResult: vi.fn() }));
vi.mock("../../src/dock/exportExplainResult", () => ({ exportExplainPlan: vi.fn() }));

import {
    buildTableExportItems,
    buildQueryExportItems,
    buildAlterColumnItems,
    buildAddConstraintItems,
} from "../../src/dock/menuItems";
import { exportQueryResult }  from "../../src/dock/exportQueryResult";
import { exportExplainPlan }  from "../../src/dock/exportExplainResult";
import type { ActiveExport } from "../../src/data/explain";
import type { ColumnMeta, QueryRowsResult } from "../../src/contract";
import type { StructureActions } from "../../src/dock/StructurePanel";

const exportQueryResultMock  = vi.mocked(exportQueryResult);
const exportExplainPlanMock  = vi.mocked(exportExplainPlan);

const notify = vi.fn();

const column: ColumnMeta = {
    name: "id", dataType: "integer", nullable: false,
    isPrimaryKey: true, isGenerated: false, hasDefault: true, wireType: "number",
};

/** A minimal StructureActions with every callback a no-op spy. */
function structureActions(): StructureActions {
    return {
        onAddColumn:      vi.fn(),
        onAlterColumn:    vi.fn(),
        onDropColumn:     vi.fn(),
        onAddConstraint:  vi.fn(),
        onDropConstraint: vi.fn(),
        onCreateIndex:    vi.fn(),
        onDropIndex:      vi.fn(),
    };
}

describe("buildTableExportItems", () => {
    it("returns the CSV/JSON pair and wires each action to onExport", () => {
        const onExport = vi.fn();
        const items = buildTableExportItems(onExport);

        expect(items.map(i => i.text)).toEqual(["Export CSV (.csv)", "Export JSON (.json)"]);
        expect(items.map(i => i.glyph)).toEqual(["file-csv", "file-code"]);

        items[0].action?.();
        expect(onExport).toHaveBeenCalledWith("csv");

        items[1].action?.();
        expect(onExport).toHaveBeenCalledWith("json");
    });
});

describe("buildQueryExportItems", () => {
    it("returns no items when nothing is active, so the menu opens nothing", () => {
        expect(buildQueryExportItems(null, notify)).toEqual([]);
    });

    it("offers CSV/JSON for a rows result and every item is enabled", () => {
        const result: QueryRowsResult = { kind: "rows", columns: [], rows: [], rowCount: 0, truncated: false };
        const active: ActiveExport = { kind: "rows", result };
        const items = buildQueryExportItems(active, notify);

        expect(items.map(i => i.text)).toEqual(["Export CSV (.csv)", "Export JSON (.json)"]);
        expect(items.map(i => i.glyph)).toEqual(["file-csv", "file-code"]);
        expect(items.every(i => i.enabled !== false)).toBe(true);

        items[0].action?.();
        expect(exportQueryResultMock).toHaveBeenCalledWith(result, "csv", notify);

        items[1].action?.();
        expect(exportQueryResultMock).toHaveBeenCalledWith(result, "json", notify);
    });

    it("offers text/JSON for an explain plan and every item is enabled", () => {
        const plan = { result: { kind: "explain" as const, format: "text" as const, analyze: false, plan: "Seq Scan" }, sql: "SELECT 1", runExplain: vi.fn() };
        const active: ActiveExport = { kind: "plan", plan };
        const items = buildQueryExportItems(active, notify);

        expect(items.map(i => i.text)).toEqual(["Export text (.txt)", "Export JSON (.json)"]);
        expect(items.map(i => i.glyph)).toEqual(["file-lines", "file-code"]);
        expect(items.every(i => i.enabled !== false)).toBe(true);

        items[0].action?.();
        expect(exportExplainPlanMock).toHaveBeenCalledWith(plan, "txt", notify);

        items[1].action?.();
        expect(exportExplainPlanMock).toHaveBeenCalledWith(plan, "json", notify);
    });
});

describe("buildAlterColumnItems", () => {
    it("returns no items when no column is resolved, so the menu opens nothing", () => {
        expect(buildAlterColumnItems(undefined, structureActions())).toEqual([]);
    });

    it("returns the six alter actions in order and wires each by column identity", () => {
        const actions = structureActions();
        const items = buildAlterColumnItems(column, actions);

        expect(items.map(i => i.text)).toEqual([
            "Rename column…", "Change type…", "Set NOT NULL", "Drop NOT NULL", "Set default…", "Drop default",
        ]);

        items[2].action?.();
        expect(actions.onAlterColumn).toHaveBeenCalledWith(column, "setNotNull");
    });
});

describe("buildAddConstraintItems", () => {
    it("always returns the four constraint kinds in order", () => {
        const actions = structureActions();
        const items = buildAddConstraintItems(actions);

        expect(items.map(i => i.text)).toEqual(["Primary key…", "Unique…", "Check…", "Foreign key…"]);

        items[3].action?.();
        expect(actions.onAddConstraint).toHaveBeenCalledWith("foreignKey");
    });
});
