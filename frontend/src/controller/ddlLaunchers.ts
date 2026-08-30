// Every DDL launcher — create/rename/drop for tables, schemas, sequences,
// functions/procedures, and types, plus the Structure tab's Constraints/
// Indexes toolbar actions — split out of SqlAdminController.ts. Each is a
// ten-ish-line `openDdlPanel`/`openSqlPreviewDialog` call sharing one
// `ddlDefaults(ref)` spread and (for the schema-scoped creators)
// `fetchSchemaNames`'s preamble; what they share is this wiring, not the
// object kind, which is why they live together rather than beside the
// panel-opener their object kind also has (see the plan's Architecture
// Decisions).

import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { ColumnMeta, ConstraintKind, DbObjectRef, TypeDefinition } from "../contract";
import { executeDdl, getColumns, getSchemas, getTypeDefinition, previewAlterTable, previewAlterTypeAddValue, previewConstraint, previewCreateCompositeType, previewCreateEnumType, previewCreateFunction, previewCreateMatview, previewCreateSchema, previewCreateSequence, previewCreateTable, previewCreateView, previewDropFunction, previewDropMatview, previewDropSchema, previewDropSequence, previewDropTable, previewDropType, previewDropView, previewIndex, previewRefreshMatview, previewRenameSchema } from "../data/api";
import { openSqlPreviewDialog } from "../dock/SqlPreviewDialog";
import { DdlFormPanel } from "../dock/DdlFormPanel";
import type { DdlDraft, DdlExecuteDeps } from "../dock/DdlFormPanel";
import { CreateTableForm } from "../dock/CreateTableForm";
import { RenameTableForm } from "../dock/RenameTableForm";
import { ConstraintForm } from "../dock/ConstraintForm";
import { IndexForm } from "../dock/IndexForm";
import { ConfirmCascadeForm } from "../dock/ConfirmCascadeForm";
import { ViewForm } from "../dock/ViewForm";
import { MaterializedViewForm } from "../dock/MaterializedViewForm";
import { RefreshMatviewForm } from "../dock/RefreshMatviewForm";
import { buildDropSchemaSpec, buildRenameSchemaSpec, buildDropSequenceSpec, buildDropFunctionSpec, buildDropTypeSpec, buildConstraintSpec, buildIndexSpec } from "../dock/ddlSpecs";
import { CreateSchemaForm, RenameSchemaForm } from "../dock/SchemaDdlForms";
import { CreateSequenceForm } from "../dock/SequenceDdlForms";
import { FunctionForm } from "../dock/FunctionForm";
import { EnumTypeForm } from "../dock/EnumTypeForm";
import { CompositeTypeForm } from "../dock/CompositeTypeForm";
import { AddEnumValueForm } from "../dock/AddEnumValueForm";
import { KIND_GLYPH } from "../navigator/objectGlyphs";
import { structurePanelId, ddlPanelId } from "./controllerText";
import type { PanelHost } from "./panelHost";
import type { RevealCoordinator } from "./revealCoordinator";

export class DdlLaunchers {
    private readonly host: PanelHost;
    private readonly reveal: RevealCoordinator;

    constructor(host: PanelHost, reveal: RevealCoordinator) {
        this.host = host;
        this.reveal = reveal;
    }

    /**
     * Open (or focus) the CREATE TABLE draft tab for a schema (the
     * navigator's schema context-menu launcher). Success closes the tab and
     * refreshes the navigator, since a new table changes the schema's object list.
     */
    createTable(ref: DbObjectRef): void {
        this.openDdlPanel({
            ref,
            slug:        "table",
            title:       `New table (${ref.schema})`,
            glyph:       KIND_GLYPH.table,
            reviewTitle: "Create table",
            build:       () => {
                const form = new CreateTableForm(ref.schema!);

                return { form, generateSql: async () => (await previewCreateTable(ref, form.readSpec())).sql };
            },
        });
    }

    /** Open (or focus) the CREATE VIEW draft tab for a schema (the navigator's schema context-menu launcher). */
    async createView(ref: DbObjectRef): Promise<void> {
        await this.createRelationDraft(ref, "view");
    }

