// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock } from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent } from "@jimka/typescript-ui/overlay";
import { StatusBar } from "@jimka/typescript-ui/component/container";
import type { Tree, TreeNode } from "@jimka/typescript-ui/component/tree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef } from "./contract";
import { getColumns } from "./data/api";
import { buildModel } from "./data/buildModel";
import { buildStore } from "./data/stores";
import { TableWorkPanel } from "./dock/TableWorkPanel";
import { StructurePanel } from "./dock/StructurePanel";

/** Registry entry for one open dock panel; `store` is absent for structure tabs. */
interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode;
    store?: AjaxStore;
}

export class SqlAdminController {
    readonly dock: Dock;
    readonly statusBar: StatusBar;

    private readonly _connectionId: string;
    private readonly _openPanels: Map<string, OpenPanel> = new Map();
    private _navigator: Tree | null = null;

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

        // Switching tabs syncs the navigator selection and the status bar to the
        // now-active panel. A null payload means no panel is focused.
        this.dock.on("focus", (e: DockPanelEvent | null) => {
            if (e) {
                this.syncToPanel(e.id);
            }
        });

        this.statusBar.setMessage(`Connection: ${connectionId}`);
    }

    get connectionId(): string {
        return this._connectionId;
    }

    /** Register the navigator tree so the focused tab can drive its selection. */
    setNavigator(tree: Tree): void {
        this._navigator = tree;
    }

    /** Open a table in the Dock (deduping by panel id), wiring its store errors. */
    async openTable(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.panelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let store: AjaxStore;
        let columns: ColumnMeta[];

        try {
            columns = await getColumns(ref);
            store = buildStore(ref, buildModel(columns), columns);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));
        store.on("sync", (e: StoreSyncEvent) => e.failures.forEach((f: StoreExceptionEvent) => this.notifyError(f.error, ref)));
        this._openPanels.set(id, { ref, node, store });

        // addPanel activates the newly opened panel; no explicit focus needed.
        this.dock.addPanel({ id, title: ref.name ?? id, content: TableWorkPanel(store, columns) });

        try {
            await store.load();
            this.syncToPanel(id);
        } catch {
            // load() rethrows, but the 'exception' listener already surfaced it.
        }
    }

    /** Open a read-only structure (column metadata) tab for a table/view. */
    async openStructure(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.structurePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let columns: ColumnMeta[];

        try {
            columns = await getColumns(ref);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        this._openPanels.set(id, { ref, node });
        this.dock.addPanel({ id, title: `${ref.name ?? id} (structure)`, content: StructurePanel(columns) });
        this.syncToPanel(id);
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

    /** Stable id for a table's structure tab, distinct from its data tab. */
    private structurePanelId(ref: DbObjectRef): string {
        return `${ref.schema}.${ref.name}::structure`;
    }

    /** Drop a closed panel's store from the registry. */
    private disposePanel(id: string): void {
        this._openPanels.delete(id);
    }

    /** Select the panel's navigator node and refresh the status bar to match. */
    private syncToPanel(id: string): void {
        const panel = this._openPanels.get(id);

        if (!panel) {
            return;
        }

        this._navigator?.selectNode(panel.node);
        this.updateStatusFor(panel);
    }

    /** Status line for a panel: row count for a data tab, else a structure label. */
    private updateStatusFor(panel: OpenPanel): void {
        if (panel.store) {
            const count = panel.store.getTotalCount() ?? panel.store.getRecords().length;
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: ${count} rows`);
        } else {
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: structure`);
        }
    }

    /** Prefer an AjaxError's parsed {detail}; fall back to a message or string. */
    private errorMessage(error: unknown): string {
        const e = error as { body?: unknown; message?: unknown };
        const detail = this.detailOf(e?.body);

        if (detail) {
            return detail;
        }

        if (typeof e?.message === "string" && e.message) {
            return e.message;
        }

        return String(error);
    }

    /**
     * Extract a readable message from a backend error body. A domain error's
     * `detail` is a string; a FastAPI validation error's `detail` is an array of
     * `{msg, ...}` entries, which are joined.
     */
    private detailOf(body: unknown): string | null {
        if (!body || typeof body !== "object") {
            return null;
        }

        const detail = (body as { detail?: unknown }).detail;

        if (typeof detail === "string") {
            return detail;
        }

        if (Array.isArray(detail)) {
            return detail
                .map(d => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
                .join("; ");
        }

        return null;
    }
}
