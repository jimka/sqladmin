// Pure row-mapping tests for the Properties inspector's selection→rows
// builder. DOM-free (no Table/Panel import happens here — see memory "tsui
// DOM module side effects").

import { describe, expect, it } from "vitest";
import { propertyRows } from "../../src/properties/propertyRows";
import type { ColumnMeta, DbObjectRef } from "../../src/contract";

function column(overrides: Partial<ColumnMeta> & { name: string }): ColumnMeta {
    return {
        dataType   : "integer",
        fullType   : "integer",
        nullable   : false,
        isPrimaryKey: false,
        isGenerated: false,
        hasDefault : false,
        defaultExpr: null,
        wireType   : "number",
        ...overrides,
    };
}

describe("propertyRows", () => {
    it("maps a database ref to its identity rows", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "shop", kind: "database" };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "shop" },
            { property: "Type", value: "Database" },
            { property: "Connection", value: "default" },
        ]);
    });

    it("maps a schema ref to its identity rows", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "shop", schema: "public", kind: "schema" };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Schema" },
        ]);
    });

    it("maps a table ref with no columns to identity rows only", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "orders", kind: "table",
        };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "orders" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Table" },
        ]);
    });

    it("maps a view ref's Type to 'View'", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "active_customers", kind: "view",
        };

        expect(propertyRows(ref)).toContainEqual({ property: "Type", value: "View" });
    });

    it("maps a materializedView ref's Type to 'Materialized view'", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "mv", kind: "materializedView",
        };

        expect(propertyRows(ref)).toContainEqual({ property: "Type", value: "Materialized view" });
    });

    it("maps a sequence ref to its identity rows", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "orders_id_seq", kind: "sequence",
        };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "orders_id_seq" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Sequence" },
        ]);
    });

    it("maps a function ref (not a procedure) with Type: Function and a Signature row", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "total_orders",
            kind: "function", signature: "p_customer_id integer",
        };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "total_orders" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Function" },
            { property: "Signature", value: "p_customer_id integer" },
        ]);
    });

    it("maps a function ref with isProcedure:true to Type: Procedure", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "do_thing",
            kind: "function", isProcedure: true, signature: "",
        };

        expect(propertyRows(ref)).toContainEqual({ property: "Type", value: "Procedure" });
    });

    it("maps a type ref to its identity rows", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "order_status", kind: "type",
        };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "order_status" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Type" },
        ]);
    });

    it("maps an index ref to its identity rows plus its owning Table", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "orders_pkey",
            kind: "index", table: "orders",
        };

        expect(propertyRows(ref)).toEqual([
            { property: "Name", value: "orders_pkey" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Index" },
            { property: "Table", value: "orders" },
        ]);
    });

    it("appends Columns and Primary key rows when a table's columns are passed", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "orders", kind: "table",
        };
        const columns = [
            column({ name: "id", isPrimaryKey: true }),
            column({ name: "customer_id" }),
        ];

        expect(propertyRows(ref, columns)).toEqual([
            { property: "Name", value: "orders" },
            { property: "Schema", value: "public" },
            { property: "Database", value: "shop" },
            { property: "Type", value: "Table" },
            { property: "Columns", value: "2" },
            { property: "Primary key", value: "id" },
        ]);
    });

    it("shows '—' for Primary key when no column is flagged", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "orders", kind: "table",
        };
        const columns = [column({ name: "id" }), column({ name: "customer_id" })];

        expect(propertyRows(ref, columns)).toContainEqual({ property: "Primary key", value: "—" });
    });

    it("joins a composite primary key's column names with ', '", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "shop", schema: "public", name: "order_items", kind: "table",
        };
        const columns = [
            column({ name: "order_id", isPrimaryKey: true }),
            column({ name: "line_no", isPrimaryKey: true }),
            column({ name: "sku" }),
        ];

        expect(propertyRows(ref, columns)).toContainEqual({ property: "Primary key", value: "order_id, line_no" });
    });
});
