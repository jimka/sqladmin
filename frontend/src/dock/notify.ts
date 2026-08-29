// The status-line reporter every panel and menu builder takes to surface a
// one-line result (a save, an export, an import) without owning its own
// status UI.

/** Reports a one-line status message to whatever surface is showing it. */
export type Notify = (message: string) => void;
