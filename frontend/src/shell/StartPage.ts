// The empty-workspace start page — an app-owned welcome surface shown in the
// shell's CENTER (a Card deck alongside the Dock) whenever no dock panels are
// open. The controller toggles this deck off the Dock's "emptychange" event, so
// no panel bookkeeping lives here; the page itself is a plain composed Panel laid
// out as a two-column "home", with no page-level heading of its own — the
// AppHeader brand strip above the menu bar already names the app, so repeating
// "SQLAdmin" here would be redundant. The left column stacks two panels — the
// welcome blurb (shown only on an empty workspace) above the quick actions /
// recent tables / saved queries panel; the right column holds only the
// keyboard-shortcut legend. Both columns render at their own fixed natural
// width (COLUMN_MAX_WIDTH is a safety ceiling, not a target) and are
// left-anchored — neither carries HBox weight, so neither a viewport resize
// nor the user dragging the shell's navigator-rail gutter
// (SqlAdminShell.ts's buildWorkArea) changes their width. A third, empty
// flex `Spacer` column is this row's only weighted child, so it alone
// absorbs whatever width the two fixed columns leave over (see
// buildColumns). That isn't just cosmetic: without an actually-unbounded
// weighted child here, the row's own reported max width would be bounded by
// the two capped columns, which `Card.getMaxSize()` (this page lives in the
// shell's CENTER Card deck) forwards straight to the Split's CENTER pane —
// and `Split.onDrag` clamps the dragged pane's floor to
// `total − partnerMax`, so with a bounded CENTER max, so much as touching
// the sidebar gutter snaps the navigator rail open to whatever floor that
// arithmetic works out to (reproducible by dragging the gutter with this
// spacer removed — it isn't just a passive-resize issue). The
// always-unbounded spacer keeps this row's, and so the CENTER pane's, max
// width unbounded, which keeps any slack here where it's invisible instead
// of leaking into the rail on touch. It rebuilds on the controller's
// onWorkspaceChanged seam so the recent/saved lists stay current.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the page `extends Panel`
// directly, so the instance itself is the mountable component. `id` and
// `autoScroll` must both land in the single `super({...})` options object,
// with `id` first — `autoScroll` registers its eased wheel-scroll listener
// under the component's id during the option cascade that runs inside
// super(), and a later `setId`/`setAutoScroll` would not re-register it (see
// the constructor doc below). `rebuild` and the `welcome` mutable state stay
// constructor-local closures, same as the original factory.

import { Component, Panel, callable } from "@jimka/typescript-ui/core";
import { VBox, HBox, AnchorType }   from "@jimka/typescript-ui/layout";
import { Insets, UNBOUNDED }        from "@jimka/typescript-ui/primitive";
import { Button }                   from "@jimka/typescript-ui/component/button";
import { Spacer }                   from "@jimka/typescript-ui/component/container";
import { Glyph, Markdown }          from "@jimka/typescript-ui/component/display";
import { plus }                     from "@jimka/typescript-ui/glyphs/solid/plus";
import { shouldShowWelcome }        from "./startPageWelcome";
import { buildShortcutLegend }      from "./shortcutLegend";
import type { SavedQuery }          from "../data/queryStore";
import type { SqlAdminController }  from "../SqlAdminController";
import { mutedHeading }             from "./mutedText";

Glyph.register(plus);

// Padding around the welcome content, the vertical gap between stacked entries,
// the horizontal gap between the two columns, and the fixed height of each action
// button — comfortable click targets that read as a "jump back in" list with a
// little more breathing room than the denser Queries-view lists. COLUMN_SPACING
// is wider than the vertical ENTRY_SPACING so the two columns read as distinct
// panes rather than one run-together block.
const PAGE_PADDING = 24;
const ENTRY_SPACING = 6;
const COLUMN_SPACING = 32;
const BUTTON_HEIGHT = 30;

// The fixed width of each content column: min and max width are both pinned
// to this one value, clamping the column's own content-driven preferred
// width up or down to exactly 350px regardless of what its content would
// otherwise ask for — height is deliberately left alone (unlike a Border
// layout's WEST region, this HBox's itemAlign isn't `"stretch"`, so an explicit
// `preferredSize.height` here would be taken literally and collapse the
// column instead of being ignored). Neither column ever grows or shrinks —
// only the trailing flex Spacer in buildColumns responds to available width.
// See the file-header comment for why that matters beyond this page's own
// look.
const COLUMN_WIDTH = 350;

