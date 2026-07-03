// The client-side download trigger for the query-result export: wrap a string in
// a Blob and click a temporary <a download> anchor. Kept in its own DOM-bound
// module so serialize.ts stays pure and node-testable — the serializer returns a
// string, this module turns that string into a file the browser saves.
//
// This is manual-verify: node vitest has no DOM anchor to click, so the behaviour
// (a file named `filename` downloads with the given content and MIME type) is
// checked in the browser smoke test, not a unit test.

/**
 * Trigger a browser download of `content` as `filename` via a Blob + anchor.
 * Creates an object URL, clicks a hidden `<a download>`, then removes the anchor
 * and revokes the URL so no object URL or DOM node leaks.
 *
 * @param content - The file body (already serialized).
 * @param filename - The suggested download filename.
 * @param mimeType - The Blob's MIME type (e.g. "text/csv", "application/json").
 */
export function download(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href     = url;
    anchor.download = filename;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
}
