// A thin domain wrapper over the library's WebStorageProxy for the user's own
// connection presets. Persists { name, host, port, database } ONLY — never any
// credential (those stay per-login, handled by the browser's own password
// manager). Backed by localStorage under a single `sqladmin.*` key so the
// shell's "Clear SQL Admin data" and the localStorage inspector cover it for
// free. The proxy owns the storage blob — this never touches the raw Storage API.

import { Model, ModelRecord, WebStorageProxy } from "@jimka/typescript-ui/data";
import type { ConnectionPreset } from "../contract";

/** localStorage key holding the preset array (flat — presets predate any connection). */
const PRESETS_KEY = "sqladmin.presets";

/** The preset record schema; primary key `name` drives upsert/remove matching. */
const PRESET_MODEL = new Model(
    [{ name: "name" }, { name: "host" }, { name: "port" }, { name: "database" }],
    "name",
);

/**
 * CRUD for the user's localStorage connection presets, over a WebStorageProxy.
 * All methods are async (the proxy returns promises); the login dialog awaits them.
 */
export class PresetStore {
    private readonly _proxy: WebStorageProxy;

    /**
     * @param proxy - Optional injected proxy (a test binds one to a stubbed
     *   Storage); defaults to a localStorage-backed proxy under `sqladmin.presets`.
     */
    constructor(proxy?: WebStorageProxy) {
        this._proxy = proxy ?? new WebStorageProxy({ key: PRESETS_KEY, storage: "local" });
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

        if ((await this._readSafe()).some(p => p.name === preset.name)) {
            await this._proxy.update(record);
        } else {
            await this._proxy.create(record);
        }
    }

    /** Remove a preset by name (a no-op when it is absent). */
    async remove(name: string): Promise<void> {
        if (!(await this._readSafe()).some(p => p.name === name)) {
            return;
        }

        await this._proxy.destroy(new ModelRecord(PRESET_MODEL, { name }));
    }

    /** Read guarded against a corrupt blob's synchronous `JSON.parse` throw. */
    private async _readSafe(): Promise<ConnectionPreset[]> {
        try {
            return (await this._proxy.read()) as ConnectionPreset[];
        } catch {
            return [];
        }
    }
}
