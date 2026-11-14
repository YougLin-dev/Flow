/** The reactive effects the page registers once, in its own owner scope. */
import { untracked } from "nsh";
import { setSelectedCount } from "../../../store";
import type { FlowWorkspace } from "./flow-workspace";

/** Publishes the selection count and opens or closes editors for a change. */
export function syncSelection(workspace: FlowWorkspace): void {
  const ids = workspace.scene.selection();
  const session = workspace.session();
  setSelectedCount(ids.length);
  // Opening or closing a composer must not re-arm this effect: only a
  // selection change (or the session appearing) re-runs it.
  untracked(() => {
    if (ids.length === 1) {
      const id = ids[0];
      if (id === undefined) return;
      // A card selected by its own context menu shows the menu, not the
      // composer; an editor left from the previous selection still closes
      // and saves.
      if (workspace.canvasMenu.open()?.nodeId === id) {
        if (session !== null && session.inlineId() !== null) workspace.closeInlineDraft();
        if ((session?.composerId() ?? null) !== null) workspace.closeComposer();
        return;
      }
      workspace.openComposer(id);
      return;
    }
    if (session !== null && session.composerId() !== null) {
      workspace.composerState.save(session, session.detail());
      workspace.composerState.reset();
      session.closeComposer();
    }
  });
}

/** Loads the open node's detail into the composer draft settings. */
export function syncComposerState(workspace: FlowWorkspace): void {
  workspace.composerState.sync(workspace.session()?.detail() ?? null);
}
