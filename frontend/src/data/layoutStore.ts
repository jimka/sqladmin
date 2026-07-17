// Global (not per-connection) localStorage layer for the app's `Split` gutter
// positions and `Accordion` section open/collapsed state, one key per layout
// site. Unlike NotesStore/QueryHistoryStore/SavedQueryStore, layout is a
// property of the user's window, not of the database being viewed, so no
// `connectionId` segment is in the key.
//
// The app and the library split the restore validation: the library owns
// *fit* (exact length, per-index unit against the live layout, finite
// non-negative values) at every restore entry point (`paneSizes`,
// `applyPaneSizes`, `sectionSizes`, `applySectionSizes`), discarding a
// stale array whole. This store owns only *shape* — that what it hands back
// is a genuine array of well-formed `LayoutSize` entries, since a non-array
// is the one garbage shape the library's `.every()`-based check does not
// absorb. See `plans/implemented/layout-persistence.md` for the full
// rationale.

import type { LayoutSize, LayoutSizeUnit } from "@jimka/typescript-ui/layout";
import type { KeyValueStore }              from "./queryStore";

// localStorage key prefix. Global (no connection segment) but still under the
// app's sqladmin.* namespace so localStorageWindow.ts's APP_KEY_PREFIX dumps
// and clears these keys with no code change.
const LAYOUT_KEY_PREFIX = "sqladmin.layout.";

/** A persisted Split site. The string is the key segment under `sqladmin.layout.`. */
export type SplitSite = "shell" | "query" | "definition";

/** A persisted Accordion site. The string is the key segment under `sqladmin.layout.`. */
export type AccordionSite = "database" | "roles" | "queries" | "structure" | "explainDiagram";

// Default open flags per Accordion site, in section order; the array length is
// also the site's section count. These mirror the `initiallyOpen` literals the
// sites carried before this store existed — keep them in step when a site's
// `sections:` array changes.
//
// There is deliberately no matching table for Split pane counts: the library
// validates a saved array's length AND its per-index units against the live
// layout and discards it whole, so an app-side length check would be a partial
// duplicate of a check it performs completely (see
// `plans/implemented/layout-persistence.md`, `## Architecture Decisions`).
// Open state has no library-side validation, which is why this table exists.
//
//   database/roles -> tree | inspector                      (shell/treeExplorerView.ts)
//   queries        -> Saved | Recent                        (shell/QueriesView.ts)
//   structure      -> Columns | Indexes | Constraints | FKs  (dock/StructurePanel.ts)
//   explainDiagram -> Summary | Plan tree | Plan steps       (dock/ExplainDiagramPanel.ts)
const ACCORDION_DEFAULT_OPEN: Record<AccordionSite, boolean[]> = {
    database:       [true, true],
    roles:          [true, true],
    queries:        [true, true],
    structure:      [true, false, false, false],
    explainDiagram: [true, true, false],
};

/** One site's stored blob. Every field optional — a site writes only what it has. */
interface StoredLayout {
    sizes?:     LayoutSize[];
    collapsed?: number[];
    open?:      boolean[];
}

/** One Split site's saved layout plus its save hooks, shaped to wire straight onto Split's events. */
export interface SplitLayoutBinding {
    /** The saved pane sizes, or null when absent, corrupt, or malformed. Read at restore time. */
    loadSizes:     () => LayoutSize[] | null;
    /** The saved collapsed pane indices; `[]` when absent or corrupt. */
    loadCollapsed: () => number[];
    /** Persist the sizes after a completed drag. Wire to `Split`'s `paneresize`. */
    onSizes:       (sizes: LayoutSize[]) => void;
    /** Persist one pane's collapsed flag. Wire to `Split`'s `panecollapse`. */
    onCollapse:    (index: number, collapsed: boolean) => void;
}

/** One Accordion site's saved layout plus its save hooks, shaped to wire straight onto Accordion's events. */
export interface AccordionLayoutBinding {
    /** The saved section sizes, or null when absent, corrupt, or malformed. Meaningful only for a resizable accordion. */
    loadSizes: () => LayoutSize[] | null;
    /** The saved open flags, falling back to the site's defaults. Length always equals the section count. */
    loadOpen:  () => boolean[];
    /** Persist the sizes after a completed gutter drag. Wire to `Accordion`'s `sectionresize`. */
    onSizes:   (sizes: LayoutSize[]) => void;
    /** Persist one section's open flag. Wire to `Accordion`'s `sectiontoggle`. */
    onToggle:  (index: number, open: boolean) => void;
}

/** Whether one parsed entry is a well-formed {@link LayoutSize}. */
function isLayoutSize(value: unknown): value is LayoutSize {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const size = value as { unit?: unknown; value?: unknown };
    const unit = size.unit as LayoutSizeUnit;

    return (unit === "px" || unit === "ratio")
        && typeof size.value === "number"
        && Number.isFinite(size.value)
        && size.value >= 0;
}

