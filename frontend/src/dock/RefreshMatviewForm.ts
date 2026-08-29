// The REFRESH MATERIALIZED VIEW form: CONCURRENTLY and WITH NO DATA toggles,
// mutually disabling each other since Postgres rejects the combination (see
// the view-matview-ddl plan's "Refresh form checkbox mutual-exclusion"
// note). Embedded as a `SqlPreviewDialog`'s `form` by the controller's
// `refreshMaterializedView` launcher — the preview text itself is the
// confirmation gate, so no bespoke confirm modal is needed (see
// plans/implemented/view-matview-ddl.md's "Drop/refresh reuse the same
// preview+confirm dialog" decision).

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox }             from "@jimka/typescript-ui/layout";
import { Checkbox }         from "@jimka/typescript-ui/component/input";

/**
 * The REFRESH form: CONCURRENTLY and WITH NO DATA toggles, mutually
 * disabling each other since Postgres rejects the combination.
 */
class RefreshMatviewForm extends Panel {
    private readonly _concurrentlyBox: Checkbox;
    private readonly _withNoDataBox: Checkbox;

    constructor() {
        const concurrentlyBox = Checkbox({ label: "CONCURRENTLY (requires a unique index)", selected: false });
        const withNoDataBox = Checkbox({ label: "WITH NO DATA (clear instead of repopulate)", selected: false });

        super({
            layoutManager: new VBox({ itemAlign: "stretch" }),
            components:    [concurrentlyBox, withNoDataBox],
        });

        this._concurrentlyBox = concurrentlyBox;
        this._withNoDataBox = withNoDataBox;

        // A cheap client guard, not a substitute for Postgres's own rejection:
        // hand-editing the preview text can still produce the illegal
        // combination, and Postgres remains authoritative at execute.
        concurrentlyBox.on("change", (checked: boolean) => this._withNoDataBox.setEnabled(!checked));
        withNoDataBox.on("change", (checked: boolean) => this._concurrentlyBox.setEnabled(!checked));
    }

    /** @returns whether CONCURRENTLY is checked. */
    concurrently(): boolean {
        return this._concurrentlyBox.getValue();
    }

    /** @returns whether WITH NO DATA is checked. */
    withNoData(): boolean {
        return this._withNoDataBox.getValue();
    }
}

const RefreshMatviewFormCallable = callable(RefreshMatviewForm);
type RefreshMatviewFormCallable = RefreshMatviewForm;
export { RefreshMatviewFormCallable as RefreshMatviewForm };
