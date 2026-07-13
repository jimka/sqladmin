// Drop (view or matview) and REFRESH MATERIALIZED VIEW launchers: each opens
// the shared SqlPreviewDialog with a small toggle-only form — no bespoke
// confirm modal, since the preview text itself is the confirmation gate (see
// plans/implemented/view-matview-ddl.md's "Drop/refresh reuse the same
// preview+confirm dialog" decision).

import { Panel }             from "@jimka/typescript-ui/core";
import { VBox }              from "@jimka/typescript-ui/layout";
import { Checkbox, Text }    from "@jimka/typescript-ui/component/input";
import type { DbObjectKind, DdlPreview, DropSpec, QueryStatusResult, RefreshMatviewSpec } from "../contract";
import { openSqlPreviewDialog } from "./SqlPreviewDialog";

/** Dependencies for {@link openDropRelationDialog}. */
export interface DropDialogDeps {
    /** Which kind is being dropped — drives the dialog's title/label. */
    kind: DbObjectKind;
    schema: string;
    name: string;

    /** Preview the DROP statement for the form's current CASCADE toggle. */
    preview: (spec: DropSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The drop-confirmation form: a summary line plus an optional CASCADE checkbox. */
class DropRelationForm extends Panel {
    private readonly _cascadeBox: Checkbox;

    /** @param summary - a one-line description of what is being dropped. */
    constructor(summary: string) {
        const cascadeBox = Checkbox({ label: "CASCADE (also drop dependent objects)", selected: false });

        super({ layoutManager: new VBox({ stretching: true }), components: [new Text(summary), cascadeBox] });

        this._cascadeBox = cascadeBox;
    }

    /** @returns whether the CASCADE checkbox is checked. */
    cascade(): boolean {
        return this._cascadeBox.getValue();
    }
}

/** The label used in the drop dialog's title/summary for each relation kind. */
function relationLabel(kind: DbObjectKind): string {
    return kind === "materializedView" ? "materialized view" : "view";
}

/**
 * Open the DROP VIEW / DROP MATERIALIZED VIEW confirm+preview dialog.
 *
 * @param deps - the target relation, preview/execute callbacks, and kind.
 */
export function openDropRelationDialog(deps: DropDialogDeps): void {
    const label = relationLabel(deps.kind);
    const form = new DropRelationForm(`Drop ${label} "${deps.schema}"."${deps.name}"?`);

    openSqlPreviewDialog({
        title: `Drop ${label}`,
        form,
        generateSql: async () => (await deps.preview({
            schema: deps.schema,
            name:   deps.name,
            cascade: form.cascade(),
        })).sql,
        execute:   deps.execute,
        onSuccess: deps.onSuccess,
        onError:   deps.onError,
    });
}

/** Dependencies for {@link openRefreshMatviewDialog}. */
export interface RefreshDialogDeps {
    schema: string;
    name: string;

    /** Preview the REFRESH statement for the form's current toggles. */
    preview: (spec: RefreshMatviewSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute (a refresh does not change the object list). */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/**
 * The REFRESH form: CONCURRENTLY and WITH NO DATA toggles, mutually
 * disabling each other since Postgres rejects the combination (see the
 * view-matview-ddl plan's "Refresh form checkbox mutual-exclusion" note).
 */
class RefreshMatviewForm extends Panel {
    private readonly _concurrentlyBox: Checkbox;
    private readonly _withNoDataBox: Checkbox;

    constructor() {
        const concurrentlyBox = Checkbox({ label: "CONCURRENTLY (requires a unique index)", selected: false });
        const withNoDataBox = Checkbox({ label: "WITH NO DATA (clear instead of repopulate)", selected: false });

        super({
            layoutManager: new VBox({ stretching: true }),
            components:    [concurrentlyBox, withNoDataBox],
        });

        this._concurrentlyBox = concurrentlyBox;
        this._withNoDataBox = withNoDataBox;

        // A cheap client guard, not a substitute for Postgres's own rejection:
        // hand-editing the preview text can still produce the illegal
        // combination, and Postgres remains authoritative at execute.
        concurrentlyBox.on("change", (checked: boolean) => this._withNoDataBox.setEnabled(!checked));
        withNoDataBox.on("change", (checked: boolean) => this._concurrentlyBox.setEnabled(!checked));
    }

    /** @returns whether CONCURRENTLY is checked. */
    concurrently(): boolean {
        return this._concurrentlyBox.getValue();
    }

    /** @returns whether WITH NO DATA is checked. */
    withNoData(): boolean {
        return this._withNoDataBox.getValue();
    }
}

/**
 * Open the REFRESH MATERIALIZED VIEW confirm+preview dialog.
 *
 * @param deps - the target matview and preview/execute callbacks.
 */
export function openRefreshMatviewDialog(deps: RefreshDialogDeps): void {
    const form = new RefreshMatviewForm();

    openSqlPreviewDialog({
        title: "Refresh materialized view",
        form,
        generateSql: async () => (await deps.preview({
            schema: deps.schema,
            name:   deps.name,
            concurrently: form.concurrently(),
            withNoData:   form.withNoData(),
        })).sql,
        execute:   deps.execute,
        onSuccess: deps.onSuccess,
        onError:   deps.onError,
    });
}
