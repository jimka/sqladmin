import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FORM_CHANGE_DEBOUNCE_MS, SqlPreviewSync, sameSql } from "../../src/dock/sqlPreviewSync";
import type { RegenerateTrigger } from "../../src/dock/sqlPreviewSync";

/** One `generateSql` call the test settles by hand. */
interface PendingRequest {
    resolve: (sql: string) => void;
    reject: (err: unknown) => void;
}

/** A plain-variable editor plus spies on every host hook. */
interface Harness {
    sync: SqlPreviewSync;
    requests: PendingRequest[];
    generateSql: ReturnType<typeof vi.fn>;
    writeEditor: ReturnType<typeof vi.fn>;
    onGenerated: ReturnType<typeof vi.fn>;
    onFailed: ReturnType<typeof vi.fn>;
    getText: () => string;
    setText: (text: string) => void;
}

/**
 * Build a SqlPreviewSync over a `let text` editor whose `generateSql` calls
 * each return a promise the test settles through `requests`.
 *
 * @returns the sync, its pending requests, and the host spies.
 */
function makeHarness(): Harness {
    let text = "";
    const requests: PendingRequest[] = [];

    const generateSql = vi.fn((): Promise<string> => new Promise<string>((resolve, reject) => {
        requests.push({ resolve, reject });
    }));
    const writeEditor = vi.fn((sql: string): void => {
        text = sql;
    });
    const onGenerated = vi.fn((_trigger: RegenerateTrigger): void => undefined);
    const onFailed    = vi.fn((_err: unknown, _trigger: RegenerateTrigger): void => undefined);

    const sync = new SqlPreviewSync({
        generateSql,
        readEditor: () => text,
        writeEditor,
        onGenerated,
        onFailed,
    });

    return {
        sync,
        requests,
        generateSql,
        writeEditor,
        onGenerated,
        onFailed,
        getText: () => text,
        setText: (value: string) => {
            text = value;
        },
    };
}

/**
 * Open the harness with a successful `"open"` generation of `sql` (U1's state).
 *
 * @param h - the harness to open.
 * @param sql - the SQL the open request resolves with.
 */
async function openWith(h: Harness, sql: string): Promise<void> {
    const opened = h.sync.regenerate("open");

    h.requests[h.requests.length - 1].resolve(sql);
    await opened;
}

/**
 * Fire a debounced form change and let its request start.
 *
 * @param h - the harness whose form changed.
 * @returns the request the debounce started.
 */
function fireFormChange(h: Harness): PendingRequest {
    h.sync.formChanged();
    vi.advanceTimersByTime(FORM_CHANGE_DEBOUNCE_MS);

    return h.requests[h.requests.length - 1];
}

/** Let every already-settled promise continuation run. */
async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