    /** Open (or focus) the CREATE MATERIALIZED VIEW draft tab for a schema. Mirrors {@link createView}. */
    async createMaterializedView(ref: DbObjectRef): Promise<void> {
        await this.createRelationDraft(ref, "materializedView");
    }

    /**
     * Open the CREATE SCHEMA dialog, launched from an existing schema node's
     * context menu — the navigator has no separate database node to
     * right-click (its top level IS the logged-in database's schemas; see
     * NavigatorTree's header comment and
     * plans/implemented/schema-sequence-ddl.md's drift notes). The new
     * schema is created in `ref`'s own database. Success refreshes the
     * navigator, since a new schema changes the database's top-level list.
     *
     * @param ref - the launching schema node (its database is the target).
     */
    createSchema(ref: DbObjectRef): void {
        // CREATE SCHEMA is database-scoped, but the launcher is a schema
        // node's context menu (see this module's header) — synthesizing the
        // database-level target here keys the draft tab on the database, not
        // the launching schema, so every schema node's "Create schema…"
        // focuses the same draft (see the plan's "database-scoped schema"
        // Architecture Decision).
        const target: DbObjectRef = { connectionId: ref.connectionId, database: ref.database, kind: "database" };

        this.openDdlPanel({
            ref:         target,
            slug:        "schema",
            title:       `New schema (${ref.database})`,
            glyph:       KIND_GLYPH.schema,
            reviewTitle: "Create schema",
            build:       () => {
                const form = new CreateSchemaForm();

                return { form, generateSql: async () => (await previewCreateSchema(target, form.readSpec())).sql };
            },
        });
    }

    /** Open the CREATE SEQUENCE dialog for a schema. Success refreshes the navigator. */
    createSequence(ref: DbObjectRef): void {
        this.openDdlPanel({
            ref,
            slug:        "sequence",
            title:       `New sequence (${ref.schema})`,
            glyph:       KIND_GLYPH.sequence,
            reviewTitle: "Create sequence",
            build:       () => {
                const form = new CreateSequenceForm(ref.schema!);

                return { form, generateSql: async () => (await previewCreateSequence(ref, form.readSpec())).sql };
            },
        });
    }

    /** Open (or focus) the CREATE FUNCTION/PROCEDURE draft tab for a schema. Success refreshes the navigator. */
    createFunction(ref: DbObjectRef): void {
        this.openDdlPanel({
            ref,
            slug:        "function",
            title:       `New function (${ref.schema})`,
            glyph:       KIND_GLYPH.function,
            reviewTitle: "Create function",
            build:       () => {
                const form = new FunctionForm({ schema: ref.schema! });

                return { form, generateSql: async () => (await previewCreateFunction(ref, form.readSpec())).sql };
            },
        });
    }

    /**
     * Open (or focus) the CREATE TYPE draft tab for a schema (the
     * navigator's "Create type ▸ Enum | Composite" context-menu submenu).
     * Success refreshes the navigator, since a new type changes the schema's
     * object list.
     *
     * @param category - which CREATE TYPE form to open.
     */
    createType(ref: DbObjectRef, category: "enum" | "composite"): void {
        if (category === "enum") {
            this.openDdlPanel({
                ref,
                slug:        "enum-type",
                title:       `New enum type (${ref.schema})`,
                glyph:       KIND_GLYPH.type,
                reviewTitle: "Create enum type",
                build:       () => {
                    const form = new EnumTypeForm({ schema: ref.schema! });

                    return { form, generateSql: async () => (await previewCreateEnumType(ref, form.readSpec())).sql };
                },
            });

            return;
        }

        this.openDdlPanel({
            ref,
            slug:        "composite-type",
            title:       `New composite type (${ref.schema})`,
            glyph:       KIND_GLYPH.type,
            reviewTitle: "Create composite type",
            build:       () => {
                const form = new CompositeTypeForm({ schema: ref.schema! });

                return {
                    form,
                    generateSql: async () => (await previewCreateCompositeType(ref, form.readSpec())).sql,
                };
            },
        });
    }

