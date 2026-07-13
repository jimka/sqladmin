// The dock work panel for a sequence's current state and parameters (current
// value, start/min/max, increment, cache size, cycle, data type, owner),
// shown in its own tab opened from the navigator's double-click / "Show
// info" context item. A typed form (not the old editable Property/Value
// table): each attribute gets its own widget — integer text fields for the
// numeric options, a Checkbox for Cycle, and a ComboBox each for Data type
// (the ALTER SEQUENCE type allowlist) and Owner (the connection's roles) —
// because the library's Table editor is per-column, not per-row, so a single
// mixed Value column couldn't host a checkbox next to numeric strings.
//
// The numeric fields (Current/Start/Min/Max value, Increment, Cache size)
// must stay JS strings all the way through — a bigint-sized value like
// "9223372036854775807" exceeds Number.MAX_SAFE_INTEGER — which rules out the
// library's JS-number-backed NumberSpinner/SpinButton. They are plain
// TextFields with `inputMode: "numeric"` (a mobile-keyboard hint; the library
// has no per-keystroke input filter on TextField, so this is not a hard
// guard). A non-integer value is instead caught at Save time by
// `diffSequenceSpecs`'s `requireIntString` and surfaced through `onError`;
// dirty tracking (`isSequenceFormDirty`, sequenceFormState.ts) is
// deliberately throw-free so it can still recompute correctly on that same
// in-progress, possibly-invalid text.
//
// Data type and Owner are store-backed ComboBoxes, not plain-string ones: a
// plain-string ComboBox keys each option by its positional index, so
// getValue() would return "0"/"1"/… after a selection rather than the
// type/role name (see ComboBox's "static items" doc). Binding each to a
// MemoryStore whose `name` field is both value and display field makes
// getValue() return the name, which is what the Save diff needs.
//
// Holds only value-bearing input widgets (no CodeEditor/theme subscription),
// so it needs no dispose.

import { Container, Panel }            from "@jimka/typescript-ui/core";
import { Border as BorderLayout, VBox } from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Button }                      from "@jimka/typescript-ui/component/button";
import { Checkbox, ComboBox, Text, TextField } from "@jimka/typescript-ui/component/input";
import { LabeledFieldSet }             from "@jimka/typescript-ui/component/container";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { MemoryStore, Model }          from "@jimka/typescript-ui/data";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import type { AlterSequenceSpec, DdlPreview, QueryStatusResult, SequenceDetail, SequenceOwnerSpec } from "../contract";
import { diffSequenceSpecs }           from "./ddlSpecs";
import type { EditedSequenceValues, SequenceEditSpecs } from "./ddlSpecs";
import { dataTypeItems, detailToEditedValues, isSequenceFormDirty, ownerItems } from "./sequenceFormState";
import { glyphButton }                 from "./glyphButton";
import { openSqlPreviewDialog }        from "./SqlPreviewDialog";
import { PRIMARY_COLOR }               from "../theme";

Glyph.register(save);

/** The `name`-only model backing the Data type / Owner combo stores. */
const NAME_MODEL = new Model({ fields: [{ name: "name", type: "string" }] });

/** Dependencies {@link SequenceInfoPanel} needs to preview/execute/reload a Save. */
export interface SequenceInfoPanelDeps {
    schema: string;
    name: string;

    /**
     * The connection's role names, for the Owner combo. Empty when the
     * roles fetch failed — the combo then degrades to a single item holding
     * just the sequence's current owner (see `ownerItems`), rather than
     * failing the whole tab open.
     */
    roles: readonly string[];

    /** Preview the ALTER SEQUENCE parameter-form statement for the current diff. */
    previewAlter: (spec: AlterSequenceSpec) => Promise<DdlPreview>;

    /** Preview the OWNER TO statement for the current diff. */
    previewOwner: (spec: SequenceOwnerSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Re-fetch the sequence's detail after a successful Save. */
    reloadDetail: () => Promise<SequenceDetail>;

    /** Report a diff/preview/execute error. */
    onError: (message: string) => void;

    /** Report a short status message (e.g. a no-op Save, a successful alter). */
    onStatus: (message: string) => void;
}

/** A tab-filling typed form of a sequence's current state and parameters. */
export class SequenceInfoPanel extends Container {
    private readonly _deps:              SequenceInfoPanelDeps;
    private readonly _currentValueField: TextField;
    private readonly _startValueField:   TextField;
    private readonly _incrementField:    TextField;
    private readonly _minValueField:     TextField;
    private readonly _maxValueField:     TextField;
    private readonly _cacheSizeField:    TextField;
    private readonly _cycleBox:          Checkbox;
    private readonly _dataTypeStore:     MemoryStore;
    private readonly _dataTypeCombo:     ComboBox;
    private readonly _ownerStore:        MemoryStore;
    private readonly _ownerCombo:        ComboBox;
    private readonly _saveButton:        Button;

    // Mutable: replaced with the freshly reloaded detail (and its derived
    // baseline) after a successful Save, so the next diff/dirty-check
    // compares against the new baseline.
    private _detail:   SequenceDetail;
    private _baseline: EditedSequenceValues;

