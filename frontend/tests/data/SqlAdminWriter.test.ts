import { describe, it, expect } from "vitest";
import { Model, ModelRecord } from "@jimka/typescript-ui/data";
import { SqlAdminWriter } from "../../src/data/SqlAdminWriter";

const model = new Model([{ name: "id" }, { name: "name" }, { name: "created_at" }], "id");

describe("SqlAdminWriter", () => {
    it("writeRecord strips a generated column from the written body", () => {
        const writer = new SqlAdminWriter(new Set(["created_at"]));
        const record = new ModelRecord(model, { id: 1, name: "Ada", created_at: "2026-01-01" });

        expect(JSON.parse(writer.writeRecord(record))).toEqual({ id: 1, name: "Ada" });
    });

    it("writeRecord with an empty generated set passes the data through unchanged", () => {
        const writer = new SqlAdminWriter(new Set());
        const record = new ModelRecord(model, { id: 1, name: "Ada", created_at: "2026-01-01" });

        expect(JSON.parse(writer.writeRecord(record))).toEqual({ id: 1, name: "Ada", created_at: "2026-01-01" });
    });

    it("writeRecords strips the generated column across every record in the array", () => {
        const writer  = new SqlAdminWriter(new Set(["created_at"]));
        const records = [
            new ModelRecord(model, { id: 1, name: "Ada", created_at: "2026-01-01" }),
            new ModelRecord(model, { id: 2, name: "Grace", created_at: "2026-01-02" }),
        ];

        expect(JSON.parse(writer.writeRecords(records))).toEqual([
            { id: 1, name: "Ada" },
            { id: 2, name: "Grace" },
        ]);
    });

    it("is a no-op when the generated set names no field the record has", () => {
        const writer = new SqlAdminWriter(new Set(["nonexistent_column"]));
        const record = new ModelRecord(model, { id: 1, name: "Ada", created_at: "2026-01-01" });

        expect(JSON.parse(writer.writeRecord(record))).toEqual({ id: 1, name: "Ada", created_at: "2026-01-01" });
    });
});