describe("SqlPreviewSync", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("U1: applies a successful open generation and follows the form", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");

        expect(h.getText()).toBe("DROP TABLE t");
        expect(h.sync.followsForm()).toBe(true);
        expect(h.onGenerated).toHaveBeenCalledTimes(1);
        expect(h.onGenerated).toHaveBeenCalledWith("open");
    });

    it("U2: an open failure leaves the editor empty, reports, and vetoes settle", async () => {
        const h   = makeHarness();
        const err = new Error("needs a column");

        const opened = h.sync.regenerate("open");

        h.requests[0].reject(err);
        await opened;

        expect(h.getText()).toBe("");
        expect(h.onFailed).toHaveBeenCalledWith(err, "open");
        await expect(h.sync.settle()).resolves.toBe(false);
    });

    it("U3: debounces form changes to one generation 200 ms after the last", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();

        h.sync.formChanged();
        vi.advanceTimersByTime(50);
        h.sync.formChanged();
        vi.advanceTimersByTime(50);
        h.sync.formChanged();
        vi.advanceTimersByTime(FORM_CHANGE_DEBOUNCE_MS - 1);

        expect(h.generateSql).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);

        expect(h.generateSql).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1000);

        expect(h.generateSql).toHaveBeenCalledTimes(1);
    });

    it("U4: a hand-edited editor ignores form changes", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();
        h.setText("DROP TABLE t -- mine");

        h.sync.formChanged();
        vi.advanceTimersByTime(1000);

        expect(h.generateSql).not.toHaveBeenCalled();
        expect(h.getText()).toBe("DROP TABLE t -- mine");
        expect(h.sync.followsForm()).toBe(false);
    });

    it("U5: editing back to the generated text resumes following", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();
        h.setText("DROP TABLE t -- mine");
        h.sync.formChanged();
        vi.advanceTimersByTime(1000);

        h.setText("DROP TABLE t");

        expect(h.sync.followsForm()).toBe(true);

        h.sync.formChanged();
        vi.advanceTimersByTime(FORM_CHANGE_DEBOUNCE_MS);

        expect(h.generateSql).toHaveBeenCalledTimes(1);
    });

    it("U6: an edit made while a form-change request is in flight wins", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.onGenerated.mockClear();

        const request = fireFormChange(h);

        h.setText("MINE");
        request.resolve("X");
        await flush();

        expect(h.getText()).toBe("MINE");
        expect(h.onGenerated).not.toHaveBeenCalled();
    });

    it("U7: only the newest request's result is applied", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");

        const a = fireFormChange(h);
        const b = fireFormChange(h);

        b.resolve("B");
        await flush();
        a.resolve("A");
        await flush();

        expect(h.getText()).toBe("B");
    });

    it("U8: a form-change failure clears a following editor until a later success", async () => {
        const h   = makeHarness();
        const err = new Error("bad");

        await openWith(h, "DROP TABLE t");

        fireFormChange(h).reject(err);
        await flush();

        expect(h.getText()).toBe("");
        expect(h.onFailed).toHaveBeenCalledWith(err, "formChange");
        await expect(h.sync.settle()).resolves.toBe(false);

        fireFormChange(h).resolve("DROP TABLE t CASCADE");
        await flush();

        expect(h.getText()).toBe("DROP TABLE t CASCADE");
        await expect(h.sync.settle()).resolves.toBe(true);
    });

    it("U9: Regenerate replaces a hand edit", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.setText("MINE");

        const regenerated = h.sync.regenerate("button");

        h.requests[h.requests.length - 1].resolve("Y");
        await regenerated;

        expect(h.getText()).toBe("Y");
        expect(h.sync.followsForm()).toBe(true);
    });

    it("U10: a Regenerate failure keeps a hand edit and does not veto", async () => {
        const h   = makeHarness();
        const err = new Error("bad");

        await openWith(h, "DROP TABLE t");
        h.setText("MINE");

        const regenerated = h.sync.regenerate("button");

        h.requests[h.requests.length - 1].reject(err);
        await regenerated;

        expect(h.getText()).toBe("MINE");
        expect(h.onFailed).toHaveBeenCalledWith(err, "button");
        await expect(h.sync.settle()).resolves.toBe(true);
    });

    it("U11: settle flushes a pending debounce and awaits its request", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();

        h.sync.formChanged();

        const settled = h.sync.settle();

        expect(h.generateSql).toHaveBeenCalledTimes(1);

        let done = false;

        void settled.then(() => {
            done = true;
        });
        await Promise.resolve();

        expect(done).toBe(false);

        h.requests[h.requests.length - 1].resolve("DROP TABLE t CASCADE");

        await expect(settled).resolves.toBe(true);
        expect(h.getText()).toBe("DROP TABLE t CASCADE");
    });

    it("U12: settle with nothing pending resolves true without generating", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();

        await expect(h.sync.settle()).resolves.toBe(true);
        expect(h.generateSql).not.toHaveBeenCalled();
    });

    it("U13: dispose cancels a pending debounce and ignores in-flight results", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.generateSql.mockClear();
        h.writeEditor.mockClear();
        h.onGenerated.mockClear();

        h.sync.formChanged();
        h.sync.dispose();
        vi.advanceTimersByTime(1000);

        expect(h.generateSql).not.toHaveBeenCalled();

        const inFlight = makeHarness();

        await openWith(inFlight, "DROP TABLE t");
        inFlight.writeEditor.mockClear();
        inFlight.onGenerated.mockClear();

        const request = fireFormChange(inFlight);

        inFlight.sync.dispose();
        request.resolve("LATE");
        await flush();

        const failing = makeHarness();

        await openWith(failing, "DROP TABLE t");
        failing.writeEditor.mockClear();

        const failed = fireFormChange(failing);

        failing.sync.dispose();
        failed.reject(new Error("late"));
        await flush();

        expect(inFlight.writeEditor).not.toHaveBeenCalled();
        expect(inFlight.onGenerated).not.toHaveBeenCalled();
        expect(failing.writeEditor).not.toHaveBeenCalled();
        expect(failing.onFailed).not.toHaveBeenCalled();
    });

    it("settle waits for a request a form change starts while it is waiting", async () => {
        const h = makeHarness();

        await openWith(h, "RENAME TO a");

        h.sync.formChanged();

        const settled = h.sync.settle();
        const flushed = h.requests[h.requests.length - 1];

        let done = false;

        void settled.then(() => {
            done = true;
        });

        const later = fireFormChange(h);

        flushed.resolve("RENAME TO foo");
        await flush();

        expect(done).toBe(false);

        later.resolve("RENAME TO foox");

        await expect(settled).resolves.toBe(true);
        expect(h.getText()).toBe("RENAME TO foox");
    });

    it("settle flushes a debounce armed while it is waiting", async () => {
        const h = makeHarness();

        await openWith(h, "RENAME TO a");

        h.sync.formChanged();

        const settled = h.sync.settle();
        const flushed = h.requests[h.requests.length - 1];

        h.sync.formChanged();
        flushed.resolve("RENAME TO foo");
        await flush();

        expect(h.requests).toHaveLength(3);

        h.requests[2].resolve("RENAME TO foox");

        await expect(settled).resolves.toBe(true);
        expect(h.getText()).toBe("RENAME TO foox");
    });

    it("regenerates again when the form changed while a Regenerate request was in flight", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.setText("MINE");

        const regenerated = h.sync.regenerate("button");
        const buttonRequest = h.requests[h.requests.length - 1];

        // CASCADE ticked after the click: the button's request read the old form.
        h.sync.formChanged();

        // Execute clicked before the button's response lands.
        const settled = h.sync.settle();

        buttonRequest.resolve("DROP TABLE t");
        await regenerated;
        await flush();

        expect(h.requests).toHaveLength(3);

        h.requests[2].resolve("DROP TABLE t CASCADE");

        await expect(settled).resolves.toBe(true);
        expect(h.getText()).toBe("DROP TABLE t CASCADE");
        // Execute's sqlEdited is `!followsForm()`: the form describes what runs.
        expect(h.sync.followsForm()).toBe(true);
    });

    it("keeps a hand edit typed while a Regenerate request is in flight", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.setText("MINE");
        h.onGenerated.mockClear();

        const regenerated = h.sync.regenerate("button");

        h.setText("MINE, edited again");
        h.requests[h.requests.length - 1].resolve("Y");
        await regenerated;

        expect(h.getText()).toBe("MINE, edited again");
        expect(h.onGenerated).not.toHaveBeenCalled();
        expect(h.sync.followsForm()).toBe(false);
    });

    it("vetoes Execute when the dialog closes while settle is waiting", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");

        h.sync.formChanged();

        const settled = h.sync.settle();

        h.sync.dispose();
        h.requests[h.requests.length - 1].resolve("DROP TABLE t CASCADE");

        await expect(settled).resolves.toBe(false);
    });

    it("vetoes Execute once the sync is disposed", async () => {
        const h = makeHarness();

        await openWith(h, "DROP TABLE t");
        h.sync.dispose();

        await expect(h.sync.settle()).resolves.toBe(false);
    });

    it("U14: sameSql treats CRLF as LF but nothing else as equal", () => {
        expect(sameSql("a\r\nb", "a\nb")).toBe(true);
        expect(sameSql("a", "a ")).toBe(false);
    });

    it("U15: the baseline is updated before writeEditor runs", async () => {
        let text = "";
        let followedInsideWrite: boolean | null = null;
        let resolveSql: (sql: string) => void = () => undefined;

        const sync: SqlPreviewSync = new SqlPreviewSync({
            generateSql: () => new Promise<string>(resolve => {
                resolveSql = resolve;
            }),
            readEditor:  () => text,
            writeEditor: (sql: string) => {
                text = sql;
                followedInsideWrite = sync.followsForm();
            },
            onGenerated: () => undefined,
            onFailed:    () => undefined,
        });

        const opened = sync.regenerate("open");

        resolveSql("DROP TABLE t");
        await opened;

        expect(followedInsideWrite).toBe(true);
    });
});