// The empty-workspace welcome blurb, shown above the quick actions only when
// there are no recent tables and no saved queries (see shouldShowWelcome).
const GETTING_STARTED_MARKDOWN = `## Getting started

Your workspace is empty. Open a new query or pick a table from the sidebar
to begin — your **recent tables** and **saved queries** collect here as you
work.

- **New Query** — open a blank SQL editor
- Click a table in the sidebar to inspect its structure and data
- Save a query to pin it to this page`;

/**
 * The start page shown when the workspace has no open panels.
 */
class StartPage extends Panel {
    /**
     * @param controller - The mediator supplying the quick actions and stored lists.
     * @param id - The CENTER Card-deck page id. It MUST be set here, in the
     *   `super(...)` options object, rather than via a later `setId`:
     *   `autoScroll` registers the eased wheel-scroll listener under the
     *   component's id at construction, and `setId` re-points the DOM id
     *   without re-registering that listener — so a post-construction `setId`
     *   would leave the page scrolling natively (not smoothly) because the
     *   wheel listener no longer matches the element's id.
     */
    constructor(controller: SqlAdminController, id: string) {
        super({
            // Set before autoScroll (applyOptions dispatches id first) so the
            // eased wheel-scroll listener registers under this id — see the
            // `id` param doc.
            id,
            layoutManager: new VBox({ itemAlign: "stretch", spacing: ENTRY_SPACING }),
            // The page is the bounded scroll host (the CENTER card sizes it to
            // the viewport): autoScroll — not `overflow`, which only clips —
            // mounts a scrollbar so a short viewport scrolls the whole home
            // rather than clipping the shortcut legend below the fold.
            autoScroll: "y",
        });

        this.setInsets(new Insets(PAGE_PADDING, PAGE_PADDING, PAGE_PADDING, PAGE_PADDING));

        // The whole body is rebuilt each time the workspace toggles between
        // empty and non-empty (recent tables / saved queries need to stay
        // current). removeAllComponents() detaches the previous body from the
        // DOM but does not call dispose() on it — every child (theme listeners,
        // per-instance stylesheet rules) must be disposed explicitly first, or
        // the previous rebuild's whole subtree leaks on every toggle. This has
        // to stay app-side: removeComponent/removeAllComponents are
        // deliberately detach-only (Component.addComponent's own re-parent
        // carry depends on that), so the library cannot safely dispose here
        // for us. typescript-ui plan `dispose-all-components` adds a
        // dispose-then-remove convenience method for exactly this case — once
        // it ships, replace the loop below with that single call. A
        // constructor-local closure captures `this` lexically, so passing
        // `rebuild` to `controller.workspace.onWorkspaceChanged` below is safe without an
        // arrow-function field.
        const rebuild = (): void => {
            // Manual stand-in for the library's future disposeAllComponents()
            // (see the comment above) — dispose every current child before
            // detaching, since removeAllComponents() alone only detaches.
            for (const component of this.getComponents()) {
                component.dispose();
            }

            this.removeAllComponents();

            this.addComponent(buildColumns(controller));

            this.doLayout();
        };

        controller.workspace.onWorkspaceChanged(rebuild);
        rebuild();
    }
}

/**
 * Build the page body: quick actions and stored lists on the left, the
 * shortcut legend on the right, and a trailing empty flex `Spacer` column.
 * The two content columns are fixed-width — pinned to the row's top edge
 * (`anchor: NORTH`) at exactly `COLUMN_WIDTH` — and carry no HBox weight, so
 * neither a viewport resize nor a navigator-rail gutter drag changes them;
 * the spacer is this row's only weighted child, so it alone grows or shrinks
 * to fill whatever the row doesn't need. The spacer's own `minSize` is
 * pinned to zero so it can shrink away entirely on a narrow window instead
 * of forcing the row wider than its two fixed columns need. Keeping the
 * spacer's max width unbounded also keeps this row's (and so the page's)
 * reported max width unbounded — see the file-header comment for why a
 * bounded max width here would leak into the shell's navigator rail the
 * moment its gutter is touched, not just on a passive resize.
 *
 * The explicit anchor on the content columns matters because this HBox's
 * `itemAlign` isn't `"stretch"`, so absent one, `BoxLayout` falls back to baseline alignment:
 * it centres a null-baseline child within the row's text-line band instead of
 * placing it at the top. The right column reports a real baseline (its first
 * child, the shortcut legend, is Text-bearing) while the left column's first
 * child — the welcome Markdown, or the New Query button when the blurb is
 * hidden — does not always, so the two columns could drift out of alignment
 * with each other depending on which is shown. `anchor: NORTH` sidesteps
 * baseline guessing entirely for both; the spacer carries no content, so its
 * anchor is moot.
 *
 * @param controller - Supplies the quick actions and stored lists.
 *
 * @returns The columns container.
 */
