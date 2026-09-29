// The Save / Save-as decisions for a query panel, pulled out into a pure
// module so they are node-testable: the flow takes its store, name prompt,
// and replace confirm as injected dependencies and imports no library code,
// only a type from queryStore.ts. This follows closeRequestBatcher.ts and
// dirtyTabMarker.ts, which the controller keeps free of library imports so
// the node vitest can load them without a DOM. QueryWorkspace builds the real
// QuerySaveDeps once, in its constructor, and QueryPanel stays a pure view
// that only calls the callbacks these functions end up behind.

import type { SavedQuery } from "../data/queryStore";

/** The saved-query store surface the flow needs; `SavedQueryStore` satisfies it. */
export interface SavedQueryTarget {
    get(name: string): SavedQuery | undefined;
    save(name: string, sql: string): void;
}

/** The side effects the save flow needs, injected so the flow is node-testable. */
export interface QuerySaveDeps {
    /** The saved-query store. */
    store: SavedQueryTarget;
    /** Ask for a name, prefilled with `defaultName`; `null` abandons. */
    promptName: (defaultName: string) => Promise<string | null>;
    /** Ask whether to replace the existing saved query `name`. */
    confirmReplace: (name: string) => Promise<boolean>;
}

/**
 * Save to `linkedName` when it still exists, else fall through to
 * {@link saveQueryAs} (a missing link — no name, or a name whose saved query
 * was removed — has nothing to overwrite).
 *
 * @param deps - The injected store, prompt, and confirm.
 * @param sql - The SQL to save.
 * @param linkedName - The saved query this tab is linked to, or `null` when unlinked.
 *
 * @returns The name the SQL was saved under, or `null` when nothing was saved.
 */
export async function saveQuery(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null> {
    const linked = linkedName === null ? undefined : deps.store.get(linkedName);

    if (linked === undefined) {
        return saveQueryAs(deps, sql, linkedName);
    }

    deps.store.save(linked.name, sql);

    return linked.name;
}

/**
 * Prompt for a name, confirm before replacing a *different* saved query, then
 * save. Declining the replace confirm returns to the name prompt, prefilled
 * with the declined name; cancelling the name prompt ends the flow with
 * nothing saved.
 *
 * @param deps - The injected store, prompt, and confirm.
 * @param sql - The SQL to save.
 * @param linkedName - The saved query this tab is linked to, or `null` when unlinked
 *   (entering the tab's own linked name never counts as "replacing another query").
 *
 * @returns The name the SQL was saved under, or `null` when nothing was saved.
 */
export async function saveQueryAs(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null> {
    let defaultName = linkedName ?? "";

    for (;;) {
        const name = await deps.promptName(defaultName);

        if (name === null) {
            return null;
        }

        const replacesOther = name !== linkedName && deps.store.get(name) !== undefined;
        const confirmed     = !replacesOther || await deps.confirmReplace(name);

        if (confirmed) {
            deps.store.save(name, sql);

            return name;
        }

        defaultName = name;
    }
}
