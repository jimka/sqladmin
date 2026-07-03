// The per-connection localStorage layer for the query workspace: a capped ring
// buffer of run history and a named-query store. Both are pure over an injected
// `KeyValueStore` (production passes window.localStorage; the node vitest passes
// an in-memory fake), so the ring-buffer/upsert logic is red-green testable
// offline without a DOM. The `HistoryEntry`/record/list interface is the seam a
// future backend-persisted history can back without touching the panel or the
// controller.

/**
 * A Storage-like sink — the `getItem`/`setItem` subset the stores use. Production
 * passes `window.localStorage`; tests pass a trivial in-memory fake.
 */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** One recorded query run. */
export interface HistoryEntry {
    /** The SQL that ran. */
    sql: string;
    /** `Date.now()` at the run. */
    timestamp: number;
    /** Whether the run succeeded. */
    ok: boolean;
    /** Rows returned (0 for status/DDL statements or errors). */
    rowCount: number;
}

/** One named, saved query. */
export interface SavedQuery {
    /** The user-given name (the upsert key). */
    name: string;
    /** The saved SQL. */
    sql: string;
    /** `Date.now()` at the save. */
    savedAt: number;
}

// The history ring buffer's default cap. 100 keeps recall useful while bounding
// the localStorage payload; a caller may override it (the tests use a tiny cap
// to exercise overflow).
const MAX_HISTORY = 100;

// localStorage key prefixes, namespaced per connection so two connections never
// cross-read (the app's multi-database seam; today the id is always "default").
const HISTORY_KEY_PREFIX = "sqladmin.history.";
const SAVED_KEY_PREFIX   = "sqladmin.saved.";

/**
 * Read and JSON-parse a stored array, returning `[]` on an absent or malformed
 * value so a corrupt localStorage entry can never throw into the UI.
 *
 * @param storage - The backing key-value store.
 * @param key - The full storage key to read.
 *
 * @returns The parsed array, or `[]` when absent, unparsable, or not an array.
 */
function readArray<T>(storage: KeyValueStore, key: string): T[] {
    const raw = storage.getItem(key);

    if (raw === null) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);

        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

/** Per-connection capped ring buffer of run history (stored and returned newest-first). */
export class QueryHistoryStore {
    private readonly _key: string;
    private readonly _storage: KeyValueStore;
    private readonly _max: number;

    /**
     * @param connectionId - Namespaces the storage key so connections stay isolated.
     * @param storage - The backing key-value store (localStorage or a fake).
     * @param max - The ring-buffer cap; defaults to {@link MAX_HISTORY}.
     */
    constructor(connectionId: string, storage: KeyValueStore, max: number = MAX_HISTORY) {
        this._key     = HISTORY_KEY_PREFIX + connectionId;
        this._storage = storage;
        this._max     = max;
    }

    /**
     * Record a run: move it to the head. Any earlier entry with the identical
     * `sql` — whether the current head (a consecutive re-run) or an older one
     * (re-running a query recalled from further back) — is removed first, so a
     * verbatim repeat is promoted to the head with fresh metadata rather than
     * leaving a stale duplicate behind. Then cap to `max`, dropping the oldest,
     * and persist.
     *
     * @param entry - The run to record.
     */
    record(entry: HistoryEntry): void {
        const list     = this.list();
        const existing = list.findIndex(e => e.sql === entry.sql);

        if (existing >= 0) {
            list.splice(existing, 1);
        }

        list.unshift(entry);

        const capped = list.slice(0, this._max);
        this._storage.setItem(this._key, JSON.stringify(capped));
    }

    /**
     * @returns The recorded runs, newest-first.
     */
    list(): HistoryEntry[] {
        return readArray<HistoryEntry>(this._storage, this._key);
    }

    /** Drop all recorded history for this connection. */
    clear(): void {
        this._storage.setItem(this._key, JSON.stringify([]));
    }
}

/** Per-connection named-query store (upsert by name). */
export class SavedQueryStore {
    private readonly _key: string;
    private readonly _storage: KeyValueStore;

    /**
     * @param connectionId - Namespaces the storage key so connections stay isolated.
     * @param storage - The backing key-value store (localStorage or a fake).
     */
    constructor(connectionId: string, storage: KeyValueStore) {
        this._key     = SAVED_KEY_PREFIX + connectionId;
        this._storage = storage;
    }

    /**
     * Upsert a named query: replace the existing entry with this name, else add
     * a new one. A "save as" over an existing name overwrites it.
     *
     * @param name - The query name (the upsert key).
     * @param sql - The SQL to store under that name.
     */
    save(name: string, sql: string): void {
        const list  = this._read();
        const saved: SavedQuery = { name, sql, savedAt: Date.now() };
        const index = list.findIndex(q => q.name === name);

        if (index >= 0) {
            list[index] = saved;
        } else {
            list.push(saved);
        }

        this._write(list);
    }

    /**
     * Remove the named query, if present.
     *
     * @param name - The query name to remove.
     */
    remove(name: string): void {
        this._write(this._read().filter(q => q.name !== name));
    }

    /**
     * @param name - The query name to look up.
     *
     * @returns The saved query, or `undefined` when no query has that name.
     */
    get(name: string): SavedQuery | undefined {
        return this._read().find(q => q.name === name);
    }

    /**
     * @returns The saved queries, sorted by name.
     */
    list(): SavedQuery[] {
        return this._read().sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Read the raw saved-query array from storage. */
    private _read(): SavedQuery[] {
        return readArray<SavedQuery>(this._storage, this._key);
    }

    /** Persist the saved-query array. */
    private _write(list: SavedQuery[]): void {
        this._storage.setItem(this._key, JSON.stringify(list));
    }
}
