/** The page-level actions the key bindings and Escape path run. */
import type { FlowKeyActions } from "./bindings";
import type { FlowWorkspace } from "./flow-workspace";

/** The one action set the page binds with `bindFlowKeys`. */
export function flowKeyActions(workspace: FlowWorkspace): FlowKeyActions {
  return {
    setZoom: workspace.setZoom,
    fit: workspace.fit,
    deleteSelected: workspace.deleteSelected,
    undo: () => void workspace.undoRedo("undo"),
    redo: () => void workspace.undoRedo("redo"),
    panBy: workspace.panBy,
    toggleSearch: () => workspace.searchOpen.update((open) => !open),
    dismiss: () => dismissTopLayer(workspace),
  };
}

/** Escape closes the topmost layer: menu, search, editor, edge, composer, selection. */
function dismissTopLayer(workspace: FlowWorkspace): void {
  if (workspace.canvasMenu.close()) return;
  if (workspace.searchOpen()) {
    workspace.searchOpen.set(false);
    return;
  }
  const session = workspace.session();
  if (session?.inlineId()) {
    session.closeInline();
    return;
  }
  if (workspace.scene.selectedEdge() !== null) {
    workspace.selectEdge(null);
    return;
  }
  if ((session?.composerId() ?? null) !== null) {
    workspace.closeComposer();
    return;
  }
  workspace.scene.select([]);
}
