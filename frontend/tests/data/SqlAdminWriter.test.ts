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

// Model with temporal fields for the update-diff and wall-clock cases. Dates are
// built with the local constructor (or Date.UTC for toISOString comparisons), so
// every case holds in any host time zone.
const temporalModel = new Model(
    [{ name: "id" }, { name: "name" }, { name: "created_at" }, { name: "ts", type: "datetime" }, { name: "tstz", type: "datetime" }],
    "id",
);

/** A fresh, unedited record of `temporalModel`. */
function temporalRecord(): ModelRecord {
    return new ModelRecord(temporalModel, { id: 1, name: "Ada", created_at: "2026-01-01", ts: null, tstz: null });
}

describe("SqlAdminWriter operation-aware bodies", () => {
    it("an update sends only the changed fields plus the primary key", () => {
        const writer = new SqlAdminWriter(new Set());
        const record = temporalRecord();

        record.set("name", "Grace");

        expect(JSON.parse(writer.writeRecord(record, "update"))).toEqual({ name: "Grace", id: 1 });
    });

    it("an update of an unedited record sends only the primary key", () => {
        const writer = new SqlAdminWriter(new Set());

        expect(JSON.parse(writer.writeRecord(temporalRecord(), "update"))).toEqual({ id: 1 });
    });

    it("a create sends the full row minus generated columns", () => {
        const writer = new SqlAdminWriter(new Set(["created_at"]));

        expect(JSON.parse(writer.writeRecord(temporalRecord(), "create"))).toEqual({
            id: 1,
            name: "Ada",
            ts: null,
            tstz: null,
        });
    });

    it("an update still strips an edited generated column", () => {
        const writer = new SqlAdminWriter(new Set(["created_at"]));
        const record = temporalRecord();

        record.set("created_at", "2027-01-01");

        expect(JSON.parse(writer.writeRecord(record, "update"))).toEqual({ id: 1 });
    });

    it("writeRecords applies the update diff to each record", () => {
        const writer = new SqlAdminWriter(new Set());
        const first  = temporalRecord();
        const second = new ModelRecord(temporalModel, { id: 2, name: "Alan", created_at: "2026-01-02", ts: null, tstz: null });

        first.set("name", "Grace");
        second.set("created_at", "2027-01-01");

        expect(JSON.parse(writer.writeRecords([first, second], "update"))).toEqual([
            { name: "Grace", id: 1 },
            { created_at: "2027-01-01", id: 2 },
        ]);
    });
});

describe("SqlAdminWriter zone-less timestamp columns", () => {
    it("writes an edited zone-less timestamp as its local wall clock on update", () => {
        const writer = new SqlAdminWriter(new Set(), new Set(["ts"]));
        const record = temporalRecord();

        record.set("ts", new Date(2026, 5, 28, 8, 0));

        expect(JSON.parse(writer.writeRecord(record, "update"))).toEqual({ ts: "2026-06-28T08:00:00.000", id: 1 });
    });

    it("writes a zone-less timestamp as its local wall clock on create", () => {
        const writer = new SqlAdminWriter(new Set(), new Set(["ts"]));
        const record = temporalRecord();

        record.set("ts", new Date(2026, 5, 28, 8, 0));

        expect(JSON.parse(writer.writeRecord(record, "create")).ts).toBe("2026-06-28T08:00:00.000");
    });

    it("leaves a zone-aware timestamp as its UTC instant", () => {
        const writer = new SqlAdminWriter(new Set(), new Set(["ts"]));
        const record = temporalRecord();

        record.set("tstz", new Date(Date.UTC(2026, 5, 28, 12, 4)));

        expect(JSON.parse(writer.writeRecord(record, "update")).tstz).toBe("2026-06-28T12:04:00.000Z");
    });

    it.each([
        ["2026-06-28T08:00:00.000", new Date(2026, 5, 28, 8, 0)],
        ["2026-12-31T23:59:59.500", new Date(2026, 11, 31, 23, 59, 59, 500)],
        ["0999-01-01T09:05:07.045", new Date(999, 0, 1, 9, 5, 7, 45)],
    ])("writes the local wall clock %s", (expected, date) => {
        const writer = new SqlAdminWriter(new Set(), new Set(["ts"]));
        const record = temporalRecord();

        record.set("ts", date);

        expect(JSON.parse(writer.writeRecord(record, "update")).ts).toBe(expected);
    });

    it("writes null in a zone-less column as null", () => {
        const writer = new SqlAdminWriter(new Set(), new Set(["ts"]));

        expect(JSON.parse(writer.writeRecord(temporalRecord(), "create")).ts).toBeNull();
    });
});