/**
 * A saved size array, or null when it is not one.
 *
 * Shape only — deliberately **no length check and no unit expectation**. The
 * library re-validates length, per-index unit, and value on every restore entry
 * point and discards the whole array when it no longer fits the live layout;
 * duplicating half of that here would need a per-site pane-count table to keep
 * in sync and could only ever disagree. What the library does *not* absorb is a
 * non-array (its validator calls `.every()`), so that is exactly what this
 * guards.
 *
 * @param values - The parsed `sizes` field, of unknown shape.
 *
 * @returns The size array, or `null` when absent, corrupt, or malformed.
 */
function readSizes(values: unknown): LayoutSize[] | null {
    if (!Array.isArray(values) || values.length === 0 || !values.every(isLayoutSize)) {
        return null;
    }

    return values.map(size => ({ ...size }));
}

/**
 * The saved open flags, or a copy of `defaults` when absent, corrupt, or the wrong length.
 *
 * @param values - The parsed `open` field, of unknown shape.
 * @param defaults - The site's default open flags, also fixing the expected length.
 *
 * @returns The open flags, always `defaults.length` long.
 */
function readOpen(values: unknown, defaults: boolean[]): boolean[] {
    if (!Array.isArray(values) || values.length !== defaults.length
        || !values.every(v => typeof v === "boolean")) {
        return [...defaults];
    }

    return [...(values as boolean[])];
}

/**
 * The saved collapsed pane indices, dropping any entry that is not a non-negative integer.
 *
 * @param values - The parsed `collapsed` field, of unknown shape.
 *
 * @returns The collapsed indices, `[]` when absent or corrupt.
 */
function readCollapsed(values: unknown): number[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return (values as unknown[]).filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0,
    );
}

/** Global (not per-connection) UI layout persistence, one key per site. */
export class LayoutStore {
    private readonly _storage: KeyValueStore;

    /** @param storage - The backing key-value store (localStorage or a fake). */
    constructor(storage: KeyValueStore) {
        this._storage = storage;
    }

    /**
     * Bind one Split site: loaders plus save hooks shaped to wire straight onto
     * `Split`'s `paneSizes`/`collapsedPanes` options and `paneresize`/`panecollapse` events.
     *
     * @param site - The Split site to bind.
     *
     * @returns The site's binding.
     */
    bindSplit(site: SplitSite): SplitLayoutBinding {
        return {
            loadSizes    : () => readSizes(this._read(site).sizes),
            loadCollapsed: () => readCollapsed(this._read(site).collapsed),
            onSizes      : sizes => this._write(site, { sizes }),
            onCollapse   : (index, collapsed) => this._saveCollapsedPane(site, index, collapsed),
        };
    }

    /**
     * Bind one Accordion site: loaders plus save hooks shaped to wire straight onto
     * `Accordion`'s `sectionSizes` option and `sectionresize`/`sectiontoggle` events.
     *
     * @param site - The Accordion site to bind.
     *
     * @returns The site's binding.
     */
    bindAccordion(site: AccordionSite): AccordionLayoutBinding {
        const defaults = ACCORDION_DEFAULT_OPEN[site];

        return {
            loadSizes: () => readSizes(this._read(site).sizes),
            loadOpen : () => readOpen(this._read(site).open, defaults),
            onSizes  : sizes => this._write(site, { sizes }),
            onToggle : (index, open) => this._saveOpenSection(site, index, open, defaults),
        };
    }

    /**
     * Add or drop one pane index in the site's collapsed set, leaving the others alone.
     *
     * @param site - The Split site.
     * @param index - The pane index that collapsed or expanded.
     * @param collapsed - Whether the pane is now collapsed.
     */
    private _saveCollapsedPane(site: SplitSite, index: number, collapsed: boolean): void {
        if (index < 0) {
            return;
        }

        const current = readCollapsed(this._read(site).collapsed);
        const next    = collapsed
            ? [...new Set([...current, index])].sort((a, b) => a - b)
            : current.filter(i => i !== index);

        this._write(site, { collapsed: next });
    }

    /**
     * Set one section's open flag, leaving the site's other sections alone.
     *
     * @param site - The Accordion site.
     * @param index - The section index that toggled.
     * @param open - Whether the section is now open.
     * @param defaults - The site's default open flags, backing a corrupt/absent read.
     */
    private _saveOpenSection(site: AccordionSite, index: number, open: boolean, defaults: boolean[]): void {
        const next = readOpen(this._read(site).open, defaults);

        if (index < 0 || index >= next.length) {
            return;
        }

        next[index] = open;

        this._write(site, { open: next });
    }

    /**
     * The site's stored blob; `{}` when absent, unparsable, or not a JSON object.
     *
     * @param site - The site key segment.
     *
     * @returns The parsed blob, or `{}`.
     */
    private _read(site: string): StoredLayout {
        const raw = this._storage.getItem(LAYOUT_KEY_PREFIX + site);

        if (raw === null) {
            return {};
        }

        try {
            const parsed: unknown = JSON.parse(raw);

            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? (parsed as StoredLayout)
                : {};
        } catch {
            return {};
        }
    }

    /**
     * Merge `patch` into the site's blob. A corrupt blob repairs itself — `_read` yields `{}`.
     *
     * @param site - The site key segment.
     * @param patch - The fields to merge in.
     */
    private _write(site: string, patch: StoredLayout): void {
        this._storage.setItem(LAYOUT_KEY_PREFIX + site, JSON.stringify({ ...this._read(site), ...patch }));
    }
}
