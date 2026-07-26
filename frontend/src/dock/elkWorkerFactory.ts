/**
 * Shared ELK Web-Worker factory for every diagram panel. Passed to
 * DiagramView's `elkWorkerFactory` option so ELK layout runs off the main
 * thread. `type: "classic"` is required — elk-worker.min.js is a classic
 * browserify script; a module worker would fail to load. Vite statically
 * resolves the `new URL(..., import.meta.url)` specifier and emits the worker
 * asset from the app's own elkjs install.
 */
export const elkWorkerFactory = (): Worker =>
    new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "classic" });
