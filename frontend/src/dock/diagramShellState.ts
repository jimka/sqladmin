// The DOM-free root / direction / depth / prune state a DiagramShell drives
// its controls from, plus the two questions the shell asks of it: which WEST
// column blocks are on screen, and what the viewport should do once the next
// layout pass lands. Kept out of diagramShell.ts (which owns the actual
// controls and imports ComboBox, Checkbox, and the library's Panel at module
// scope — touching `document` on import and unloadable under this project's
// node-environment vitest) so this state machine can be unit-tested under the
// node harness — mirroring depthChoices.ts's own DOM-free split (see that
// module's header) and recordNavigation.ts's split out of TableWorkPanel.ts.

import type { TraversalDirection } from "../data/relationDiagram";
import { depthChoice, depthFromChoice } from "./depthChoices";

/** What the viewport should do once the layout pass lands. */
export type ViewportSettle =
    | { kind: "fit" }
    | { kind: "focus"; nodeId: string };

/** Which of the shell's three WEST column blocks are on screen. */
export interface ColumnVisibility {
    rootRow: boolean;
    legend: boolean;
    rootedBlock: boolean;
}

/**
 * Whether two settles name the same viewport move.
 *
 * @param a - The first settle.
 * @param b - The second settle.
 * @returns True when both fit, or both focus the same node id.
 */
export function sameSettle(a: ViewportSettle, b: ViewportSettle): boolean {
    if (a.kind === "fit" || b.kind === "fit") {
        return a.kind === b.kind;
    }

    return a.nodeId === b.nodeId;
}

/**
 * The DOM-free root / direction / depth / prune state a DiagramShell drives
 * its controls from. Seeded at construction and mutated only through its own
 * setters, so `DiagramShell` never touches these fields directly.
 */
export class DiagramShellState {
    private root: string | null;
    private direction: TraversalDirection = "both";
    /** A `DEPTH_CHOICES` entry, seeded via `depthChoice` so it is always valid. */
    private depth: string;
    private prune = false;
    /** False while the panel is not showing a rooted graph at all (Overview mode). */
    private rootingDisplayed = true;

    /**
     * @param root - The root to open at, or null for the whole graph.
     * @param initialDepth - The `DEPTH_CHOICES` entry the Depth control opens
     *   at; anything unrecognized normalizes to the default via `depthChoice`.
     */
    constructor(root: string | null, initialDepth?: string) {
        this.root = root;
        this.depth = depthChoice(initialDepth);
    }

    /**
     * The chosen root's node id, or null while the whole graph is shown.
     *
     * @returns The current root id, or null.
     */
    getRoot(): string | null {
        return this.root;
    }

    /**
     * Adopt a root.
     *
     * @param root - The root to adopt, or null for the whole graph.
     */
    setRoot(root: string | null): void {
        this.root = root;
    }

    /**
     * The Direction control's current value.
     *
     * @returns The current traversal direction.
     */
    getDirection(): TraversalDirection {
        return this.direction;
    }

    /**
     * Adopt a traversal direction.
     *
     * @param direction - The direction to adopt.
     */
    setDirection(direction: TraversalDirection): void {
        this.direction = direction;
    }

    /**
     * The `DEPTH_CHOICES` entry the Depth control shows.
     *
     * @returns The current depth choice.
     */
    getDepthChoice(): string {
        return this.depth;
    }

    /**
     * Adopt a depth choice, normalized through `depthChoice` — an
     * unrecognized value falls to the default.
     *
     * @param choice - The raw choice (a `DEPTH_CHOICES` entry, or anything else).
     */
    setDepthChoice(choice: string): void {
        this.depth = depthChoice(choice);
    }

    /**
     * The hop limit the current depth choice means.
     *
     * @returns The hop count, or `Number.POSITIVE_INFINITY` for `All`.
     */
    getDepth(): number {
        return depthFromChoice(this.depth);
    }

    /**
     * Whether the prune checkbox is ticked.
     *
     * @returns True when hiding a node also prunes what it orphans.
     */
    isPrune(): boolean {
        return this.prune;
    }

    /**
     * Adopt the prune checkbox's value.
     *
     * @param prune - True to also drop nodes orphaned from the root.
     */
    setPrune(prune: boolean): void {
        this.prune = prune;
    }

    /**
     * Whether this panel is showing a rooted graph at all (false in the
     * database diagram's Overview mode).
     *
     * @returns True when a rooted graph is (or could be) on screen.
     */
    isRootingDisplayed(): boolean {
        return this.rootingDisplayed;
    }

    /**
     * Adopt whether a rooted graph is on screen.
     *
     * @param displayed - True to show the rooted column.
     */
    setRootingDisplayed(displayed: boolean): void {
        this.rootingDisplayed = displayed;
    }

    /**
     * Which of the shell's three WEST column blocks are on screen. The
     * selector row and the legend follow "is this a rooted view at all"; the
     * traversal block additionally needs a root to act on.
     *
     * @returns The current column visibility.
     */
    visibility(): ColumnVisibility {
        return {
            rootRow    : this.rootingDisplayed,
            legend     : this.rootingDisplayed,
            rootedBlock: this.rootingDisplayed && this.root !== null,
        };
    }

    /**
     * What the viewport should do once the layout pass lands: focus the root
     * when a rooted graph is actually on screen, else fit the whole graph.
     * Reading `rootingDisplayed` (not just the raw root) is what makes the
     * database diagram's Overview mode fit instead of focusing a root that
     * Overview never draws.
     *
     * @returns The settle this state currently implies.
     */
    settle(): ViewportSettle {
        return this.rootingDisplayed && this.root !== null
            ? { kind: "focus", nodeId: this.root }
            : { kind: "fit" };
    }
}
