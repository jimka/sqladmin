// The shared base for the app's traversal diagram panels: a Border layout
// with a WEST column (an optional `Root …` selector, Direction / Depth /
// prune controls shown while a root is chosen, plus a scrolling legend) over
// a CENTER DiagramView. The root is `string | null` shell state — a panel
// whose root never changes passes `fixedRoot: true` (no selector is built);
// a panel the user may re-root passes the whole graph plus a caption and gets
// a `Root …` combo listing it. RelationDiagramPanel and RootedRelationGraphPanel
// open fixed; DatabaseDiagramPanel, SchemaDiagramPanel, RelationGraphPanel, and
// RoleGrantsDiagramPanel open selectable. ExplainDiagramPanel does not extend
// this shell — it has its own accordion column and a query plan's one true
// root. Subclasses override rootingChanged/pruneChanged to re-derive their own
// graph state; the shell owns the root, the Depth control (seeded from an
// `initialDepth` config value via depthChoices.ts's depthChoice), and the
// column assembly, since those have to agree across every subclass. The depth
// vocabulary itself (DEPTH_CHOICES, the All sentinel, depthFromChoice) lives
// in depthChoices.ts, kept DOM-free so it can be unit-tested under the
// project's node-environment vitest (see depthChoices.ts's own header). See
// plans/implemented/diagram-shell-optional-root.md for the unification
// rationale, and plans/implemented/diagram-depth-limit-and-expand-indicator.md
// for the original control-column extraction.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly —
// the Border-layout assembly a subclass's factory used to build itself. Child
// controls are built as locals before super() (they are super()'s children;
// `this` is unavailable until super() returns), and their `change` listeners
// are wired after super() via `.on(...)`, per (b). No overridable method
// (`rootingChanged`, `pruneChanged`) runs during the constructor: the initial
// root is read from `config` directly, and `applyRootVisibility` is private
// and reads only this class's own fields.

import { Component, Panel, callable } from "@jimka/typescript-ui/core";
import { Border, HBox, VBox } from "@jimka/typescript-ui/layout";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Checkbox, ComboBox, Text } from "@jimka/typescript-ui/component/input";
import type { DiagramView } from "@jimka/typescript-ui/component/diagram";
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { TraversalDirection } from "../data/relationDiagram";
import { rootChoices } from "../data/relationDiagram";
import { DEPTH_CHOICES, depthChoice } from "./depthChoices";
import { DiagramShellState, sameSettle } from "./diagramShellState";

/** The root selector's sentinel item: no root chosen, so the whole graph shows. */
const ROOT_NONE = "(none)";

// Fixed width of the WEST side panel: enough for a checkbox plus a typical
// table name without stealing canvas width from the diagram.
const LEGEND_WIDTH = 220;

/**
 * A caption stacked above its control. Vertical (not side-by-side) so a caption
 * is never squeezed / ellipsised in the fixed-width side column.
 *
 * @param caption - The control's label.
 * @param control - The control component.
 * @returns A VBox with the caption above the control.
 */
export function labelledRow(caption: string, control: Component): Component {
    return new Component({
        layoutManager: new VBox({ spacing: 2 }),
        components   : [new Text(caption), control],
    });
}

/** The CENTER view plus the subclass's extra control slots. */
export interface DiagramShellSlots {
    /** The CENTER diagram. Built by the subclass, which owns the node renderer. */
    view: DiagramView;
    /** Always-visible controls above the `Root …` row (the database diagram's Mode row). */
    headerControls?: Component[];
    /** Controls inside the hideable block, above Direction. */
    rootedControls?: Component[];
    /** Controls inside the hideable block, below the prune row (the relation diagram's coverage row). */
    extraControls?: Component[];
    /** The `DEPTH_CHOICES` entry the Depth control opens at; normalized through
     *  `depthChoice`, so an unrecognized value opens at the default. */
    initialDepth?: string;
}

/** A panel whose root never changes: no `Root …` row is built, and a root is required. */
export interface FixedRoot {
    fixedRoot: true;
    /** The immutable root's node id. */
    root: string;
}

/** A panel the user may re-root from a `Root …` row listing `full`'s nodes. */
export interface SelectableRoot {
    fixedRoot?: false;
    /** The whole graph, whose nodes the selector lists. */
    full: DiagramData;
    /** The selector row's caption, naming what this panel's nodes are ("Root table"). */
    rootCaption: string;
    /** The root to open at; omitted or null opens on the whole graph. */
    root?: string | null;
}

/** What a subclass hands the shell to assemble. The `FixedRoot` / `SelectableRoot`
 *  union makes `fixedRoot: true` require a `root` and forbid `full`/`rootCaption`
 *  at compile time, and a selectable config require `full` and `rootCaption`. */
export type DiagramShellConfig = DiagramShellSlots & (FixedRoot | SelectableRoot);

/**
 * The shared traversal-diagram column: an optional `Root …` selector, Direction,
 * Depth, and a prune checkbox shown while a root is chosen, and a scrolling
 * legend, over a CENTER `DiagramView`. A subclass supplies the view (and its own
 * extra control slots) via the config bag and drives its own graph state from
 * the two protected hooks (`rootingChanged`/`pruneChanged`), which the shell
 * invokes on a user gesture.
 */
