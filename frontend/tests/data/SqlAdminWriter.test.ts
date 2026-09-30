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

// Model with temporal fields for the update-diff and temporal write-form cases.
// Dates are built with the local constructor and expected offsets derived from
// getTimezoneOffset(), so every case holds in any host time zone.
const temporalModel = new Model(
    [
        { name: "id" },
        { name: "name" },
        { name: "created_at" },
        { name: "ts", type: "datetime" },
        { name: "tstz", type: "datetime" },
        { name: "d", type: "date" },
    ],
    "id",
);

/** A fresh, unedited record of `temporalModel`. */
function temporalRecord(): ModelRecord {
    return new ModelRecord(temporalModel, { id: 1, name: "Ada", created_at: "2026-01-01", ts: null, tstz: null, d: null });
}

// Minutes per hour, for splitting getTimezoneOffset() into an ISO 8601 offset.
const MINUTES_PER_HOUR = 60;

// ISO 8601 writes an offset's hours and minutes as two digits each.
const ISO_OFFSET_FIELD_DIGITS = 2;

/**
 * The local ISO 8601 offset (`±HH:MM`) of `date`, derived from
 * `getTimezoneOffset()`, which is positive west of UTC.
 *
 * @param date - The date whose local offset to format.
 *
 * @returns The offset, `+00:00` at UTC, never `Z`.
 */
function localOffset(date: Date): string {
    const offset  = -date.getTimezoneOffset();
    const sign    = offset < 0 ? "-" : "+";
    const hours   = String(Math.floor(Math.abs(offset) / MINUTES_PER_HOUR)).padStart(ISO_OFFSET_FIELD_DIGITS, "0");
    const minutes = String(Math.abs(offset) % MINUTES_PER_HOUR).padStart(ISO_OFFSET_FIELD_DIGITS, "0");

    return `${sign}${hours}:${minutes}`;
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
            d: null,
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
        const second = new ModelRecord(temporalModel, { id: 2, name: "Alan", created_at: "2026-01-02", ts: null, tstz: null, d: null });

        first.set("name", "Grace");
        second.set("created_at", "2027-01-01");

        expect(JSON.parse(writer.writeRecords([first, second], "update"))).toEqual([
            { name: "Grace", id: 1 },
            { created_at: "2027-01-01", id: 2 },
        ]);
    });
});

describe("SqlAdminWriter temporal write forms", () => {
    it.each(["update", "create"] as const)("writes a date field as its bare local date on %s", operation => {
        const writer = new SqlAdminWriter(new Set());
        const record = temporalRecord();

        record.set("d", new Date(2026, 5, 28));

        expect(JSON.parse(writer.writeRecord(record, operation)).d).toBe("2026-06-28");
    });

    it.each(["update", "create"] as const)("writes a datetime field as local ISO 8601 with its offset on %s", operation => {
        const writer = new SqlAdminWriter(new Set());
        const record = temporalRecord();
        const moment = new Date(2026, 5, 28, 8, 0);

        record.set("ts", moment);

        const written: string = JSON.parse(writer.writeRecord(record, operation)).ts;

        expect(written).toBe(`2026-06-28T08:00:00.000${localOffset(moment)}`);
        expect(written).not.toMatch(/Z$/);
    });

    it("writes null in a zone-less column as null", () => {
        const writer = new SqlAdminWriter(new Set());

        expect(JSON.parse(writer.writeRecord(temporalRecord(), "create")).ts).toBeNull();
    });
});
