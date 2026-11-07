import type { Group, IEditorBase } from "@leafer-ui/miniapp";

/**
 * Keeps the editor's box on its targets after the camera moves.
 *
 * The box lives in the editor (sky) layer and is positioned from the selected
 * elements' world bounds. Panning or zooming changes those bounds without
 * changing the elements themselves, so Leafer does not refresh the box on its
 * own. Layout first: the editor reads cached bounds.
 */
export function refreshEditBox(editor: IEditorBase | null, world: Group | null): void {
  if (!editor?.editing) return;
  world?.updateLayout();
  // `updateEditBox` refreshes the simulated element a multi-selection box is
  // built from; plain `update` leaves that target at its old bounds.
  editor.updateEditBox();
}
