// Every panel opener for a single database object — table/view data,
// structure, definition, sequence, index, and standalone-type info — split
// out of SqlAdminController.ts. Also owns the reveal-then-open wiring for a
// foreign key's referenced table and a structure tab's owner links, since
// those reveals decide what to open here.

import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef, FunctionDefinition } from "../contract";
import { getColumns, getTablePrivileges, getViewDefinition, getStructure, getSequenceDetail, getIndexDetail, getTypeDefinition, getFunctionDefinition, getRoles, executeDdl, previewAlterSequence, previewAlterTable, previewCreateView, previewReplaceMatview, previewSequenceOwner, tableExportUrl } from "../data/api";
import { downloadUrl } from "../data/download";
import { buildModel } from "../data/buildModel";
import { buildStore } from "../data/stores";
import { buildSelectSql } from "../data/sql";
import { TableWorkPanel } from "../dock/TableWorkPanel";
import type { TableViewOptions, Notify } from "../dock/TableWorkPanel";
import { openImportRowsDialog } from "../dock/ImportRowsDialog";
import { StructurePanel } from "../dock/StructurePanel";
import type { StructureActions, StructureRefresh } from "../dock/StructurePanel";
import { stripTrailingSemicolon } from "../dock/ddlSpecs";
import { DefinitionPanel } from "../dock/DefinitionPanel";
import { FunctionDefinitionPanel } from "../dock/FunctionDefinitionPanel";
import { SequenceInfoPanel } from "../dock/SequenceInfoPanel";
import { IndexInfoPanel } from "../dock/IndexInfoPanel";
import { TypeInfoPanel } from "../dock/TypeInfoPanel";
import { objectPath } from "../shell/routeTargets";
import type { PanelRoute } from "../shell/routeTargets";
import { KIND_GLYPH } from "../navigator/objectGlyphs";
import { matchesObject, matchesRelationName } from "../navigator/revealMatch";
import { panelId, structurePanelId, definitionPanelId, sequenceInfoPanelId, indexInfoPanelId, typeInfoPanelId, functionDefinitionPanelId, tableExportFilename, errorMessage } from "./controllerText";
import type { PanelHost } from "./panelHost";
import type { RevealCoordinator } from "./revealCoordinator";
import type { DdlLaunchers } from "./ddlLaunchers";
import type { QueryWorkspace } from "./queryWorkspace";

export class ObjectPanels {
    private readonly host: PanelHost;
    private readonly reveal: RevealCoordinator;
    private readonly ddl: DdlLaunchers;
    private readonly workspace: QueryWorkspace;

    constructor(host: PanelHost, reveal: RevealCoordinator, ddl: DdlLaunchers, workspace: QueryWorkspace) {
        this.host      = host;
        this.reveal    = reveal;
        this.ddl       = ddl;
        this.workspace = workspace;
    }

