// The dock-tab host for a DDL creation form — the creation counterpart to
// SequenceInfoPanel's and StructurePanel's in-tab Save: the tab owns the
// form, and the review dialog (opened by its "Review SQL…" tool) owns only
// the generated SQL. The field is `_deps`, not `_options`: `Container`
// already declares an `_options` member, and a subclass field of that name is
// a TS2416 error.

import { Container, Panel, callable } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Border as BorderLayout, VBox } from "@jimka/typescript-ui/layout";
import { Placement } from "@jimka/typescript-ui/primitive";
import { ToolBar } from "@jimka/typescript-ui/component/menubar";
import { Spacer } from "@jimka/typescript-ui/component/container";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { save } from "@jimka/typescript-ui/glyphs/solid/save";
import { glyphButton } from "./glyphButton";
import { openSqlPreviewDialog } from "./SqlPreviewDialog";
import { PRIMARY_COLOR } from "../theme";
import type { QueryStatusResult } from "../contract";

Glyph.register(save);

/** The execute + error-report pair every DDL flow wires identically. */
export interface DdlExecuteDeps {
    /** Execute the (possibly hand-edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;
    /** Report a preview/execute error. */
    onError: (message: string) => void;
}

/** A DDL draft's live form plus the SQL generator that reads it. */
export interface DdlDraft {
    form: Component;
    generateSql: () => Promise<string>;
}

/** Construction inputs for {@link DdlFormPanel}. */
export interface DdlFormPanelOptions extends DdlExecuteDeps, DdlDraft {
    /** Title of the SQL review dialog the panel's `Review SQL…` tool opens. */
    reviewTitle: string;
    /** Run after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;
}

/**
 * A DDL creation form's dock tab: a `Review SQL…` toolbar tool in the NORTH
 * region over the live form in the CENTER region. Review opens the shared
 * `SqlPreviewDialog` with no `form` — the tab keeps the form, the dialog
 * shows only the generated SQL.
 */
class DdlFormPanel extends Container {
    private readonly _deps: DdlFormPanelOptions;

    constructor(options: DdlFormPanelOptions) {
        const formHost = Panel({ layoutManager: new VBox(), autoScroll: "auto" });

        formHost.addComponent(options.form);

        const reviewButton = glyphButton("save", PRIMARY_COLOR, "Review SQL…", () => this.review());
        const toolbar      = new ToolBar({ components: [reviewButton, Spacer.flex()] });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._deps = options;

        this.addComponent(toolbar,  { placement: Placement.NORTH });
        this.addComponent(formHost, { placement: Placement.CENTER });
    }

    /** Open the shared SQL review dialog over this tab's form. */
    private review(): void {
        openSqlPreviewDialog({
            title:       this._deps.reviewTitle,
            generateSql: this._deps.generateSql,
            execute:     this._deps.execute,
            onSuccess:   this._deps.onSuccess,
            onError:     this._deps.onError,
        });
    }
}

const DdlFormPanelCallable = callable(DdlFormPanel);
type DdlFormPanelCallable = DdlFormPanel;
export { DdlFormPanelCallable as DdlFormPanel };
