// The login / connection flow: a mandatory (non-dismissable) modal that gates
// the shell behind authentication.
//
// It follows the app's dialog idiom (see FilterDialog): `await dialog.show()`
// resolves "confirm" when the user presses the primary "Sign in" button OR Enter
// (the Dialog resolves Enter to the primary action for free), and the entered
// values are read from the form AFTER the dialog closes. So there is no submit
// wiring — the footer button is a plain `{ result: "confirm" }`.
//
// The login attempt itself lives in `showLoginDialog`: it prompts, shows a
// spinner overlay while `login()` runs, and on failure shows an error dialog and
// then re-prompts with the previously-entered values restored. Presets live
// OUTSIDE the <form> (a <button>/combo inside a <form> would submit it) and carry
// host/port/database only — credentials stay per-login fields the browser fills.

import { Body, Panel }               from "@jimka/typescript-ui/core";
import { Dialog, Notification }      from "@jimka/typescript-ui/overlay";
import { HBox, VBox }                from "@jimka/typescript-ui/layout";
import { Button }                    from "@jimka/typescript-ui/component/button";
import { LabeledFieldSet }           from "@jimka/typescript-ui/component/container";
import type { LabeledRowDescriptor } from "@jimka/typescript-ui/component/container";
import { ComboBox }                  from "@jimka/typescript-ui/component/input";
import { ProgressSpinner, Glyph }    from "@jimka/typescript-ui/component/display";
import { right_to_bracket }          from "@jimka/typescript-ui/glyphs/solid/right_to_bracket";
import { getConfig, login }          from "../data/api";
import type { AppConfig, LoginDetails, Session } from "../data/api";
import { PresetStore }               from "../data/presetStore";
import type { ConnectionPreset }     from "../contract";
import { promptQueryName }           from "../promptQueryName";
import { LoginForm }                 from "./LoginForm";

Glyph.register(right_to_bracket);

// A comfortable modal width for the connection form.
const DIALOG_WIDTH = 380;

// The blank first picker entry ("type the fields yourself").
const BLANK_ITEM = { key: "", label: "— none —" };

/** A preset plus which source it came from (server presets are not deletable). */
interface PresetEntry {
    preset: ConnectionPreset;
    origin: "server" | "user";
}

/** State carried from a failed attempt into the reopened dialog. */
interface LoginSeed {
    details?: LoginDetails;
}

/** The picker label for an entry (server presets are marked, since they can't be deleted). */
function presetLabel(entry: PresetEntry): string {
    return entry.origin === "server" ? `${entry.preset.name} (server)` : entry.preset.name;
}

/**
 * One presentation of the connection dialog: build it, `prompt()` for the
 * entered details. A mandatory modal (dismissable: false), so the only way out
 * is the "Sign in" button / Enter.
 */
class LoginDialog {
    private readonly form = new LoginForm();
    private readonly picker: ComboBox;
    private readonly dialog: Dialog;
    private readonly byKey = new Map<string, PresetEntry>();

    constructor(
        private readonly config: AppConfig,
        private readonly store:  PresetStore,
        seed: LoginSeed,
    ) {
        if (seed.details) this.form.setDetails(seed.details);

        this.picker = new ComboBox({ items: [BLANK_ITEM] });
        this.picker.on("change", (key: string) => this.onPresetSelected(key));

        this.dialog = new Dialog({
            title:            "Connect to database",
            contentComponent: this.buildContent(),
            buttons:          [{ text: "Sign in", result: "confirm", glyph: "right-to-bracket", primary: true }],
            dismissable:      false,
            width:            DIALOG_WIDTH,
        });
    }

    /** Show the dialog; resolves with the entered details once the user confirms. */
    async prompt(): Promise<LoginDetails> {
        void this.refreshPresets();
        await this.dialog.show(); // dismissable:false -> resolves only via Sign in / Enter

        return this.form.getDetails();
    }

    /** The dialog body: the preset controls (outside the form) above the form. */
    private buildContent(): Panel {
        const presetRows: LabeledRowDescriptor[] = [[{ title: "Preset", component: this.picker }]];

        if (this.config.allowUserPresets) {
            const save   = new Button({ text: "Save preset", compact: true });
            const remove = new Button({ text: "Delete preset", compact: true });

            save.on("action", () => void this.savePreset());
            remove.on("action", () => void this.deleteSelectedPreset());

            presetRows.push({
                component: new Panel({ layoutManager: HBox(), components: [save, remove] }),
                fullWidth: true,
            });
        }

        return new Panel({
            layoutManager: VBox({ stretching: true }),
            components: [
                new LabeledFieldSet("Saved connections", { rows: presetRows }),
                this.form,
            ],
        });
    }

    private onPresetSelected(key: string): void {
        const entry = this.byKey.get(key);

        if (entry) {
            this.form.applyPreset(entry.preset);
        }
    }

    private async refreshPresets(): Promise<void> {
        const userPresets = this.config.allowUserPresets ? await this.store.list() : [];

        const entries: PresetEntry[] = [
            ...this.config.presets.map(p => ({ preset: p, origin: "server" as const })),
            ...userPresets.map(p => ({ preset: p, origin: "user" as const })),
        ];

        this.byKey.clear();
        entries.forEach((entry, i) => this.byKey.set(String(i), entry));

        this.picker.setItems([
            BLANK_ITEM,
            ...entries.map((entry, i) => ({ key: String(i), label: presetLabel(entry) })),
        ]);
    }

    private async savePreset(): Promise<void> {
        const name = await promptQueryName("");

        if (!name) {
            return;
        }

        const { host, port, database } = this.form.getDetails();

        await this.store.save({ name, host, port, database });
        await this.refreshPresets();

        // Select the just-saved preset so the picker reflects what was stored.
        this.selectUserPreset(name);
    }

    /** Select the user preset with the given name in the picker, if present. */
    private selectUserPreset(name: string): void {
        for (const [key, entry] of this.byKey) {
            if (entry.origin === "user" && entry.preset.name === name) {
                this.picker.setValue(key);

                return;
            }
        }
    }

    private async deleteSelectedPreset(): Promise<void> {
        const entry = this.byKey.get(this.picker.getValue());

        if (entry && entry.origin === "user") {
            await this.store.remove(entry.preset.name);
            await this.refreshPresets();
        }
    }
}

/** Run `work` under a full-app spinner overlay (the "signing in…" throbber). */
async function withSpinner<T>(work: () => Promise<T>): Promise<T> {
    const spinner = new ProgressSpinner();
    spinner.showOverlay(Body.getInstance());

    try {
        return await work();
    } finally {
        spinner.hideOverlay();
    }
}

/**
 * Prompt for connection details and authenticate, resolving with the session.
 * Loops until a login succeeds: each failed attempt shows an error dialog and,
 * once acknowledged, re-prompts with the previously-entered values restored.
 */
export async function showLoginDialog(): Promise<Session> {
    const config = await getConfig().catch((): AppConfig => ({ presets: [], allowUserPresets: true }));
    const store  = new PresetStore();
    let seed: LoginSeed = {};

    for (;;) {
        const details = await new LoginDialog(config, store, seed).prompt();

        try {
            const session = await withSpinner(() => login(details));

            Notification.show(`Connected to ${details.database}`, "success");

            return session;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Report the failure in its own error dialog; once the user presses
            // OK, reopen the login dialog with the entered values restored.
            await Dialog.error("Connection failed", message);
            seed = { details };
        }
    }
}
