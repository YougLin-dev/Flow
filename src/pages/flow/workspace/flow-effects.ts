/** The reactive effects the page registers once, in its own owner scope. */
import { effect, untracked } from "nsh";
import type { CanvasCamera, FlowScene } from "../../../flow/canvas";
import type { CanvasMenuController } from "../../../flow/canvas/interaction/context-menu";
import { samePoint, sameRect, type BoxGeometry, type Point } from "../../../flow/shared";
import type { FlowWorkspace } from "./flow-workspace";

/** Publishes the selection count and opens or closes editors for a change. */
export function syncSelection(workspace: FlowWorkspace): void {
  const ids = workspace.scene.selection();
  const session = workspace.session();
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

/**
 * Dismisses an open menu when the camera moves, or when the card it targets
 * leaves the scene or changes rectangle: its screen anchor and its items
 * would otherwise point at something the user is no longer looking at. Call
 * it during the page's render, in the page's owner.
 */
export function dismissContextMenuOnChange(
  menu: CanvasMenuController,
  camera: CanvasCamera,
  scene: FlowScene,
): void {
  effect(() => {
    camera.view();
    untracked(() => menu.close());
  });

  // The rectangle the menu opened over; a re-anchored or freshly opened menu
  // starts a new baseline, and a change from it moves the card out from under
  // the menu.
  let anchor: { id: string; rect: BoxGeometry } | null = null;
  effect(() => {
    const id = menu.open()?.nodeId ?? null;
    if (id === null) {
      anchor = null;
      return;
    }
    const rect = scene.cardRect(id);
    if (rect === null) {
      anchor = null;
      untracked(() => menu.close());
      return;
    }
    if (anchor === null || anchor.id !== id) {
      anchor = { id, rect };
      return;
    }
    if (sameRect(anchor.rect, rect)) return;
    anchor = null;
    untracked(() => menu.close());
  });

  // The connector's endpoints when the menu opened over it; a connector that
  // left the scene, or a curve a card move pulled away, no longer sits under
  // the menu's anchor.
  let edgeAnchor: { id: string; from: Point; to: Point } | null = null;
  effect(() => {
    const id = menu.open()?.edgeId ?? null;
    if (id === null) {
      edgeAnchor = null;
      return;
    }
    const edge = scene.edges().find((candidate) => candidate.id === id) ?? null;
    const ports = edge === null ? null : scene.edgePorts(edge);
    if (ports === null) {
      edgeAnchor = null;
      untracked(() => menu.close());
      return;
    }
    if (edgeAnchor === null || edgeAnchor.id !== id) {
      edgeAnchor = { id, from: ports.from, to: ports.to };
      return;
    }
    if (samePoint(edgeAnchor.from, ports.from) && samePoint(edgeAnchor.to, ports.to)) return;
    edgeAnchor = null;
    untracked(() => menu.close());
  });
}