    /**
     * @param detail - the sequence's current state and parameters, fetched
     *   by the controller before construction.
     * @param deps - the connection's roles plus preview/execute/reload
     *   callbacks and error/status reporters.
     */
    constructor(detail: SequenceDetail, deps: SequenceInfoPanelDeps) {
        const currentValueField = new TextField({ inputMode: "numeric" });
        const startValueField   = new TextField({ inputMode: "numeric" });
        const incrementField    = new TextField({ inputMode: "numeric" });
        const minValueField     = new TextField({ inputMode: "numeric" });
        const maxValueField     = new TextField({ inputMode: "numeric" });
        const cacheSizeField    = new TextField({ inputMode: "numeric" });
        const cycleBox          = new Checkbox();

        // No `autoLoad` here: it would kick off an async `store.load()` that
        // resolves on a later microtask and re-reads the (still-empty) proxy
        // data, clobbering the synchronous `loadData()` seed below with an
        // empty record set (and, with it, the just-set selection/label). Since
        // every population of these stores goes through our own `loadData()`
        // call (never the proxy), there's nothing for `autoLoad` to do anyway.
        const dataTypeStore = new MemoryStore({ model: NAME_MODEL, data: [] });
        const dataTypeCombo = new ComboBox({ store: dataTypeStore, valueField: "name", displayField: "name" });
        const ownerStore    = new MemoryStore({ model: NAME_MODEL, data: [] });
        const ownerCombo    = new ComboBox({ store: ownerStore, valueField: "name", displayField: "name" });

        // The legend is the sequence's schema-qualified name (the tab title
        // already shows the bare name, but the legend sits on the fieldset's
        // own border and reads fine repeated / qualified). It must be
        // non-empty: an empty legend string leaves a gap in the fieldset's
        // top border where the legend notch would otherwise sit (see
        // LIBRARY_NOTES.md).
        const form = new LabeledFieldSet(`${deps.schema}.${deps.name}`, {
            rows: [
                [{ title: "Current value", component: currentValueField }],
                [{ title: "Start value",   component: startValueField }],
                [{ title: "Increment",     component: incrementField }],
                [{ title: "Min value",     component: minValueField }],
                [{ title: "Max value",     component: maxValueField }],
                [{ title: "Cache size",    component: cacheSizeField }],
                [{ title: "Cycle",         component: cycleBox }],
                [{ title: "Data type",     component: dataTypeCombo }],
                [{ title: "Owner",         component: ownerCombo }],
            ],
        });

        // LabeledFieldSet's Grid gives its input track a weighted (stretching)
        // column, so dropping the form straight into the tab's CENTER region
        // stretches it to the tab's full width — unwieldy on an ultra-wide,
        // maximized window. A plain (non-stretching) VBox wrapper instead
        // sizes the form to its own preferred width and top/left-anchors it;
        // `autoScroll: "auto"` keeps the tab scrollable, rather than clipped,
        // when the tab is narrower than the form's content minimum.
        const formHost = Panel({ layoutManager: new VBox(), autoScroll: "auto" });
        formHost.addComponent(form);

        const saveButton = glyphButton("save", PRIMARY_COLOR, "Save", () => this.handleSave());
        const toolbar = new ToolBar({ components: [saveButton] });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._deps              = deps;
        this._currentValueField = currentValueField;
        this._startValueField   = startValueField;
        this._incrementField    = incrementField;
        this._minValueField     = minValueField;
        this._maxValueField     = maxValueField;
        this._cacheSizeField    = cacheSizeField;
        this._cycleBox          = cycleBox;
        this._dataTypeStore     = dataTypeStore;
        this._dataTypeCombo     = dataTypeCombo;
        this._ownerStore        = ownerStore;
        this._ownerCombo        = ownerCombo;
        this._saveButton        = saveButton;
        this._detail            = detail;
        this._baseline          = detailToEditedValues(detail);

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(formHost, { placement: Placement.CENTER });

        this.seedFields(detail);

        for (const widget of [
            currentValueField, startValueField, incrementField, minValueField, maxValueField, cacheSizeField,
        ]) {
            widget.on("change", this.syncSaveEnabled);
        }
        cycleBox.on("change", this.syncSaveEnabled);
        dataTypeCombo.on("change", this.syncSaveEnabled);
        ownerCombo.on("change", this.syncSaveEnabled);

        this.syncSaveEnabled();
    }

    /**
     * Writes `detail`'s values into every widget — the initial seed at
     * construction, and the reseed after a successful Save's reload. Does
     * not touch `_baseline` or Save's enabled state; callers update those
     * themselves (construction seeds `_baseline` before this runs;
     * {@link handleSuccess} updates it alongside the reseed).
     */
    private seedFields(detail: SequenceDetail): void {
        this._currentValueField.setValue(detail.lastValue ?? "");
        this._startValueField.setValue(detail.startValue);
        this._incrementField.setValue(detail.increment);
        this._minValueField.setValue(detail.minValue);
        this._maxValueField.setValue(detail.maxValue);
        this._cacheSizeField.setValue(detail.cacheSize);
        this._cycleBox.setValue(detail.cycle);

        this._dataTypeStore.loadData(dataTypeItems(detail.dataType).map(name => ({ name })));
        this._dataTypeCombo.setValue(detail.dataType);
        this._ownerStore.loadData(ownerItems(this._deps.roles, detail.owner).map(name => ({ name })));
        this._ownerCombo.setValue(detail.owner);
    }

