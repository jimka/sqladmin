// The start page's empty-workspace gating logic, split out from StartPage.ts
// so it can be unit-tested without pulling in the library's DOM-backed
// component classes (StartPage.ts's top-level imports touch `document` at
// module-load time, which the project's node-environment test runner has no
// stand-in for — see vitest.config.ts).

import type { QueryWorkspace } from "../controller/queryWorkspace";

/**
 * Whether the start page's welcome blurb should render — true only when the
 * workspace is truly empty (no recent tables and no saved queries), so the
 * blurb never shows alongside a populated Recent tables or Saved queries list.
 *
 * @param workspace - Supplies the recent-tables and saved-queries lists.
 *
 * @returns Whether to show the welcome blurb.
 */
export function shouldShowWelcome(workspace: Pick<QueryWorkspace, "recentTables" | "savedList">): boolean {
    return workspace.recentTables().length === 0 && workspace.savedList().length === 0;
}
