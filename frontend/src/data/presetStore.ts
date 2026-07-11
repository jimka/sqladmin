// A thin domain wrapper over the library's WebStorageProxy for the user's own
// connection presets. Persists { name, host, port, database } ONLY — never any
// credential (those stay per-login, handled by the browser's own password
// manager). Backed by web storage under a single `sqladmin.*` key so the
// shell's "Clear SQL Admin data" and the localStorage inspector cover it for
// free. The proxy owns the normal read/write path; the raw Storage is touched
// only to discard a corrupt blob so a write can recover (see `_withRepair`).

import { Model, ModelRecord, WebStorageProxy } from "@jimka/typescript-ui/data";
import type { ConnectionPreset } from "../contract";

/** Web-storage key holding the preset array (flat — presets predate any connection). */
const PRESETS_KEY = "sqladmin.presets";

/** The preset record schema; primary key `name` drives upsert/remove matching. */
const PRESET_MODEL = new Model(
    [{ name: "name" }, { name: "host" }, { name: "port" }, { name: "database" }],
    "name",
);

/**
 * CRUD for the user's web-storage connection presets, over a WebStorageProxy.
 * All methods are async (the proxy returns promises); the login dialog awaits them.
 */
export class PresetStore {
    private readonly _proxy: WebStorageProxy;
    private readonly _storage: Storage;

    /**
     * @param backend - Which web storage to use; defaults to `localStorage`. A
     *   test stubs the corresponding global with a Map-backed stand-in.
     */
    constructor(backend: "local" | "session" = "local") {
        this._proxy   = new WebStorageProxy({ key: PRESETS_KEY, storage: backend });
        this._storage = backend === "session" ? sessionStorage : localStorage;
    }

    /**
     * All presets, name-sorted. Resolves to `[]` on a corrupt blob rather than
     * throwing — `WebStorageProxy.read()` runs `JSON.parse` synchronously, so
     * this uses `try/catch` around the call, not a `.catch()` chain (which would
     * never see the synchronous throw).
     */
    async list(): Promise<ConnectionPreset[]> {
        const rows = await this._readSafe();

        return [...rows].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Create or update a preset by name. Never carries a credential field. */
    async save(preset: ConnectionPreset): Promise<void> {
        const record = new ModelRecord(PRESET_MODEL, { ...preset });

        await this._withRepair(async () => {
            if ((await this._readSafe()).some(p => p.name === preset.name)) {
                await this._proxy.update(record);
            } else {
                await this._proxy.create(record);
            }
        });
    }

    /** Remove a preset by name (a no-op when it is absent). */
    async remove(name: string): Promise<void> {
        await this._withRepair(async () => {
            if (!(await this._readSafe()).some(p => p.name === name)) {
                return;
            }

            await this._proxy.destroy(new ModelRecord(PRESET_MODEL, { name }));
        });
    }

    /** Read guarded against a corrupt blob's synchronous `JSON.parse` throw. */
    private async _readSafe(): Promise<ConnectionPreset[]> {
        try {
            return (await this._proxy.read()) as ConnectionPreset[];
        } catch {
            return [];
        }
    }

    /**
     * Run a proxy write. WebStorageProxy's `create`/`update`/`destroy` re-parse
     * the blob and throw synchronously on a corrupt value, so if the first
     * attempt throws, discard the corrupt blob and retry once — the write then
     * proceeds against an empty array rather than crashing the caller.
     */
    private async _withRepair(write: () => Promise<void>): Promise<void> {
        try {
            await write();
        } catch {
            this._storage.removeItem(PRESETS_KEY);
            await write();
        }
    }
}
