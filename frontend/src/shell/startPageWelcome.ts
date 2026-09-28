// The start page's empty-workspace gating logic, split out from StartPage.ts
// so node vitest can unit-test it: StartPage constructs library components,
// which need a DOM, and this function needs none.

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