class DiagramShell extends Panel {
    /** The CENTER diagram. */
    protected readonly view: DiagramView;
    /** The scrolling legend column; the subclass fills it. */
    protected readonly legend: Panel;

    /** The `Root …` row, or null when the root is fixed (no row is built). */
    private readonly rootRow:     Component | null;
    /** The `Root …` combo, or null when the root is fixed. Re-synced by setRoot. */
    private readonly rootControl: ComboBox  | null;
    private readonly rootedBlock: Panel;

    /** The DOM-free root / direction / depth / prune state the controls drive. */
    private readonly state: DiagramShellState;

    /** @param config - The CENTER view, the root mode, and the extra control slots. */
    constructor(config: DiagramShellConfig) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const { view } = config;
        const legend = Panel({ layoutManager: new VBox({ spacing: 2 }), autoScroll: "auto" });

        const initialRoot = config.fixedRoot ? config.root : (config.root ?? null);

        // No selector when the root is fixed — the tab's title names that
        // root. Built inside one `if (!config.fixedRoot)` (rather than two
        // separate ternaries keyed off `config.fixedRoot` and `rootControl
        // === null`) so the compiler narrows `config` to `SelectableRoot`
        // while `config.rootCaption` is read — a ternary re-keyed on
        // `rootControl`'s nullability cannot carry that narrowing across to
        // a second, independent expression.
        let rootControl: ComboBox | null = null;
        let rootRow: Component | null = null;

        if (!config.fixedRoot) {
            rootControl = ComboBox({ items: [ROOT_NONE, ...rootChoices(config.full)], value: initialRoot ?? ROOT_NONE });
            rootRow = labelledRow(config.rootCaption, rootControl);
        }

        const directionControl = ComboBox({
            items: [
                { key: "downstream", label: "Downstream" },
                { key: "upstream",   label: "Upstream" },
                { key: "both",       label: "Both" },
            ],
            value: "both",
        });

        const initialDepth = depthChoice(config.initialDepth);
        const depthControl = ComboBox({ items: DEPTH_CHOICES, value: initialDepth });
        const pruneControl = Checkbox({ value: false });

        const rootedBlock = Panel({
            layoutManager: new VBox({ spacing: 4 }),
            components: [
                ...(config.rootedControls ?? []),
                labelledRow("Direction", directionControl),
                labelledRow("Depth", depthControl),
                new Component({ layoutManager: new HBox({ spacing: 4 }), components: [pruneControl, new Text("Hide with prune")] }),
                ...(config.extraControls ?? []),
            ],
        });

        // The `Root …` row sits above the hideable block, so it survives while
        // the root is null.
        const controls = Panel({
            layoutManager: new VBox({ spacing: 4 }),
            components: [...(config.headerControls ?? []), ...(rootRow ? [rootRow] : []), rootedBlock],
        });

        const west = Panel({
            layoutManager: new Border(),
            preferredSize: { width: LEGEND_WIDTH, height: 0 },
            minSize      : { width: LEGEND_WIDTH, height: 0 },
            components: [
                { component: controls, constraints: { placement: Placement.NORTH } },
                { component: legend,   constraints: { placement: Placement.CENTER } },
            ],
        });

        super({
            layoutManager: new Border(),
            components: [
                { component: west, constraints: { placement: Placement.WEST } },
                { component: view, constraints: { placement: Placement.CENTER } },
            ],
        });

        this.view   = view;
        this.legend = legend;
        this.rootRow     = rootRow;
        this.rootControl = rootControl;
        this.rootedBlock = rootedBlock;
        this.state       = new DiagramShellState(initialRoot, config.initialDepth);

        // Reads only this shell's own fields, so no subclass field is touched
        // before the subclass body has run.
        this.applyRootVisibility();

        // Wire listeners after super() (this now available), per
        // COMPONENT_CONVENTIONS.md (b).
        directionControl.on("change", (v: string) => {
            this.state.setDirection(v as TraversalDirection);
            this.rootingChanged();
            this.settleViewport();
        });

        depthControl.on("change", (v: string) => {
            this.state.setDepthChoice(v);
            this.rootingChanged();
            this.settleViewport();
        });

        pruneControl.on("change", (v: boolean) => {
            this.state.setPrune(v);
            this.pruneChanged();
            this.settleViewport();
        });

        rootControl?.on("change", (v: string) => this.chooseRoot(v === ROOT_NONE ? null : v));