    // Registered by reference on every widget's "change" event — an
    // arrow-function field so it keeps `this` when invoked as a callback.
    private syncSaveEnabled = (): void => {
        this._saveButton.setEnabled(isSequenceFormDirty(this._baseline, this.readEdited()));
    };

    /**
     * Read every widget's current value into the shape {@link diffSequenceSpecs}
     * (and {@link isSequenceFormDirty}) compare — every numeric value stays a
     * string (see ddlSpecs.ts's "bigint stays a STRING end-to-end" note).
     */
    private readEdited(): EditedSequenceValues {
        return {
            lastValue:  this._currentValueField.getValue(),
            startValue: this._startValueField.getValue(),
            increment:  this._incrementField.getValue(),
            minValue:   this._minValueField.getValue(),
            maxValue:   this._maxValueField.getValue(),
            cacheSize:  this._cacheSizeField.getValue(),
            cycle:      this._cycleBox.getValue(),
            dataType:   this._dataTypeCombo.getValue(),
            owner:      this._ownerCombo.getValue(),
        };
    }

    /**
     * Diff the current edits against `_detail` and, if anything changed, open
     * the shared SQL preview dialog; a diff error (a non-integer numeric
     * field) and an empty diff are both reported through `deps` without
     * opening a dialog.
     */
    private handleSave(): void {
        let specs: SequenceEditSpecs;

        try {
            specs = diffSequenceSpecs(this._deps.schema, this._deps.name, this._detail, this.readEdited());
        } catch (err) {
            this._deps.onError(err instanceof Error ? err.message : String(err));

            return;
        }

        if (!specs.alter && !specs.owner) {
            this._deps.onStatus("No changes");

            return;
        }

        openSqlPreviewDialog({
            title: "Alter sequence",
            form:  summaryPanel(specs, this._detail),
            generateSql: async () => {
                const parts: string[] = [];

                if (specs.alter) {
                    parts.push((await this._deps.previewAlter(specs.alter)).sql);
                }
                if (specs.owner) {
                    parts.push((await this._deps.previewOwner(specs.owner)).sql);
                }

                return parts.join(";\n");
            },
            execute:   this._deps.execute,
            onSuccess: () => void this.handleSuccess(),
            onError:   this._deps.onError,
        });
    }

    /** After a successful execute: reload the detail and refresh the form in place. */
    private async handleSuccess(): Promise<void> {
        const detail = await this._deps.reloadDetail();

        this._detail = detail;
        this._baseline = detailToEditedValues(detail);
        this.seedFields(detail);
        this.syncSaveEnabled();
        this._deps.onStatus(`${this._deps.name}: altered`);
    }
}

/**
 * Build the minimal read-only summary shown above the SQL preview: one line
 * per changed property, e.g. "Increment: 10 → 25". Display-only — the
 * previewed (and possibly hand-edited) SQL text is authoritative at execute,
 * the same trust model every other DDL phase's preview dialog uses.
 *
 * @param specs - the diff's alter/owner specs (at least one is set).
 * @param detail - the pre-edit detail, supplying each line's "before" value.
 */
function summaryPanel(specs: SequenceEditSpecs, detail: SequenceDetail): Panel {
    const lines: string[] = [];
    const alter = specs.alter;

    if (alter) {
        if (alter.dataType !== undefined) {
            lines.push(`Data type: ${detail.dataType} → ${alter.dataType}`);
        }
        if (alter.increment !== undefined) {
            lines.push(`Increment: ${detail.increment} → ${alter.increment}`);
        }
        if (alter.start !== undefined) {
            lines.push(`Start value: ${detail.startValue} → ${alter.start}`);
        }
        if (alter.minValue !== undefined) {
            lines.push(`Min value: ${detail.minValue} → ${alter.minValue}`);
        }
        if (alter.maxValue !== undefined) {
            lines.push(`Max value: ${detail.maxValue} → ${alter.maxValue}`);
        }
        if (alter.cache !== undefined) {
            lines.push(`Cache size: ${detail.cacheSize} → ${alter.cache}`);
        }
        if (alter.cycle !== undefined) {
            lines.push(`Cycle: ${detail.cycle ? "Yes" : "No"} → ${alter.cycle ? "Yes" : "No"}`);
        }
        if (alter.restart !== undefined) {
            lines.push(`Current value: ${detail.lastValue ?? "—"} → ${alter.restart}`);
        }
    }
    if (specs.owner) {
        lines.push(`Owner: ${detail.owner} → ${specs.owner.owner}`);
    }

    return Panel({
        layoutManager: new VBox({ stretching: true }),
        components:    lines.map(line => new Text(line)),
    });
}