    /**
     * Open a relation in the Dock. A table opens the editable TableWorkPanel
     * (deduped by panel id). A view/matview is read-only and has no CRUD
     * surface, so it opens as an auto-run browse query — `SELECT * FROM …
     * LIMIT n` on the shared QueryPanel — instead; its structure/definition
     * still open as their own tabs from the navigator's menu.
     *
     * `node` is optional (an FK-referenced table may have none currently
     * loaded, so the tab still opens but the focus-sync skips the reveal) and
     * may be a still-pending `Promise` (see `openReferencedTable`) — awaited
     * alongside the table's own fetch rather than gating it.
     *
     * @param view - The view-mode properties a route can request (record view,
     *   a focused record). Ignored on the view/matview branch, which opens a
     *   query tab instead of a `TableWorkPanel`.
     */
    async openTable(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>, view?: TableViewOptions): Promise<void> {
        // No editable data surface, so this opens as an auto-run browse query
        // instead of a dedicated data panel; the seed carries buildSelectSql's
        // small preview LIMIT. Each open mints a fresh query tab (no dedup,
        // like every query panel), still recorded in recent tables.
        if (ref.kind === "view" || ref.kind === "materializedView") {
            // Not awaited: remembering the table has no bearing on the query tab
            // that follows, and a pending reveal must not delay it.
            void Promise.resolve(node).then(resolved => { if (resolved) { this.workspace.rememberTable(ref, resolved); } });

            this.workspace.openQuery(buildSelectSql(ref), true, ref.name);

            return;
        }

        const id = panelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        // The address-bar route captured at open time — a one-shot snapshot
        // (record/rotated flags only), not kept live as the tab's view changes.
        const query: Record<string, string> = {};

        if (view?.rotated) { query.rotated = "true"; }
        if (view?.record)  { query.record  = view.record; }

        const built = objectPath(ref);
        const route: PanelRoute | undefined = built ? { path: built.path, query: Object.keys(query).length > 0 ? query : undefined } : undefined;

        this.host.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : KIND_GLYPH[ref.kind],
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // Runs behind the spinner; a throw here closes the tab and reaches
            // the "exception" handler. Independent requests run concurrently;
            // a pending `node` reveal rides along rather than gating any of it.
            const [columns, privileges, resolvedNode] = await Promise.all([
                this.host.fetchColumns(ref), getTablePrivileges(ref), Promise.resolve(node),
            ]);
            const store = buildStore(ref, buildModel(columns), columns);

            store.on("exception", (e: StoreExceptionEvent) => this.host.notifyError(e.error, ref));
            store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));

            this.host.registerPanel(id, { ref, node: resolvedNode ?? null, store, columns });

            if (resolvedNode) {
                this.workspace.rememberTable(ref, resolvedNode);
            }

            const notify = (message: string): void => { this.host.status(`${ref.name}: ${message}`); };
            const panel = new TableWorkPanel(
                store, columns, notify,
                format => downloadUrl(tableExportUrl(ref, format), tableExportFilename(ref, format)),
                () => this.importIntoTable(ref, store, columns, notify), privileges, view,
            );

            // Not awaited: the panel's own store-driven spinner covers the row
            // load, and a rejection is already surfaced by the listener above.
            void store.load().then(() => this.host.syncToPanel(id)).catch(() => {});

            return panel;
        });
    }

    /**
     * Open a read-only structure (column metadata) tab for a table/view.
     *
     * `node` may be a still-pending `Promise` — an in-progress navigator reveal
     * (see `openReferencedStructure`) — awaited alongside the structure fetch
     * rather than gating the tab.
     */
    async openStructure(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = structurePanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "structure") ?? undefined;

        this.host.openAsyncPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            glyph  : "table-columns",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // Runs behind the spinner; a pending `node` reveal rides along
            // rather than gating the fetch.
            const [columns, structure, resolvedNode] = await Promise.all([
                getColumns(ref), getStructure(ref), Promise.resolve(node),
            ]);

            // Read by `refresh`/the section refreshes only after a click, always
            // after this is assigned — every opener's `panel` follows this shape.
            let panel: StructurePanel;

            // The whole-tab refresh backs Alt+R / View → Refresh: re-fetches
            // everything and reseeds all four sections via `panel.reload`.
            const refresh = (): void => void this.refreshPanel(ref, async () => {
                const [freshColumns, freshStructure] = await Promise.all([getColumns(ref), getStructure(ref)]);
                const entry = this.host.panelEntry(id);

                panel.reload(freshColumns, freshStructure);

                // DdlLaunchers.structureColumns reads this cache for the
                // constraint/index dialogs' column checklists.
                if (entry) {
                    entry.columns = freshColumns;
                }
            });

            // The four per-section refreshes back each section header's own
            // Refresh tool. Indexes/Constraints/Foreign Keys all read the
            // same getStructure(ref) endpoint but reseed only their own
            // section, so one section's Refresh never touches the others.
            const refreshColumns = (): void => void this.refreshPanel(ref, async () => {
                const freshColumns = await getColumns(ref);
                const entry = this.host.panelEntry(id);

                panel.reloadColumns(freshColumns);

                if (entry) {
                    entry.columns = freshColumns;
                }
            });

            const refreshIndexes = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadIndexes((await getStructure(ref)).indexes);
            });

            const refreshConstraints = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadConstraints((await getStructure(ref)).constraints);
            });

            const refreshForeignKeys = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadForeignKeys((await getStructure(ref)).foreignKeys);
            });

            const sectionRefresh: StructureRefresh = {
                onRefreshColumns:     refreshColumns,
                onRefreshIndexes:     refreshIndexes,
                onRefreshConstraints: refreshConstraints,
                onRefreshForeignKeys: refreshForeignKeys,
            };

            // The Columns section's Save success callback: the data tab's
            // Model is now stale, so it closes first — then the whole-tab
            // `refresh` reseeds every section in place.
            const onColumnsSaved = (): void => {
                this.host.dock.removePanel(panelId(ref));
                refresh();
            };

            this.host.registerPanel(id, { ref, node: resolvedNode ?? null, columns, detail: "structure", refresh });
            this.host.syncToPanel(id);

            panel = new StructurePanel(columns, structure, (refSchema, refTable) =>
                this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : refSchema,
                    name        : refTable,
                    kind        : "table",
                }), (seqSchema, seqName) => this.openReferencedSequence({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : seqSchema,
                    name        : seqName,
                    kind        : "sequence",
                }), sectionRefresh, this.host.layout.bindAccordion("structure"), this.structureActionsFor(ref, onColumnsSaved));

            return panel;
        });
    }

    /**
     * Open an editable definition tab for a view/matview — its Columns grid
     * above its SQL definition (pg_get_viewdef, the SELECT body only),
     * deduping by definition-panel id. The definition/columns fetch behind
     * the spinner and feed a `DefinitionPanel` whose `onSave` builds and
     * executes the edit directly, no intermediate dialog: `CREATE OR REPLACE
     * VIEW` for a view, or the atomic DROP+CREATE replace pair for a
     * materialized view (Postgres has no CREATE OR REPLACE MATERIALIZED
     * VIEW). On success the tab reseeds itself via `panel.reload` rather than
     * closing. A failed fetch closes the tab, reported through notifyError; a
     * failed save leaves the tab (and the edits) open. Tables have no
     * definition, so the navigator only offers this for views.
     */
    async openDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = definitionPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "definition") ?? undefined;

        this.host.openAsyncPanel({
            id,
            title  : `${ref.name ?? id} (definition)`,
            glyph  : "file-code",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const [definition, columns] = await this.fetchDefinitionAndColumns(ref);

            // Read by `onSave` only after a Save click, always after this is assigned.
            let panel: DefinitionPanel;

            const onSave = async (newDefinition: string): Promise<void> => {
                // getViewDefinition's output always ends with a semicolon;
                // the create/replace specs' `select` expects a bare body.
                const select = stripTrailingSemicolon(newDefinition);

                try {
                    // cascade is hardcoded false: this tab has no CASCADE
                    // toggle, so a matview with dependents can't be edited
                    // here — the DROP half fails with a dependency error,
                    // reported below, leaving the matview and tab untouched.
                    const sql = ref.kind === "materializedView"
                        ? (await previewReplaceMatview(ref, {
                            schema: ref.schema!, name: ref.name!, select, cascade: false, withData: true,
                        })).sql
                        : (await previewCreateView(ref, {
                            schema: ref.schema!, name: ref.name!, select, orReplace: true,
                        })).sql;

                    await executeDdl(this.host.connectionId, sql);
                } catch (err) {
                    this.host.notifyError(err, ref);

                    return;
                }

                this.reveal.refreshNavigator();

                try {
                    const [reloadedDefinition, reloadedColumns] = await this.fetchDefinitionAndColumns(ref);

                    panel.reload(reloadedDefinition, reloadedColumns);
                } catch (err) {
                    // The save itself already succeeded — only the post-save
                    // re-fetch failed, so say so explicitly rather than
                    // inviting a retry that re-runs the DDL a second time.
                    this.host.notifyError(new Error(`saved, but failed to refresh the tab: ${errorMessage(err)}`), ref);

                    return;
                }

                this.host.status(`${ref.name}: definition saved`);
            };

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                const [freshDefinition, freshColumns] = await this.fetchDefinitionAndColumns(ref);

                panel.reload(freshDefinition, freshColumns);
            });

            panel = new DefinitionPanel(definition, columns, onSave, refresh, this.host.layout.bindSplit("definition"));

            // No `columns` field here: unlike the structure tab, the
            // definition tab's columns are only ever read by the panel
            // itself — nothing looks this entry up by definitionPanelId.
            this.host.registerPanel(id, { ref, node: node ?? null, detail: "definition", refresh });
            this.host.syncToPanel(id);

            return panel.content;
        });
    }

    /**
     * Open an editable info tab for a sequence — its current value and
     * parameters, deduping by sequence-info-panel id. The detail and the
     * connection's role names (for the form's Owner combo) fetch in parallel
     * behind the spinner and feed a SequenceInfoPanel wired with the
     * alter/owner preview/execute/reload callbacks its Save flow needs. A
     * failed detail fetch closes the tab; a failed roles fetch degrades
     * gracefully instead (`roles: []`).
     *
     * `node` may be a still-pending `Promise` (see `openReferencedSequence`),
     * awaited alongside the detail/roles fetch rather than gating the tab.
     */
    async openSequence(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = sequenceInfoPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref) ?? undefined;

        this.host.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "arrow-up-1-9",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const [[detailResult, rolesResult], resolvedNode] = await Promise.all([
                Promise.allSettled([getSequenceDetail(ref), getRoles(ref.connectionId)]),
                Promise.resolve(node),
            ]);

            if (detailResult.status === "rejected") {
                throw detailResult.reason;
            }

            const detail = detailResult.value;
            const roles  = rolesResult.status === "fulfilled" ? rolesResult.value.map(r => r.name) : [];

            let panel: SequenceInfoPanel;

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload(await getSequenceDetail(ref));
            });

            this.host.registerPanel(id, { ref, node: resolvedNode ?? null, detail: "info", refresh });
            this.host.syncToPanel(id);

            panel = new SequenceInfoPanel(detail, {
                schema:       ref.schema!,
                name:         ref.name!,
                roles,
                previewAlter: spec => previewAlterSequence(ref, spec),
                previewOwner: spec => previewSequenceOwner(ref, spec),
                execute:      sql => executeDdl(this.host.connectionId, sql),
                reloadDetail: () => getSequenceDetail(ref),
                onStatus:     m => this.host.status(`${m}`),
                onError:      m => this.host.notifyError(new Error(m), ref),
                onRefresh:    refresh,
                onOpenOwner:  (schema, table) => this.openReferencedStructure({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
            });

            return panel;
        });
    }

    /**
     * Open a read-only info tab for an index — its owning table,
     * unique/primary flags, and full CREATE INDEX text, deduping by
     * index-info-panel id. The detail is fetched fresh behind the spinner and
     * passed to an IndexInfoPanel wired with the "open table" callback. A
     * failed fetch closes the tab, reported through notifyError.
     *
     * `node` may be a still-pending `Promise` — an in-progress navigator
     * reveal — awaited alongside the detail fetch rather than gating the tab.
     */
    async openIndex(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = indexInfoPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref) ?? undefined;

        this.host.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "magnifying-glass",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const [detail, resolvedNode] = await Promise.all([getIndexDetail(ref), Promise.resolve(node)]);

            let panel: IndexInfoPanel;

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload(await getIndexDetail(ref));
            });

            this.host.registerPanel(id, { ref, node: resolvedNode ?? null, detail: "info", refresh });
            this.host.syncToPanel(id);

            panel = new IndexInfoPanel(detail, {
                schema: ref.schema!,
                onOpenTable: (schema, table) => this.openReferencedStructure({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
                onRefresh: refresh,
            });

            return panel;
        });
    }

    /**
     * Open a read-only info tab for a standalone enum or composite type — its
     * category, owning role, and ordered labels/attributes — deduping by
     * type-info-panel id. The detail is fetched fresh (via the same
     * `getTypeDefinition` chain `DdlLaunchers.editType`'s prefill uses) and
     * passed to a TypeInfoPanel. A failed fetch closes the tab.
     *
     * Unlike openSequence/openIndex, `node` is a plain `TreeNode | undefined`:
     * nothing opens a type by reference, so there is no in-progress reveal
     * `Promise` to await here.
     */
    async openType(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = typeInfoPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref) ?? undefined;

        this.host.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "cube",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const detail = await getTypeDefinition(ref);

            let panel: TypeInfoPanel;

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload(await getTypeDefinition(ref));
            });

            this.host.registerPanel(id, { ref, node: node ?? null, detail: "info", refresh });
            this.host.syncToPanel(id);

            panel = new TypeInfoPanel(detail, { schema: ref.schema!, name: ref.name!, onRefresh: refresh });

            return panel;
        });
    }

    /**
     * Open an editable definition tab for a function/procedure — the routine
     * counterpart to `openDefinition`, opened by double-click or "Show
     * definition". Fetches the routine's `pg_get_functiondef` text — already
     * a complete, executable `CREATE OR REPLACE FUNCTION|PROCEDURE …`
     * statement — and seeds a FunctionDefinitionPanel with it, deduping by
     * function-definition-panel id. Save hands the edited text straight to
     * `executeDdl` with no preview/wrapper: editing the argument list creates
     * a NEW overload rather than replacing this one, the stated manual
     * escape-hatch behaviour. On success the tab reseeds via `panel.reload`
     * rather than closing.
     *
     * @param ref - the function/procedure leaf to open (its `signature`
     *   disambiguates overloads).
     */
    async openFunctionDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = functionDefinitionPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const signature = ref.signature ?? "";
        const route = objectPath(ref) ?? undefined;

        this.host.openAsyncPanel({
            id,
            // Include the identity signature so two overloads of the same name
            // get visibly distinct tab titles (e.g. `total_orders()` vs
            // `total_orders(p_customer_id integer)`), matching their distinct ids.
            title  : `${ref.name ?? id}(${signature}) (definition)`,
            glyph  : "file-code",
            tooltip: this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const definition: FunctionDefinition = await getFunctionDefinition(ref, signature);

            let panel: FunctionDefinitionPanel;

            const onSave = async (newDefinition: string): Promise<void> => {
                try {
                    // No preview/builder: pg_get_functiondef is already the
                    // full statement, so the edited text runs as-is. An
                    // argument-list edit creates a NEW overload (the
                    // signature is part of identity), so the re-fetch below
                    // can then fail to find the original and report
                    // "saved, but failed to refresh" — expected for that case.
                    await executeDdl(this.host.connectionId, newDefinition);
                } catch (err) {
                    this.host.notifyError(err, ref);

                    return;
                }

                this.reveal.refreshNavigator();

                try {
                    const reloaded = await getFunctionDefinition(ref, signature);

                    panel.reload(reloaded.definition);
                } catch (err) {
                    // The save itself already succeeded — only the post-save
                    // re-fetch failed. Say so explicitly, mirroring openDefinition.
                    this.host.notifyError(new Error(`saved, but failed to refresh the tab: ${errorMessage(err)}`), ref);

                    return;
                }

                this.host.status(`${ref.name}: definition saved`);
            };

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload((await getFunctionDefinition(ref, signature)).definition);
            });

            panel = new FunctionDefinitionPanel(definition.definition, onSave, refresh);

            this.host.registerPanel(id, { ref, node: node ?? null, detail: "definition", refresh });
            this.host.syncToPanel(id);

            return panel.content;
        });
    }

    /**
     * Open a foreign key's referenced table in the Dock and reveal it in the
     * navigator. The reveal (expanding lazy branches as needed) can take a
     * moment, so it runs concurrently with the tab's own open rather than
     * gating it: the tab appears at once, with its content loading lazily
     * behind it, and the navigator selection lands whenever the reveal
     * resolves. Best-effort: if no node matches, the tab still opens.
     *
     * @param ref - The referenced table to open.
     */
    openReferencedTable(ref: DbObjectRef): void {
        this.reveal.revealInNavigator(matchesRelationName(ref), { open: r => void this.openTable(ref, r) });
    }

    /**
     * Open a table's Structure tab and reveal the table — the sequence info
     * tab's "Owned by column" link. Best-effort, mirroring {@link openReferencedTable}.
     */
    openReferencedStructure(ref: DbObjectRef): void {
        this.reveal.revealInNavigator(matchesObject(ref), { open: r => void this.openStructure(ref, r) });
    }

    /**
     * Open a column's backing sequence's info tab and reveal it — the
     * Structure tab's Sequence link. Best-effort, mirroring
     * {@link openReferencedTable}. Only `openStructure`'s sequence-owner link
     * calls this; every other sequence reveal goes through
     * {@link openReferencedTable} instead.
     */
    private openReferencedSequence(ref: DbObjectRef): void {
        this.reveal.revealInNavigator(matchesObject(ref), { open: r => void this.openSequence(ref, r) });
    }

    /**
     * Fetch a view/matview's definition and columns in parallel — shared by
     * `openDefinition`'s initial load and its Save-success reload.
     *
     * @param ref - The view/matview to fetch.
     * @returns A tuple of the definition SQL (the SELECT body only) and the columns.
     */
    private async fetchDefinitionAndColumns(ref: DbObjectRef): Promise<[string, ColumnMeta[]]> {
        const [definitionResult, columns] = await Promise.all([getViewDefinition(ref), getColumns(ref)]);

        return [definitionResult.definition, columns];
    }

    /**
     * Run one of the six detail tabs' Refresh: re-fetch and reseed via
     * `reload`, then report the outcome — the shared success/error wording
     * every Refresh button uses, so the six call sites don't drift apart.
     * Never rejects, so every call site may write `void this.refreshPanel(...)`.
     *
     * @param ref - The tab's own object, for the status message and a failed
     *   fetch's error label.
     * @param reload - The caller's fetch-and-reseed body; its own errors (a
     *   dropped/renamed object, a network failure) are caught here.
     */
    private async refreshPanel(ref: DbObjectRef, reload: () => Promise<void>): Promise<void> {
        try {
            await reload();
        } catch (err) {
            this.host.notifyError(new Error(`failed to refresh: ${errorMessage(err)}`), ref);

            return;
        }

        this.host.status(`${ref.name}: refreshed`);
    }

    /**
     * Build the StructureActions the structure tab's section toolbars call
     * into — one closure per action, fixed to this tab's own table ref.
     * `columnEdits` is narrower than the rest: a view/matview's Structure tab
     * must keep its Columns grid read-only.
     *
     * @param onColumnsSaved - Invoked after a successful Columns Save —
     *   closes the (now-stale) data tab and reseeds the structure tab in place.
     */
    private structureActionsFor(ref: DbObjectRef, onColumnsSaved: () => void): StructureActions {
        return {
            onAddConstraint:  kind => void this.ddl.addConstraint(ref, kind),
            onDropConstraint: constraintName => this.ddl.dropConstraint(ref, constraintName),
            onCreateIndex:    () => this.ddl.createIndex(ref),
            onDropIndex:      indexName => this.ddl.dropIndex(ref, indexName),
            columnEdits: ref.kind === "table" ? {
                schema:       ref.schema!,
                table:        ref.name!,
                previewAlter: spec => previewAlterTable(ref, spec),
                execute:      sql => executeDdl(this.host.connectionId, sql),
                onSaved:      onColumnsSaved,
                onError:      m => this.host.notifyError(new Error(m), ref),
                onStatus:     m => this.host.status(`${m}`),
            } : undefined,
        };
    }

    /**
     * Open the "Import data" dialog for a table: file pick -> preview ->
     * commit. On a successful commit, discards pending local edits, reloads
     * the grid from page 1 (mirroring the toolbar's own Refresh), and reports
     * the inserted count through the panel's shared status line.
     */
    private importIntoTable(ref: DbObjectRef, store: AjaxStore, columns: ColumnMeta[], notify: Notify): void {
        openImportRowsDialog({
            ref,
            columns,
            onImported: (insertedCount: number): void => {
                store.reject();
                void store.load();
                notify(`Imported ${insertedCount} row(s)`);
            },
        });
    }

    /** Report a sync outcome: each failure as an error, or a success message. */
    private reportSync(event: StoreSyncEvent, ref: DbObjectRef): void {
        if (event.failures.length > 0) {
            event.failures.forEach((f: StoreExceptionEvent) => this.host.notifyError(f.error, ref));

            return;
        }

        this.host.status(`${ref.name}: changes saved`);
    }
}
