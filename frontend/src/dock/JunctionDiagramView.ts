// A DiagramView that gives every fan-out/fan-in bundle of portless edges a
// short shared run near the node they share, instead of the long coincident
// trunk ELK's own edge-merging layout option used to produce (see
// plans/implemented/diagram-edge-merge-junctions.md). Installed through
// `DiagramView`'s own documented swappable-engine seam (`createEngine`), so no
// library change is needed: the override builds an `ElkLayoutEngine` subclass
// that runs the library's own layout, then rewrites the returned routes with
// the pure `stubBundledEdgeRoutes` transform.
//
// Every diagram panel except ExplainDiagramPanel (a query plan is a tree, with
// no fan-in to disambiguate) constructs this instead of plain DiagramView.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends the callable
// `DiagramView` directly, per convention (a). `createEngine()` stays a plain
// prototype method, not an arrow field — see the JSDoc below for why.

import { callable } from "@jimka/typescript-ui/core";
import { DiagramView, ElkLayoutEngine, EDGE_MARKER_EXTENT } from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramLayoutResult } from "@jimka/typescript-ui/component/diagram";
import { stubBundledEdgeRoutes, stubGeometry } from "../data/edgeRouteStubs";
import { elkWorkerFactory } from "./elkWorkerFactory";

// Resolved here rather than inside edgeRouteStubs: this module already imports
// the diagram barrel at runtime, while that one must not — its modules touch
// `document` at import scope, and the transform stays pure so the app's
// DOM-less vitest can exercise it.
const STUB_GEOMETRY = stubGeometry(EDGE_MARKER_EXTENT);

/** An ElkLayoutEngine whose result is passed through {@link stubBundledEdgeRoutes} before returning. */
class JunctionLayoutEngine extends ElkLayoutEngine {
    /**
     * Runs the base engine's layout, then rewrites the result's routes via
     * {@link stubBundledEdgeRoutes}.
     *
     * @param data - The framework-native graph (for port lookups).
     * @param sizes - Per-node resolved sizes, passed straight through.
     * @param defaults - View-level default ELK options, passed straight through.
     * @returns The stubbed layout result.
     */
    async layout(
        data: DiagramData,
        sizes: Map<string, { width: number; height: number }>,
        defaults?: Record<string, string>,
    ): Promise<DiagramLayoutResult> {
        return stubBundledEdgeRoutes(data, await super.layout(data, sizes, defaults), STUB_GEOMETRY);
    }
}

/**
 * A `DiagramView` whose layout engine stubs bundled edge routes. Every
 * construction option and event is identical to `DiagramView` EXCEPT
 * `elkWorkerFactory` / `elkWorkerUrl`: `createEngine()` below always builds
 * its engine against the shared `elkWorkerFactory` module (it cannot read
 * `this._options` — see that method's own JSDoc), so those two options are
 * silently ignored on a `JunctionDiagramView`. Every call site that
 * constructs one has had them removed from its option bag accordingly.
 */
class JunctionDiagramView extends DiagramView {
    /**
     * Builds the stubbing layout engine. A plain prototype method, not an
     * arrow field: `DiagramView`'s constructor calls `createEngine()` during
     * its own `super()` cascade, before any arrow-field initializer of this
     * class would have run — so this override must read nothing off `this`,
     * which is why the worker factory comes from the shared module rather
     * than from the view's own options (COMPONENT_CONVENTIONS (b), the
     * super-cascade trap, in a new place).
     */
    protected createEngine(): ElkLayoutEngine {
        return new JunctionLayoutEngine({ workerFactory: elkWorkerFactory });
    }
}

// Callable-class export per COMPONENT_CONVENTIONS (d): call sites may write
// `JunctionDiagramView({ ... })` with no `new`, and may `extends` it.
const JunctionDiagramViewCallable = callable(JunctionDiagramView);
type JunctionDiagramViewCallable = JunctionDiagramView;
export { JunctionDiagramViewCallable as JunctionDiagramView };
