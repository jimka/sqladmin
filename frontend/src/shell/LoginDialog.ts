// The login / connection flow: a mandatory (non-dismissable) modal that gates
// the shell behind authentication.
//
// It follows the app's dialog idiom (see SqlPreviewDialog): `await dialog.show()`
// resolves "confirm" when the user presses the primary "Sign in" button OR Enter
// (the Dialog resolves Enter to the primary action for free), and the entered
// values are read from the form AFTER the dialog closes. So there is no submit
// wiring — the footer button is a plain `{ result: "confirm" }`.
//
// The login attempt itself lives in `showLoginDialog`: it prompts, shows a
// spinner overlay while `login()` runs, and on failure shows an error dialog and
// then re-prompts with the previously-entered values restored. Presets live
// OUTSIDE the <form> (a <button>/combo inside a <form> would submit it) and carry
// host/port/database/username — the password stays a per-login field the
// browser fills. Preset entries are loaded (`LoginDialog.create`) before the
// dialog is constructed, so a default preset — and the field it should focus —
// is settled before the dialog's first paint rather than raced against it.

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
import { normalizeConnectionPreset } from "../contract";
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
    private defaultBtn?: Button;

    private constructor(
        private readonly config: AppConfig,
        private readonly store:  PresetStore,
        seed: LoginSeed,
        entries: PresetEntry[],
    ) {
        if (seed.details) this.form.setDetails(seed.details);

        this.picker = new ComboBox({ items: [BLANK_ITEM] });
        this.picker.on("change", (key: string) => this.onPresetSelected(key));

        const content = this.buildContent();

        this.setEntries(entries);

        // Auto-select the default preset on a fresh open only — a reopen
        // after a failed attempt restores the previously entered values
        // instead (`seed`), which takes priority over any default.
        const defaultKey   = seed.details ? undefined : this.findDefaultKey();
        const defaultEntry = defaultKey !== undefined ? this.byKey.get(defaultKey) : undefined;

        if (defaultKey !== undefined && defaultEntry) {
            this.picker.setValue(defaultKey);
            this.form.applyPreset(defaultEntry.preset);
        }

        this.updateDefaultButton();

        this.dialog = new Dialog({
            title:            "Connect to database",
            contentComponent: content,
            buttons:          [{ text: "Sign in", result: "confirm", glyph: "right-to-bracket", primary: true }],
            dismissable:      false,
            width:            DIALOG_WIDTH,
            // Host by default; the default preset's first unfilled field when
            // one was just auto-selected above. Set once, at construction —
            // `Dialog` reads `initialFocus` only from its own open-time
            // `focusFirst()`, so this must be settled before the dialog opens.
            initialFocus:     this.form.focusTarget(defaultEntry?.preset ?? null),
        });
    }

    /**
     * Build a dialog with its preset entries already loaded from server config
     * and (if allowed) the user's own store, so a default preset — and the
     * field it should focus — is known before the dialog is constructed.
     */
    static async create(config: AppConfig, store: PresetStore, seed: LoginSeed): Promise<LoginDialog> {
        return new LoginDialog(config, store, seed, await LoginDialog.loadEntries(config, store));
    }

    /** Show the dialog; resolves with the entered details once the user confirms. */
    async prompt(): Promise<LoginDetails> {
        await this.dialog.show(); // dismissable:false -> resolves only via Sign in / Enter

        return this.form.getDetails();
    }

    /** The dialog body: the preset controls (outside the form) above the form. */
    private buildContent(): Panel {
        const presetRows: LabeledRowDescriptor[] = [[{ title: "Preset", component: this.picker }]];

        if (this.config.allowUserPresets) {
            const save          = new Button({ text: "Save preset", compact: true });
            const remove        = new Button({ text: "Delete preset", compact: true });
            const toggleDefault = new Button({ text: "Set default", compact: true });

            save.on("action",          () => void this.savePreset());
            remove.on("action",        () => void this.deleteSelectedPreset());
            toggleDefault.on("action", () => void this.toggleDefaultForSelected());

            this.defaultBtn = toggleDefault;

            presetRows.push({
                component: new Panel({ layoutManager: HBox(), components: [save, remove, toggleDefault] }),
                fullWidth: true,
            });
        }

        return new Panel({
            layoutManager: VBox({ itemAlign: "stretch" }),
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
            this.form.focusTarget(entry.preset).focus();
        }

        this.updateDefaultButton();
    }

    /** Preset entries from server config and (if allowed) the user's own store. */
    private static async loadEntries(config: AppConfig, store: PresetStore): Promise<PresetEntry[]> {
        const userPresets = config.allowUserPresets ? await store.list() : [];

        return [
            ...config.presets.map(p => ({ preset: normalizeConnectionPreset(p), origin: "server" as const })),
            ...userPresets.map(p => ({ preset: p, origin: "user" as const })),
        ];
    }

    /** Populate `byKey` and the picker's items from a freshly loaded entry list. */
    private setEntries(entries: PresetEntry[]): void {
        this.byKey.clear();
        entries.forEach((entry, i) => this.byKey.set(String(i), entry));

        this.picker.setItems([
            BLANK_ITEM,
            ...entries.map((entry, i) => ({ key: String(i), label: presetLabel(entry) })),
        ]);
    }

    /** The key of the first entry (server presets take precedence) flagged `isDefault`. */
    private findDefaultKey(): string | undefined {
        for (const [key, entry] of this.byKey) {
            if (entry.preset.isDefault) return key;
        }

        return undefined;
    }

    private async refreshPresets(): Promise<void> {
        this.setEntries(await LoginDialog.loadEntries(this.config, this.store));
    }

    private async savePreset(): Promise<void> {
        const name = await promptQueryName("", { title: "Save preset", placeholder: "Preset name" });

        if (!name) {
            return;
        }

        const { host, port, database, username } = this.form.getDetails();

        // Resaving an existing default preset under its own name keeps it
        // default; saving under any other name never claims default on its own.
        const wasDefault = [...this.byKey.values()]
            .some(e => e.origin === "user" && e.preset.name === name && e.preset.isDefault === true);

        await this.store.save({ name, host, port, database, username, isDefault: wasDefault });
        await this.refreshPresets();

        // Select the just-saved preset so the picker reflects what was stored.
        this.selectUserPreset(name);
    }

    /** Select the user preset with the given name in the picker, if present,
     *  and sync the default-toggle button to its state. */
    private selectUserPreset(name: string): void {
        for (const [key, entry] of this.byKey) {
            if (entry.origin === "user" && entry.preset.name === name) {
                this.picker.setValue(key);
                this.updateDefaultButton();

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

    /** Toggle default status of the selected preset. User presets only —
     *  server presets are env-config-defined and not editable from this UI. */
    private async toggleDefaultForSelected(): Promise<void> {
        const entry = this.byKey.get(this.picker.getValue());

        if (!entry || entry.origin !== "user") {
            return;
        }

        await this.store.setDefault(entry.preset.isDefault ? null : entry.preset.name);
        await this.refreshPresets();
        this.selectUserPreset(entry.preset.name);
    }

    /** Sync the "Set default" button's label and enabled state to the current selection. */
    private updateDefaultButton(): void {
        if (!this.defaultBtn) {
            return;
        }

        const entry = this.byKey.get(this.picker.getValue());

        this.defaultBtn.setEnabled(entry?.origin === "user");
        this.defaultBtn.setText(entry?.preset.isDefault ? "Unset default" : "Set default");
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
        const dialog  = await LoginDialog.create(config, store, seed);
        const details = await dialog.prompt();

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
