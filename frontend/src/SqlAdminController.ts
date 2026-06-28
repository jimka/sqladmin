// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock } from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent } from "@jimka/typescript-ui/overlay";
import { StatusBar } from "@jimka/typescript-ui/component/container";
import { Table } from "@jimka/typescript-ui/component/table";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { DbObjectRef } from "./contract";
import { getColumns } from "./data/api";
import { buildModel } from "./data/buildModel";
import { buildStore } from "./data/stores";

export class SqlAdminController {
    readonly dock: Dock;
    readonly statusBar: StatusBar;

    private readonly _connectionId: string;
    private readonly _openPanels: Map<string, AjaxStore> = new Map();

    /**
     * @param connectionId - The connection these operations target (Phase 0-1: "default").
     */
    constructor(connectionId: string = "default") {
        this._connectionId = connectionId;
        this.dock = Dock();
        this.statusBar = new StatusBar();

        // Disposal is wired once: the dock fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives).
        this.dock.on("close", (e: DockPanelEvent) => this.disposePanel(e.id));

        this.statusBar.setMessage(`Connection: ${connectionId}`);
    }

    get connectionId(): string {
        return this._connectionId;
    }

    /** Open a table in the Dock (deduping by panel id), wiring its store errors. */
    async openTable(ref: DbObjectRef): Promise<void> {
        const id = this.panelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let store: AjaxStore;

        try {
            const columns = await getColumns(ref);
            store = buildStore(ref, buildModel(columns), columns);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));
        store.on("sync", (e: StoreSyncEvent) => e.failures.forEach((f: StoreExceptionEvent) => this.notifyError(f.error, ref)));
        this._openPanels.set(id, store);

        this.dock.addPanel({ id, title: ref.name ?? id, content: Table(store) });

        try {
            await store.load();
            this.setRowCount(ref, store);
        } catch {
            // load() rethrows, but the 'exception' listener already surfaced it.
        }
    }

    /** Surface an error (AjaxError detail, or any thrown value) to the StatusBar. */
    notifyError(error: unknown, ref?: DbObjectRef): void {
        const where = ref?.name ? ` (${ref.name})` : "";
        this.statusBar.setMessage(`Error${where}: ${this.errorMessage(error)}`);
    }

    /** Stable panel id so re-opening focuses the existing panel. */
    private panelId(ref: DbObjectRef): string {
        return `${ref.schema}.${ref.name}`;
    }

    /** Drop a closed panel's store from the registry. */
    private disposePanel(id: string): void {
        this._openPanels.delete(id);
    }

    private setRowCount(ref: DbObjectRef, store: AjaxStore): void {
        const count = store.getTotalCount() ?? store.getRecords().length;
        this.statusBar.setMessage(`${this._connectionId} · ${ref.name}: ${count} rows`);
    }

    /** Prefer an AjaxError's parsed {detail}; fall back to a message or string. */
    private errorMessage(error: unknown): string {
        const e = error as { body?: unknown; message?: unknown };

        if (e?.body && typeof e.body === "object" && e.body !== null && "detail" in e.body) {
            const detail = (e.body as { detail?: unknown }).detail;

            if (detail != null) {
                return String(detail);
            }
        }

        if (e?.message != null) {
            return String(e.message);
        }

        return String(error);
    }
}