        // DiagramView now opens every view already fitted to the viewport on
        // its own (its fitOnLoad option, default true), so an unrooted panel
        // needs nothing further here. A panel that already has a root at
        // construction still does: a `fixedRoot` panel already passes
        // `initialFocusNode: root.id` to the view, so this call mostly
        // restates what the view will already do on its own — but a
        // `SelectableRoot` panel opened with a root passes no
        // `initialFocusNode` (the view was never told a root at all), so this
        // is the only thing that centres it rather than fitting the whole
        // graph. Deferred to the view's first connected+sized layout: called
        // straight from the constructor, `settleViewport` would race the ELK
        // layout this view's own constructor kicks off against the browser's
        // first sizing pass, and could silently no-op if the ELK pass lands
        // first, since the view would have no width/height yet.
        if (initialRoot !== null) {
            view.onFirstLayout(() => this.settleViewport());
        }
    }

    /**
     * Resolves once the view's in-flight layout pass has placed its nodes —
     * forwarded so `SqlAdminController.openAsyncPanel` can hold a rooted
     * diagram tab's spinner until the initial layout lands.
     *
     * @returns A promise settling on the next finished layout pass.
     */
    whenLaidOut(): Promise<void> {
        return this.view.whenLaidOut();
    }

    /**
     * The chosen root's node id, or null while the whole graph is shown.
     *
     * @returns The current root id, or null.
     */
    protected getRoot(): string | null {
        return this.state.getRoot();
    }

    /**
     * Adopt a root programmatically: writes the root, syncs the selector,
     * re-applies the traversal block's visibility, and invokes
     * `rootingChanged()`. Moves no viewport and emits no `change`.
     *
     * @param root - The root to adopt, or null for the whole graph.
     * @returns This shell, for method chaining.
     */
    protected setRoot(root: string | null): this {
        this.state.setRoot(root);

        // A programmatic ComboBox.setValue fires no `change` (the inner List
        // fires only from its click / keyboard reducers), so this does not
        // re-enter chooseRoot and the caller's own rootingChanged below is the
        // only re-derivation.
        this.rootControl?.setValue(root ?? ROOT_NONE);

        this.applyRootVisibility();
        this.rootingChanged();

        return this;
    }

    /**
     * Whether this panel is showing a rooted graph at all. False hides the
     * `Root …` row, the traversal block, and the legend together; true restores
     * them, the block still only while the root is non-null.
     *
     * @param displayed - True to show the rooted column.
     * @returns This shell, for method chaining.
     */
    protected setRootingDisplayed(displayed: boolean): this {
        this.state.setRootingDisplayed(displayed);
        this.applyRootVisibility();

        return this;
    }

    /**
     * The Direction control's current value.
     *
     * @returns The current traversal direction.
     */
    protected getDirection(): TraversalDirection {
        return this.state.getDirection();
    }

    /**
     * The Depth control's current hop limit.
     *
     * @returns The hop count, or `Number.POSITIVE_INFINITY` for `All`.
     */
    protected getDepth(): number {
        return this.state.getDepth();
    }

    /**
     * Whether the prune checkbox is ticked.
     *
     * @returns True when hiding a node also prunes what it orphans.
     */
    protected isPrune(): boolean {
        return this.state.isPrune();
    }

    /** The root, Direction, or Depth changed. Subclasses re-root here. */
    protected rootingChanged(): void {
        // Default: no-op. Overridden by subclasses.
    }

    /** The prune checkbox changed. Subclasses re-filter here. */
    protected pruneChanged(): void {
        // Default: no-op. Overridden by subclasses.
    }

    // The selector's own gesture: adopt the root, then move the viewport.
    private chooseRoot(root: string | null): void {
        this.setRoot(root);
        this.settleViewport();
    }

    /**
     * Re-centres the viewport on the root once the re-derivation's `setData`
     * has placed the new graph — the root when there is one, the whole graph's
     * bounds otherwise.
     *
     * Called after every control gesture, not just the root selector's, because
     * ELK re-lays a graph out from scratch and hands back fresh coordinates:
     * keeping the old pan across a Depth or Direction change leaves the view
     * pointing wherever those new coordinates happen to fall, which reads as the
     * diagram jumping. Re-centring on the root discards any panning the user had
     * done, which is the deliberate trade — a predictable anchor beats a
     * preserved offset that no longer means anything.
     *
     * Waits for `whenLaidOut` rather than acting synchronously: node ids are
     * stable across a re-derivation, so a synchronous call would target the
     * graph `setData` has just started replacing and spend the one-shot centring
     * on it. Re-checks the settle target afterwards, because `whenLaidOut`'s
     * promise is shared across passes and the user may have changed a control
     * (or, for `DatabaseDiagramPanel`, the Mode) again meanwhile.
     */
    protected settleViewport(): void {
        const target = this.state.settle();

        void this.view.whenLaidOut().then(() => {
            if (!sameSettle(this.state.settle(), target)) {
                return; // a control moved again while the layout ran
            }

            if (target.kind === "fit") {
                this.view.zoomToFit();
            } else {
                this.view.focusNode(target.nodeId);
            }
        });
    }

    // The selector row and the legend follow "is this a rooted view at all";
    // the traversal block additionally needs a root to act on.
    private applyRootVisibility(): void {
        const visibility = this.state.visibility();

        this.rootRow?.setDisplayed(visibility.rootRow);
        this.legend.setDisplayed(visibility.legend);
        this.rootedBlock.setDisplayed(visibility.rootedBlock);
    }
}

const DiagramShellCallable = callable(DiagramShell);
type DiagramShellCallable = DiagramShell;
export { DiagramShellCallable as DiagramShell };
