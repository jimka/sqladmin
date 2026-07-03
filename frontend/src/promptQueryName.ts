// A small async modal that asks the user to name a query before saving it,
// built on the library's Dialog (an in-app, styled overlay) rather than the
// browser's window.prompt. Shared by every "save this query" entry point — the
// query panel's toolbar Save button and the Queries view's Recent "Save…"
// action — so the naming UX is identical wherever a save starts.

import { Dialog, DialogButtons } from "@jimka/typescript-ui/overlay";
import { Panel }                 from "@jimka/typescript-ui/core";
import { Fit }                   from "@jimka/typescript-ui/layout";
import { TextField }             from "@jimka/typescript-ui/component/input";

// A comfortable width for a single-line name field — wide enough for a typical
// query name without the modal sprawling across the viewport.
const DIALOG_WIDTH = 360;

/**
 * Prompt (via an in-app Dialog) for a name to save a query under. Resolves to
 * the trimmed name, or `null` when the user cancels, dismisses, or leaves the
 * field blank — so a caller can treat `null` as "don't save".
 *
 * @param defaultName - Prefills the field (e.g. the existing name on a re-save).
 *
 * @returns The chosen name, or `null` to abandon the save.
 */
export async function promptQueryName(defaultName: string = ""): Promise<string | null> {
    const input = new TextField({ text: defaultName, placeholder: "Query name" });

    // Wrap the field in a Panel so it gets Panel's default inset (the Dialog's
    // content container adds none of its own, so a bare field sits flush).
    const content = Panel({ layoutManager: new Fit() });
    content.addComponent(input);

    const dialog = Dialog({
        title           : "Save query as",
        contentComponent: content,
        buttons         : [DialogButtons.Cancel, { ...DialogButtons.Confirm, primary: true }],
        width           : DIALOG_WIDTH,
        closeOnBackdrop : true,
    });

    // The library's Dialog binds Escape (dismiss) and Tab (focus trap) but not
    // Enter; wire Enter in the field to confirm so the modal submits like a form.
    input.on("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            dialog.hide("confirm");
        }
    });

    const shown = dialog.show();
    // focusFirst() lands on the title-bar close button; pull focus to the field
    // so the user can type the name immediately.
    input.focus();

    const result = await shown;

    if (result !== "confirm") {
        return null;
    }

    const name = input.getValue().trim();

    return name === "" ? null : name;
}