    /**
     * Open the edit flow for an existing type (the navigator's "Edit
     * type…" launcher). Introspects the type first, then routes on its
     * category: an enum offers `ALTER TYPE ... ADD VALUE` in a dialog
     * (append-only — Postgres has no `CREATE OR REPLACE TYPE`); a composite
     * opens a recreate/clone draft tab prefilled with its current attributes
     * (restructuring an existing composite in place is a stated Non-Goal —
     * see the function-type-ddl plan's "enum edits are append-only"
     * decision). The composite path's successful execute closes the tab and
     * refreshes the navigator (a new `CREATE TYPE` statement); an enum
     * `ADD VALUE` does not change the object list, so it only sets a status
     * message, mirroring `alterSequence`.
     */
    async editType(ref: DbObjectRef): Promise<void> {
        let definition: TypeDefinition;

        try {
            definition = await getTypeDefinition(ref);
        } catch (err) {
            this.host.notifyError(err, ref);

            return;
        }

        if (definition.category === "enum") {
            const form = new AddEnumValueForm({
                schema: ref.schema!, name: ref.name!, existingLabels: definition.labels,
            });

            openSqlPreviewDialog({
                title:       "Add enum value",
                form,
                generateSql: async () => (await previewAlterTypeAddValue(ref, form.readSpec())).sql,
                onSuccess:   () => this.host.status(`${ref.name}: altered`),
                ...this.ddlDefaults(ref),
            });

            return;
        }

        this.openDdlPanel({
            ref,
            slug:        "composite-type",
            title:       `Recreate ${ref.name} (composite type)`,
            glyph:       KIND_GLYPH.type,
            reviewTitle: "Edit composite type (recreate)",
            build:       () => {
                const form = new CompositeTypeForm({ schema: ref.schema!, prefill: definition.attributes });

                return {
                    form,
                    generateSql: async () => (await previewCreateCompositeType(ref, form.readSpec())).sql,
                };
            },
        });
    }

    /**
     * Open the RENAME TABLE dialog for a table (the navigator's table
     * context-menu launcher). Success refreshes the navigator (the object
     * list's display name changed) and closes every tab for the table's old
     * identity, since they are keyed by name.
     *
     * @param _node - The table's navigator node; accepted for call-site
     *   parity with the other table launchers but unused (see {@link dropTable}).
     */
    renameTable(ref: DbObjectRef, _node?: TreeNode): void {
        const form = new RenameTableForm(ref.schema!, ref.name!);

        openSqlPreviewDialog({
            title:       "Rename table",
            form,
            generateSql: async () => (await previewAlterTable(ref, form.readSpec())).sql,
            onSuccess:   () => {
                this.reveal.refreshNavigator();
                this.host.closeTabsFor(ref);
            },
            ...this.ddlDefaults(ref),
        });
    }

