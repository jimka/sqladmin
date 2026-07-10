// The login / connection dialog: a non-dismissable modal that authenticates the
// user against the target Postgres server. Its content is a real semantic
// `<form>` (the `{ tag: "form" }` Component option) so the browser's password
// manager recognises the credentials; the credential inputs are the library's
// UsernameField / PasswordField, which already carry the right autocomplete/name
// attributes. Login is driven off the form's native `submit` event (Enter or the
// in-form Sign in button), NOT the Dialog's footer buttons (which render outside
// the form and would not fire a submit the password manager hooks).
//
// A preset picker fills host/port/database from a saved target. Presets carry
// host/port/database ONLY — username/password stay per-login fields. Server
// presets come from the pre-auth `/api/config`; the user's own presets live in
// localStorage and are shown/editable only when the backend allows them.

import { Event, Panel }              from "@jimka/typescript-ui/core";
import { Dialog }                    from "@jimka/typescript-ui/overlay";
import { VBox }                      from "@jimka/typescript-ui/layout";
import { Button }                    from "@jimka/typescript-ui/component/button";
import {
    ComboBox, PasswordField, Text, TextField, UsernameField,
} from "@jimka/typescript-ui/component/input";
import { getConfig, login }          from "../data/api";
import type { AppConfig, Session }   from "../data/api";
import { PresetStore }               from "../data/presetStore";
import type { ConnectionPreset }     from "../contract";
import { promptQueryName }           from "../promptQueryName";

// A comfortable modal width for the connection form.
const DIALOG_WIDTH = 380;

// The blank first picker entry ("type the fields yourself").
const NO_PRESET = "— none —";

/** A preset plus which source it came from (server presets are not deletable). */
interface PresetEntry {
    preset: ConnectionPreset;
    origin: "server" | "user";
}

/** The picker label for an entry, disambiguated by origin. */
function entryLabel(entry: PresetEntry): string {
    return entry.origin === "server" ? `Server · ${entry.preset.name}` : `Mine · ${entry.preset.name}`;
}

/**
 * Show the login dialog and resolve once the user authenticates. Never rejects:
 * a failed login is shown inline and the dialog stays open until a login
 * succeeds (the shell is gated behind this).
 */
export async function showLoginDialog(): Promise<Session> {
    const config: AppConfig = await getConfig().catch(
        () => ({ presets: [], allowUserPresets: true }),
    );
    const store = new PresetStore();

    return new Promise<Session>((resolve) => {
        let entries: PresetEntry[] = [];

        // --- fields (credential inputs carry autocomplete/name from the lib) ---
        const picker       = new ComboBox({ items: [NO_PRESET] });
        const hostField    = new TextField({ text: "localhost", placeholder: "Host" });
        const portField    = new TextField({ text: "5432", placeholder: "Port" });
        const dbField      = new TextField({ placeholder: "Database" });
        const userField    = new UsernameField();
        const passField    = new PasswordField();
        const errorText    = new Text("");

        // The submit control MUST live inside the form: a <button> with no
        // explicit type defaults to type="submit", so Enter and a click both
        // fire the form's native submit.
        const signInButton = new Panel({ tag: "button" });
        signInButton.addComponent(new Text("Sign in"));

        // --- the semantic form container ---
        const form = new Panel({ tag: "form", layoutManager: new VBox() });
        form.addComponent(picker);
        form.addComponent(hostField);
        form.addComponent(portField);
        form.addComponent(dbField);
        form.addComponent(userField);
        form.addComponent(passField);

        // Preset management is shown only when the backend permits user presets.
        if (config.allowUserPresets) {
            const saveButton   = new Button({ text: "Save preset", showText: true, compact: true, flat: true });
            const deleteButton = new Button({ text: "Delete preset", showText: true, compact: true, flat: true });

            saveButton.on("action", () => void savePreset());
            deleteButton.on("action", () => void deleteSelectedPreset());

            const presetBar = new Panel({ layoutManager: new VBox() });
            presetBar.addComponent(saveButton);
            presetBar.addComponent(deleteButton);
            form.addComponent(presetBar);
        }

        form.addComponent(errorText);
        form.addComponent(signInButton);

        const dialog = Dialog({
            title:            "Connect to database",
            contentComponent: form,
            buttons:          [],       // no footer button — submit lives in the form
            closeOnBackdrop:  false,
            width:            DIALOG_WIDTH,
        });

        // Drive login off the native form submit via the library event API.
        Event.addListener(form, "submit", (e: SubmitEvent) => {
            e.preventDefault();
            void attemptLogin();
        });

        // Fill host/port/database when a preset is picked (credentials stay blank).
        picker.on("change", (value: string) => {
            const entry = entries.find(en => entryLabel(en) === value);

            if (entry) {
                hostField.setText(entry.preset.host);
                portField.setText(String(entry.preset.port));
                dbField.setText(entry.preset.database);
            }
        });

        void refreshPicker();
        void dialog.show();

        // --- helpers -----------------------------------------------------

        async function refreshPicker(): Promise<void> {
            const userPresets = config.allowUserPresets ? await store.list() : [];

            entries = [
                ...config.presets.map(p => ({ preset: p, origin: "server" as const })),
                ...userPresets.map(p => ({ preset: p, origin: "user" as const })),
            ];

            picker.setItems([NO_PRESET, ...entries.map(entryLabel)]);
        }

        async function attemptLogin(): Promise<void> {
            errorText.setText("");

            try {
                const session = await login({
                    host:     hostField.getValue().trim(),
                    port:     Number(portField.getValue().trim()),
                    database: dbField.getValue().trim(),
                    username: userField.getValue(),
                    password: passField.getValue(),
                });

                dialog.hide("close");
                resolve(session);
            } catch (err) {
                errorText.setText(err instanceof Error ? err.message : String(err));
            }
        }

        async function savePreset(): Promise<void> {
            const name = await promptQueryName("");

            if (!name) {
                return;
            }

            await store.save({
                name,
                host:     hostField.getValue().trim(),
                port:     Number(portField.getValue().trim()),
                database: dbField.getValue().trim(),
            });
            await refreshPicker();
        }

        async function deleteSelectedPreset(): Promise<void> {
            const entry = entries.find(en => entryLabel(en) === picker.getValue());

            // Only the user's own presets are deletable — never a server preset.
            if (entry && entry.origin === "user") {
                await store.remove(entry.preset.name);
                await refreshPicker();
            }
        }
    });
}
