// SqlAdminController's panel-teardown registry, split out of the controller so
// it can be unit-tested: SqlAdminController.ts's transitive imports touch
// `document` at module-load time, which the project's node-environment test
// runner has no stand-in for (see vitest.config.ts), and the load/close
// ordering below is the one part of that teardown with real branching.
//
// The registry stores the panel **object**, never a `panel.dispose` reference.
// The library's `Component.dispose` is a prototype method, so a detached
// reference loses its `this`; storing the object removes the choice. Only the
// app's composition wrappers (see COMPONENT_CONVENTIONS.md section (f)) declare
// `dispose` as a bound arrow field, and they satisfy this interface too.

/** The subset of a panel's API this registry calls on teardown. */
export interface DisposablePanel {
    dispose(): void;
}

export class PanelDisposers {
    // Panel id -> the panel to dispose when that tab closes.
    private readonly _panels: Map<string, DisposablePanel> = new Map();

    // Panel id -> the token minted for the build currently in flight for that
    // id. An id appears here only between beginLoad and settle/close.
    private readonly _loading: Map<string, object> = new Map();

    /**
     * Record a panel built synchronously, to dispose when its tab closes.
     *
     * @param id - The Dock panel id the panel is mounted under.
     * @param panel - The panel to dispose on close.
     */
    register(id: string, panel: DisposablePanel): void {
        this._panels.set(id, panel);
    }

    /**
     * Open a build window for a panel whose content is fetched asynchronously.
     *
     * @param id - The Dock panel id being opened.
     * @returns The token identifying this open; hand it back to `settle`.
     */
    beginLoad(id: string): object {
        const token = {};

        this._loading.set(id, token);

        return token;
    }

    /**
     * Finish an asynchronous build: register the panel when `token` is still
     * the current open for `id`, otherwise dispose it now — the tab it was
     * built for is gone, either closed or superseded by a newer open of the
     * same id.
     *
     * @param id - The Dock panel id the build was started for.
     * @param token - The token `beginLoad` returned for that build.
     * @param panel - The freshly built panel.
     */
    settle(id: string, token: object, panel: DisposablePanel): void {
        if (this._loading.get(id) !== token) {
            panel.dispose();

            return;
        }

        this._loading.delete(id);
        this.register(id, panel);
    }

    /**
     * A tab closed: dispose its registered panel (if any) and forget the id,
     * including any build still in flight for it.
     *
     * @param id - The closed Dock panel id.
     */
    close(id: string): void {
        const panel = this._panels.get(id);

        // Both entries are dropped before the dispose call, so a close
        // re-entered from teardown finds nothing left to dispose twice.
        this._loading.delete(id);
        this._panels.delete(id);

        panel?.dispose();
    }
}
