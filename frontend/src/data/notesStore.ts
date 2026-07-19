// The per-user-and-connection localStorage layer for the documentation/notes
// panel: a single Markdown string, pure over an injected `KeyValueStore`
// (production passes window.localStorage; the node vitest passes an in-memory
// fake), so the load/save logic is red-green testable offline without a DOM.
// Notes document a specific database, so — like saved queries — the key is
// scoped to both the user and the connection (`<user>.<connection>`). Kept
// separate from queryStore.ts (the query workspace) since notes are not a query
// concept.

import type { KeyValueStore } from "./queryStore";

// localStorage key prefix, namespaced per user AND connection ("<user>.<conn>")
// under the app's sqladmin.* namespace so "Clear SQL Admin data" removes it with
// the query keys, and the localStorage inspector already dumps it.
const NOTES_KEY_PREFIX = "sqladmin.notes.";

/** Per-user, per-connection single-string notes store (raw Markdown, no JSON wrapper). */
export class NotesStore {
    private readonly _key: string;
    private readonly _storage: KeyValueStore;

    /**
     * @param userId - Namespaces the storage key so users stay isolated.
     * @param connectionId - Namespaces the storage key so connections stay isolated.
     * @param storage - The backing key-value store (localStorage or a fake).
     */
    constructor(userId: string, connectionId: string, storage: KeyValueStore) {
        this._key     = `${NOTES_KEY_PREFIX}${userId}.${connectionId}`;
        this._storage = storage;
    }

    /**
     * @returns The saved Markdown, or `""` when never saved.
     */
    load(): string {
        return this._storage.getItem(this._key) ?? "";
    }

    /**
     * Persist the Markdown string, overwriting any previous value.
     *
     * @param markdown - The Markdown to store.
     */
    save(markdown: string): void {
        this._storage.setItem(this._key, markdown);
    }
}
