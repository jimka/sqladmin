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
import type { BundlingStrategy } from "../data/edgeRouteStubs";
import { stubBundledEdgeRoutes, stubGeometry } from "../data/edgeRouteStubs";
import type { BundlingMetrics } from "../data/edgeBundleMetrics";
import { bundlingMetrics } from "../data/edgeBundleMetrics";
import { elkWorkerFactory } from "./elkWorkerFactory";

// Resolved here rather than inside edgeRouteStubs: this module already imports
// the diagram barrel at runtime, while that one must not — its modules touch
// `document` at import scope, and the transform stays pure so the app's
// DOM-less vitest can exercise it.
const STUB_GEOMETRY = stubGeometry(EDGE_MARKER_EXTENT);

/** The raw ELK result cached for a re-rewrite, with the inputs it was computed from. */
interface CachedLayout {
    data: DiagramData;
    defaults: Record<string, string> | undefined;
    result: DiagramLayoutResult;
}

/** An ElkLayoutEngine whose result is passed through {@link stubBundledEdgeRoutes} before returning. */
class JunctionLayoutEngine extends ElkLayoutEngine {
    /** Which shape bundles take. Written by the view when the user picks another. */
    strategy: BundlingStrategy = "junction";

    /** The metrics of the most recent rewrite, or null before the first layout. */
    metrics: BundlingMetrics | null = null;

    /**
     * The last raw (un-rewritten) ELK result, so switching strategy re-runs only
     * the rewrite. Node sizes are derived from `data` alone, so the same `data`
     * and `defaults` must produce the same raw result — which makes reference
     * identity a sound cache key. Without it every switch would re-run ELK over
     * the whole graph, seconds of wait between the two pictures being compared.
     */
    private _cached: CachedLayout | null = null;

    /**
     * Runs the base engine's layout — or reuses the cached raw result when the
     * same graph is laid out again — then rewrites the routes via
     * {@link stubBundledEdgeRoutes} and records the comparison metrics.
     *
     * @param data - The framework-native graph (for port lookups).
     * @param sizes - Per-node resolved sizes, passed straight through.
     * @param defaults - View-level default ELK options, passed straight through.
     * @returns The bundled layout result.
     */
    async layout(
        data: DiagramData,
        sizes: Map<string, { width: number; height: number }>,
        defaults?: Record<string, string>,
    ): Promise<DiagramLayoutResult> {
        const reusable = this._cached !== null && this._cached.data === data && this._cached.defaults === defaults;
        const raw      = reusable ? this._cached!.result : await super.layout(data, sizes, defaults);

        this._cached = { data, defaults, result: raw };

        const bundled = stubBundledEdgeRoutes(data, raw, STUB_GEOMETRY, { strategy: this.strategy });

        this.metrics = bundlingMetrics(bundled);

        return bundled;
    }

    /** Drops the cached result before the base engine tears its worker down. */
    dispose(): void {
        this._cached = null;

        super.dispose();
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
     * The engine `createEngine()` built, kept so the bundling strategy can be
     * switched after construction. Declared with `declare` rather than an `=`
     * initializer per COMPONENT_CONVENTIONS (b): `createEngine()` writes it
     * during `super()`, and an initializer would run afterwards and clobber it.
     */
    private declare _junctionEngine: JunctionLayoutEngine;

    /**
     * Builds the stubbing layout engine. A plain prototype method, not an
     * arrow field: `DiagramView`'s constructor calls `createEngine()` during
     * its own `super()` cascade, before any arrow-field initializer of this
     * class would have run — so this override must read nothing off `this`,
     * which is why the worker factory comes from the shared module rather
     * than from the view's own options (COMPONENT_CONVENTIONS (b), the
     * super-cascade trap, in a new place). It only *writes* `this`, which is
     * safe during the cascade and is how the engine is kept reachable.
     */
    protected createEngine(): ElkLayoutEngine {
        this._junctionEngine = new JunctionLayoutEngine({ workerFactory: elkWorkerFactory });

        return this._junctionEngine;
    }

    /**
     * Re-bundles the current graph under another strategy. The raw ELK result
     * is cached, so this re-runs only the rewrite — node positions and graph
     * bounds are identical across strategies, which is what lets the viewport
     * stay put while the pictures are compared.
     *
     * @param strategy - The shape bundles should take.
     * @returns This view, for method chaining.
     */
    setBundlingStrategy(strategy: BundlingStrategy): this {
        if (this._junctionEngine.strategy === strategy) {
            return this;
        }

        this._junctionEngine.strategy = strategy;

        const data = this.getData();

        if (data !== null) {
            this.setData(data);
        }

        return this;
    }

    /**
     * The strategy bundles are currently drawn with.
     *
     * @returns The current strategy.
     */
    getBundlingStrategy(): BundlingStrategy {
        return this._junctionEngine.strategy;
    }

    /**
     * The metrics of the most recent bundling pass.
     *
     * @returns The metrics, or null before the first layout has finished.
     */
    getBundlingMetrics(): BundlingMetrics | null {
        return this._junctionEngine.metrics;
    }
}

// Callable-class export per COMPONENT_CONVENTIONS (d): call sites may write
// `JunctionDiagramView({ ... })` with no `new`, and may `extends` it.
const JunctionDiagramViewCallable = callable(JunctionDiagramView);
type JunctionDiagramViewCallable = JunctionDiagramView;
export { JunctionDiagramViewCallable as JunctionDiagramView };