function buildColumns(controller: SqlAdminController): Component {
    const columns = Panel({ layoutManager: new HBox({ spacing: COLUMN_SPACING }) });

    columns.addComponent(buildLeftColumn(controller), { anchor: AnchorType.NORTH });
    columns.addComponent(buildRightColumn(), { anchor: AnchorType.NORTH });

    const spacer = Spacer.flex();
    spacer.setMinSize({ width: 0, height: 0 });
    columns.addComponent(spacer);

    return columns;
}

/**
 * Build the left column: the welcome blurb (only on an empty workspace) above
 * the quick actions panel, stacked in the column's own VBox.
 *
 * @param controller - Supplies the quick actions and stored lists.
 *
 * @returns The left column panel.
 */
function buildLeftColumn(controller: SqlAdminController): Panel {
    const column = Panel({
        layoutManager: new VBox({ itemAlign: "stretch", spacing: ENTRY_SPACING }),
        minSize      : { width: COLUMN_WIDTH, height: 0 },
        maxSize      : { width: COLUMN_WIDTH, height: UNBOUNDED },
    });

    if (shouldShowWelcome(controller.workspace)) {
        column.addComponent(Markdown(GETTING_STARTED_MARKDOWN));
    }

    column.addComponent(buildQuickActions(controller));

    return column;
}

/**
 * Build the quick actions panel: the New Query action over the Recent tables
 * and Saved queries lists (each hidden while empty).
 *
 * @param controller - Supplies the quick actions and stored lists.
 *
 * @returns The quick actions panel.
 */
function buildQuickActions(controller: SqlAdminController): Panel {
    const panel = Panel({ layoutManager: new VBox({ itemAlign: "stretch", spacing: ENTRY_SPACING }) });

    panel.addComponent(actionButton("New Query", () => controller.workspace.openQuery(), "plus"));

    appendList(panel, "Recent tables", controller.workspace.recentTables(),
        ref => actionButton(ref.name ?? "(table)", () => controller.reopenTable(ref)));
    appendList(panel, "Saved queries", controller.workspace.savedList(),
        (q: SavedQuery) => actionButton(q.name, () => controller.workspace.openSavedQuery(q.name)));

    return panel;
}

/**
 * Build the right column: the keyboard-shortcut legend.
 *
 * @returns The right column panel.
 */
function buildRightColumn(): Panel {
    const column = Panel({
        layoutManager: new VBox({ itemAlign: "stretch", spacing: ENTRY_SPACING }),
        minSize      : { width: COLUMN_WIDTH, height: 0 },
        maxSize      : { width: COLUMN_WIDTH, height: UNBOUNDED },
    });

    column.addComponent(buildShortcutLegend());

    return column;
}

/**
 * Append a titled list section, or nothing when the list is empty (the start
 * page stays uncluttered before anything has been opened or saved).
 *
 * @param host - The page panel to append into.
 * @param title - The section header text.
 * @param items - The section's items.
 * @param rowFor - Builds a button for one item.
 */
function appendList<T>(
    host: Panel,
    title: string,
    items: T[],
    rowFor: (item: T) => Component,
): void {
    if (items.length === 0) {
        return;
    }

    host.addComponent(mutedHeading(title));

    for (const item of items) {
        host.addComponent(rowFor(item));
    }
}

/**
 * A fixed-height, full-width quick-action button.
 *
 * @param text - The button label.
 * @param handler - The click action.
 * @param glyph - Optional leading glyph (registered name).
 *
 * @returns The button component.
 */
function actionButton(text: string, handler: () => void, glyph?: string): Component {
    const button = Button({ glyph, text, compact: true, preferredSize: { width: 0, height: BUTTON_HEIGHT } });
    button.on("action", handler);

    return button;
}

const StartPageCallable = callable(StartPage);
type StartPageCallable = StartPage;
export { StartPageCallable as StartPage };