    /** Open the RENAME SCHEMA dialog for a schema. Success refreshes the navigator (the display name changed). */
    renameSchema(ref: DbObjectRef): void {
        const form = new RenameSchemaForm(ref.schema!);

        openSqlPreviewDialog({
            title: "Rename schema",
            form,
            generateSql: async () =>
                (await previewRenameSchema(ref, buildRenameSchemaSpec(ref.schema!, form.newName()))).sql,
            onSuccess: () => this.reveal.refreshNavigator(),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the REFRESH dialog for a materialized view. Success only sets a
     * status message — a refresh does not change the object list or the
     * matview's column set, so neither the navigator nor any open tab needs
     * rebuilding.
     */
    refreshMaterializedView(ref: DbObjectRef): void {
        const form = new RefreshMatviewForm();

        openSqlPreviewDialog({
            title: "Refresh materialized view",
            form,
            generateSql: async () => (await previewRefreshMatview(ref, {
                schema:       ref.schema!,
                name:         ref.name!,
                concurrently: form.concurrently(),
                withNoData:   form.withNoData(),
            })).sql,
            onSuccess: () => this.host.status(`${ref.name}: refreshed`),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP TABLE dialog for a table (the navigator's table
     * context-menu launcher). Success refreshes the navigator and closes
     * every tab for the now-gone table (data, structure, and every diagram
     * facet — see `PanelHost.closeTabsFor`).
     *
     * @param _node - The table's navigator node; accepted for call-site
     *   parity with the other table launchers but unused — the tabs closed
     *   on success are looked up by panel id, not by node.
     */
    dropTable(ref: DbObjectRef, _node?: TreeNode): void {
        const form = new ConfirmCascadeForm(`Drop table "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop table",
            form,
            generateSql: async () =>
                (await previewDropTable(ref, { schema: ref.schema!, name: ref.name!, ...form.readSpec() })).sql,
            onSuccess: () => {
                this.reveal.refreshNavigator();
                this.host.closeTabsFor(ref);
            },
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP dialog for a view or materialized view. Success
     * refreshes the navigator and closes every tab for the now-gone object.
     */
    dropRelation(ref: DbObjectRef): void {
        const label = ref.kind === "materializedView" ? "materialized view" : "view";
        const form  = new ConfirmCascadeForm(`Drop ${label} "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title: `Drop ${label}`,
            form,
            generateSql: async () => (await (ref.kind === "materializedView" ? previewDropMatview : previewDropView)(ref, {
                schema:  ref.schema!,
                name:    ref.name!,
                cascade: form.readSpec().cascade,
            })).sql,
            onSuccess: () => {
                this.reveal.refreshNavigator();
                this.host.closeTabsFor(ref);
            },
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP SCHEMA dialog for a schema. Success refreshes the
     * navigator and closes every tab for the now-gone schema (its Diagram,
     * Dependency, and Inheritance graph tabs — see `PanelHost.closeTabsFor`).
     */
    dropSchema(ref: DbObjectRef): void {
        const form = new ConfirmCascadeForm(`Drop schema "${ref.schema}"? This drops every object it contains.`);

        openSqlPreviewDialog({
            title: "Drop schema",
            form,
            generateSql: async () =>
                (await previewDropSchema(ref, buildDropSchemaSpec(ref.schema!, form.readSpec().cascade))).sql,
            onSuccess: () => {
                this.reveal.refreshNavigator();
                this.host.closeTabsFor(ref);
            },
            ...this.ddlDefaults(ref),
        });
    }

    /** Open the DROP SEQUENCE dialog for a sequence. Success refreshes the navigator. */
    dropSequence(ref: DbObjectRef): void {
        const form = new ConfirmCascadeForm(`Drop sequence "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title: "Drop sequence",
            form,
            generateSql: async () =>
                (await previewDropSequence(ref, buildDropSequenceSpec(ref.schema!, ref.name!, form.readSpec().cascade))).sql,
            onSuccess: () => this.reveal.refreshNavigator(),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP FUNCTION/PROCEDURE dialog for a function/procedure leaf.
     * Success refreshes the navigator and closes its definition tab (see
     * `PanelHost.closeTabsFor`). Reuses `ConfirmCascadeForm`, matching every
     * other drop dialog's idiom.
     *
     * @param ref - the function/procedure to drop (its `signature`
     *   disambiguates overloads; `isProcedure` selects the DROP keyword).
     */
    dropFunction(ref: DbObjectRef): void {
        const kind = ref.isProcedure ? "procedure" : "function";
        const form = new ConfirmCascadeForm(`Drop ${kind} "${ref.schema}"."${ref.name}"(${ref.signature ?? ""})?`);

        openSqlPreviewDialog({
            title:       "Drop function",
            form,
            generateSql: async () => (await previewDropFunction(ref, buildDropFunctionSpec(
                ref.schema!, ref.name!, kind, ref.signature ?? "", form.readSpec().cascade,
            ))).sql,
            onSuccess: () => {
                this.reveal.refreshNavigator();
                this.host.closeTabsFor(ref);
            },
            ...this.ddlDefaults(ref),
        });
    }

    /** Open the DROP TYPE dialog for a type leaf. Success refreshes the navigator. */
    dropType(ref: DbObjectRef): void {
        const form = new ConfirmCascadeForm(`Drop type "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop type",
            form,
            generateSql: async () =>
                (await previewDropType(ref, buildDropTypeSpec(ref.schema!, ref.name!, form.readSpec().cascade))).sql,
            onSuccess: () => this.reveal.refreshNavigator(),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the "Add constraint" dialog for one kind (the Constraints section
     * toolbar). A foreign key's form needs the connection's schema list for
     * its referenced-schema combo, fetched up front; the other kinds need no
     * extra fetch. Success rebuilds the structure tab only — a constraint
     * doesn't change the data tab's column set.
     */
    async addConstraint(ref: DbObjectRef, kind: ConstraintKind): Promise<void> {
        const columns = this.structureColumns(ref).map(c => c.name);
        let schemas: string[] = [];

        if (kind === "foreignKey") {
            const fetched = await this.fetchSchemaNames(ref);

            if (fetched === null) {
                return;
            }

            schemas = fetched;
        }

        const form = new ConstraintForm(ref.schema!, ref.name!, kind, columns, schemas);

        openSqlPreviewDialog({
            title:       "Add constraint",
            form,
            generateSql: async () => (await previewConstraint(ref, form.readSpec())).sql,
            onSuccess:   () => this.refreshStructure(ref),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP CONSTRAINT dialog for a named constraint — primary key,
     * unique, check, or foreign key alike, dropped uniformly by name (the
     * Constraints and Foreign Keys section toolbars).
     */
    dropConstraint(ref: DbObjectRef, constraintName: string): void {
        const form = new ConfirmCascadeForm(`Drop constraint "${constraintName}" on "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop constraint",
            form,
            generateSql: async () =>
                (await previewConstraint(ref, buildConstraintSpec(ref.schema!, ref.name!, "drop", {
                    constraintName, cascade: form.readSpec().cascade,
                }))).sql,
            onSuccess: () => this.refreshStructure(ref),
            ...this.ddlDefaults(ref),
        });
    }

    /** Open the CREATE INDEX dialog for a table (the Indexes section toolbar). Success rebuilds the structure tab only. */
    createIndex(ref: DbObjectRef): void {
        const columns = this.structureColumns(ref).map(c => c.name);
        const form    = new IndexForm(ref.schema!, ref.name!, columns);

        openSqlPreviewDialog({
            title:       "Create index",
            form,
            generateSql: async () => (await previewIndex(ref, form.readSpec())).sql,
            onSuccess:   () => this.refreshStructure(ref),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the DROP INDEX dialog for a named index (the Indexes section
     * toolbar). Success rebuilds the structure tab only.
     */
    dropIndex(ref: DbObjectRef, indexName: string): void {
        const form = new ConfirmCascadeForm(`Drop index "${indexName}"?`);

        openSqlPreviewDialog({
            title:       "Drop index",
            form,
            generateSql: async () =>
                (await previewIndex(ref, buildIndexSpec(ref.schema!, "drop", {
                    indexName, cascade: form.readSpec().cascade,
                }))).sql,
            onSuccess: () => this.refreshStructure(ref),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * Open the "Create index" dialog for a heuristic index advisor suggestion,
     * with the suggested columns pre-checked — the suggestions strip's "Create
     * index…" action (QueryPanel's `indexAdvisor.onCreateIndex`). Modelled on
     * {@link createIndex}, but fetches the table's full column list with
     * `getColumns(ref)` rather than reading the cached `structureColumns`,
     * since a suggestion's table need not have its Structure tab open.
     *
     * @param columns - The advisor's suggested columns, pre-checked in the form.
     */
    async createSuggestedIndex(schema: string, table: string, columns: string[]): Promise<void> {
        const ref: DbObjectRef = {
            connectionId: this.host.connectionId, database: this.host.database, schema, name: table, kind: "table",
        };

        let allColumns: string[];

        try {
            allColumns = (await getColumns(ref)).map(c => c.name);
        } catch (err) {
            this.host.notifyError(err, ref);

            return;
        }

        const form = new IndexForm(schema, table, allColumns, columns);

        openSqlPreviewDialog({
            title:       "Create index",
            form,
            generateSql: async () => (await previewIndex(ref, form.readSpec())).sql,
            onSuccess:   () => this.refreshStructure(ref),
            ...this.ddlDefaults(ref),
        });
    }

    /**
     * The execute + error-report pair every DDL flow — tab-hosted or
     * dialog-hosted — wires the same way: run the previewed SQL through
     * `executeDdl`, and report a preview/execute failure through `notifyError`.
     */
    private ddlDefaults(ref: DbObjectRef): DdlExecuteDeps {
        return {
            execute: sql => executeDdl(this.host.connectionId, sql),
            onError: msg => this.host.notifyError(new Error(msg), ref),
        };
    }

    /**
     * Open (or focus) a DDL draft tab: a `DdlFormPanel` hosting `spec.build()`'s
     * form, deduped by `ddlPanelId`. `build` is a factory so nothing is
     * constructed on the dedup (already-open) path. A successful execute
     * closes the tab and refreshes the navigator.
     */
    private openDdlPanel(spec: {
        ref: DbObjectRef; slug: string; title: string; glyph: string;
        reviewTitle: string; build: () => DdlDraft;
    }): void {
        const id = ddlPanelId(spec.ref, spec.slug);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const draft = spec.build();
        const panel = new DdlFormPanel({
            reviewTitle: spec.reviewTitle,
            form:        draft.form,
            generateSql: draft.generateSql,
            onSuccess:   () => {
                this.host.dock.removePanel(id);
                this.reveal.refreshNavigator();
            },
            ...this.ddlDefaults(spec.ref),
        });

        this.host.dock.addPanel({ id, title: spec.title, glyph: spec.glyph, content: panel });
    }

    /**
     * The connection's schema names, for a form's schema combo or a
     * referenced-schema list. Every DDL launcher that needs the connection's
     * schemas shares this one preamble.
     *
     * @returns the schema names, or `null` after reporting the failure —
     *   the caller returns without opening anything on `null`.
     */
    private async fetchSchemaNames(ref: DbObjectRef): Promise<string[] | null> {
        try {
            return (await getSchemas(ref.connectionId, ref.database!)).map(s => s.name);
        } catch (err) {
            this.host.notifyError(err, ref);

            return null;
        }
    }

    /**
     * The shared body of {@link createView} and {@link createMaterializedView}:
     * fetch the connection's schema list for the form's schema combo, then
     * open (or focus) the matching draft tab. A successful execute closes
     * the tab and refreshes the navigator, since a new relation changes the
     * schema's object list.
     */
    private async createRelationDraft(ref: DbObjectRef, kind: "view" | "materializedView"): Promise<void> {
        const schemas = await this.fetchSchemaNames(ref);

        if (schemas === null) {
            return;
        }

        if (kind === "view") {
            this.openDdlPanel({
                ref,
                slug:        "view",
                title:       `New view (${ref.schema})`,
                glyph:       KIND_GLYPH.view,
                reviewTitle: "Create view",
                build:       () => {
                    const form = new ViewForm(ref, schemas);

                    return { form, generateSql: async () => (await previewCreateView(ref, form.readSpec())).sql };
                },
            });

            return;
        }

        this.openDdlPanel({
            ref,
            slug:        "matview",
            title:       `New materialized view (${ref.schema})`,
            glyph:       KIND_GLYPH.materializedView,
            reviewTitle: "Create materialized view",
            build:       () => {
                const form = new MaterializedViewForm(ref, schemas);

                return { form, generateSql: async () => (await previewCreateMatview(ref, form.readSpec())).sql };
            },
        });
    }

    /**
     * The structure tab's own columns for a table, from the open-panel
     * registry (populated by `ObjectPanels.openStructure` and kept current by
     * its Refresh) — the source the Constraints/Indexes forms build their
     * column checklists from. Empty when the structure tab isn't open (a
     * toolbar action can't run without it, so this is defensive, not an
     * expected path).
     */
    private structureColumns(ref: DbObjectRef): ColumnMeta[] {
        return this.host.panelEntry(structurePanelId(ref))?.columns ?? [];
    }

    /**
     * Reseed the open Structure tab in place after a structure-only change (a
     * constraint or index add/drop, or a NOT-NULL/default toggle) — the data
     * tab's column set is unaffected, so it's left open. Dispatches to the
     * same in-place `refresh` closure `ObjectPanels.openStructure` registers
     * (the one Alt+R and the Columns-Save success path already use), which
     * keeps the tab's accordion open-state and scroll position rather than a
     * remove-and-reopen. A no-op if the structure tab isn't open.
     */
    private refreshStructure(ref: DbObjectRef): void {
        this.host.panelEntry(structurePanelId(ref))?.refresh?.();
    }
}
