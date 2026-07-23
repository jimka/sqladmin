// A reusable connection + credential form: the fields a user fills to
// authenticate against a Postgres server, in a semantic <form> so the browser
// can group and autofill the credentials. It has no submit button of its own —
// submission is driven by the host dialog (the Dialog's primary button / Enter
// resolves the flow) — and exposes typed read / prefill / preset helpers so a
// host drives it without reaching into the fields. A failed attempt is reported
// by the host in a separate error dialog, not inline here.

import { Form, callable } from "@jimka/typescript-ui/core";
import { VBox }            from "@jimka/typescript-ui/layout";
import { LabeledFieldSet } from "@jimka/typescript-ui/component/container";
import { PasswordField, TextField, UsernameField } from "@jimka/typescript-ui/component/input";
import type { LoginDetails }     from "../data/api";
import type { ConnectionPreset } from "../contract";

/** The connection + credential form, as a reusable `<form>` component. */
class LoginForm extends Form {
    private readonly host:     TextField;
    private readonly port:     TextField;
    private readonly database: TextField;
    private readonly username: UsernameField;
    private readonly password: PasswordField;

    constructor() {
        // Build the fields as locals first — `this` is unavailable until after
        // `super()`, which needs them as its children.
        const host     = new TextField({ text: "localhost", placeholder: "Host" });
        const port     = new TextField({ text: "5432", placeholder: "Port" });
        const database = new TextField({ placeholder: "Database" });
        const username = new UsernameField();
        const password = new PasswordField();

        super({
            layoutManager: VBox({ stretching: true }),
            components: [
                new LabeledFieldSet("Connection", {
                    rows: [
                        [{ title: "Host", component: host }],
                        [{ title: "Port", component: port }],
                        [{ title: "Database", component: database }],
                    ],
                }),
                new LabeledFieldSet("Credentials", {
                    rows: [
                        [{ title: "Username", component: username }],
                        [{ title: "Password", component: password }],
                    ],
                }),
            ],
        });

        this.host     = host;
        this.port     = port;
        this.database = database;
        this.username = username;
        this.password = password;
    }

    /** The typed connection details entered (the connectionId defaults server-side). */
    getDetails(): LoginDetails {
        return {
            host:     this.host.getValue().trim(),
            port:     Number(this.port.getValue().trim()),
            database: this.database.getValue().trim(),
            username: this.username.getValue(),
            password: this.password.getValue(),
        };
    }

    /** Prefill fields — e.g. to restore a failed attempt's values when reopened. */
    setDetails(details: Partial<LoginDetails>): void {
        if (details.host     !== undefined) this.host.setText(details.host);
        if (details.port     !== undefined) this.port.setText(String(details.port));
        if (details.database !== undefined) this.database.setText(details.database);
        if (details.username !== undefined) this.username.setText(details.username);
        if (details.password !== undefined) this.password.setText(details.password);
    }

    /** Fill the connection fields from a preset (credentials are left untouched). */
    applyPreset(preset: ConnectionPreset): void {
        this.host.setText(preset.host);
        this.port.setText(String(preset.port));
        this.database.setText(preset.database);
    }
}

const LoginFormCallable = callable(LoginForm);
type LoginFormCallable = LoginForm;
export { LoginFormCallable as LoginForm };
