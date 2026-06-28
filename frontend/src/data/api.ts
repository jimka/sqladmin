// Introspection data path: a plain typed fetch client that reads the backend's
// error body ({detail}) directly and returns contract types. It does NOT go
// through the proxy/store (that is the row-CRUD path; see stores.ts).

import type { ColumnMeta, DbObjectRef } from "../contract";

/** Pull the backend's `{detail}` error message off a non-OK response. */
async function readDetail(response: Response): Promise<string> {
    try {
        const body = await response.json();

        if (body && typeof body.detail === "string") {
            return body.detail;
        }
    } catch {
        // Body was not JSON; fall through to the status line.
    }

    return `${response.status} ${response.statusText}`;
}

/** Fetch JSON from `url`, throwing the backend's detail message on failure. */
async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(await readDetail(response));
    }

    return (await response.json()) as T;
}

/** Introspect a table's columns (drives the Model + data grid). */
export function getColumns(ref: DbObjectRef): Promise<ColumnMeta[]> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/columns`;

    return getJson<ColumnMeta[]>(url);
}
